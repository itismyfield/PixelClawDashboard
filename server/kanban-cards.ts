import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { buildDispatchPayload, formatInstructionsFromInput } from "./dispatch-input.js";
import { PCD_HANDOFF_DIR, ensurePcdRuntimeDirs } from "./runtime-paths.js";
import { broadcast } from "./ws.js";

export const KANBAN_CARD_STATUSES = [
  "backlog",
  "ready",
  "requested",
  "in_progress",
  "review",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

export const KANBAN_CARD_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const REQUEST_ACK_TIMEOUT_MS = 45 * 60 * 1000;
export const IN_PROGRESS_STALE_MS = 8 * 60 * 60 * 1000;

export type KanbanCardStatus = (typeof KANBAN_CARD_STATUSES)[number];
export type KanbanCardPriority = (typeof KANBAN_CARD_PRIORITIES)[number];
export type TaskDispatchStatus =
  | "pending"
  | "dispatched"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface KanbanReviewChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

export interface KanbanCardMetadata {
  retry_count?: number;
  failover_count?: number;
  timed_out_stage?: "requested" | "in_progress";
  timed_out_at?: number;
  timed_out_reason?: string;
  review_checklist?: KanbanReviewChecklistItem[];
  reward?: {
    granted_at: number;
    agent_id: string;
    xp: number;
    tasks_done: number;
  };
}

interface KanbanCardBaseRow {
  id: string;
  title: string;
  description: string | null;
  status: KanbanCardStatus;
  github_repo: string | null;
  owner_agent_id: string | null;
  requester_agent_id: string | null;
  assignee_agent_id: string | null;
  parent_card_id: string | null;
  latest_dispatch_id: string | null;
  sort_order: number;
  priority: KanbanCardPriority;
  depth: number;
  blocked_reason: string | null;
  review_notes: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  requested_at: number | null;
  completed_at: number | null;
}

interface TaskDispatchRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  dispatch_type: string;
  status: TaskDispatchStatus;
  title: string;
  context_file: string | null;
  result_file: string | null;
  result_summary: string | null;
  parent_dispatch_id: string | null;
  chain_depth: number;
  created_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
}

// Token rewards per priority (1 XP = 1000 tokens)
const PRIORITY_TOKEN_REWARD: Record<KanbanCardPriority, number> = {
  low: 5000,
  medium: 10000,
  high: 18000,
  urgent: 30000,
};

export interface KanbanCardRow extends KanbanCardBaseRow {
  latest_dispatch_status: TaskDispatchStatus | null;
  latest_dispatch_title: string | null;
  latest_dispatch_type: string | null;
  latest_dispatch_result_summary: string | null;
  latest_dispatch_chain_depth: number | null;
  child_count: number;
}

const KANBAN_CARD_SELECT = `
  SELECT
    kc.*,
    td.status AS latest_dispatch_status,
    td.title AS latest_dispatch_title,
    td.dispatch_type AS latest_dispatch_type,
    td.result_summary AS latest_dispatch_result_summary,
    td.chain_depth AS latest_dispatch_chain_depth,
    (
      SELECT COUNT(*)
      FROM kanban_cards child
      WHERE child.parent_card_id = kc.id
    ) AS child_count
  FROM kanban_cards kc
  LEFT JOIN task_dispatches td ON td.id = kc.latest_dispatch_id
`;

export function listKanbanCards(
  db: DatabaseSync,
  filters?: {
    status?: string | null;
    github_repo?: string | null;
    assignee_agent_id?: string | null;
    requester_agent_id?: string | null;
    limit?: number;
  },
): KanbanCardRow[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filters?.status) {
    conditions.push("kc.status = ?");
    params.push(filters.status);
  }
  if (filters?.github_repo) {
    conditions.push("kc.github_repo = ?");
    params.push(filters.github_repo);
  }
  if (filters?.assignee_agent_id) {
    conditions.push("kc.assignee_agent_id = ?");
    params.push(filters.assignee_agent_id);
  }
  if (filters?.requester_agent_id) {
    conditions.push("kc.requester_agent_id = ?");
    params.push(filters.requester_agent_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Number(filters?.limit ?? 500), 1), 1000);

  return db.prepare(
    `${KANBAN_CARD_SELECT}
     ${where}
     ORDER BY kc.status, kc.sort_order, kc.updated_at DESC
     LIMIT ?`,
  ).all(...params, limit) as unknown as KanbanCardRow[];
}

export function getKanbanCardById(db: DatabaseSync, id: string): KanbanCardRow | undefined {
  return db.prepare(
    `${KANBAN_CARD_SELECT}
     WHERE kc.id = ?
     LIMIT 1`,
  ).get(id) as KanbanCardRow | undefined;
}

export function getRawKanbanCardById(db: DatabaseSync, id: string): KanbanCardBaseRow | undefined {
  return db.prepare(
    `SELECT *
     FROM kanban_cards
     WHERE id = ?
     LIMIT 1`,
  ).get(id) as KanbanCardBaseRow | undefined;
}

function getTaskDispatchById(db: DatabaseSync, id: string): TaskDispatchRow | undefined {
  return db.prepare(
    `SELECT *
     FROM task_dispatches
     WHERE id = ?
     LIMIT 1`,
  ).get(id) as TaskDispatchRow | undefined;
}

function normalizeDispatchParticipantAgentId(
  db: DatabaseSync,
  agentId: string | null | undefined,
): string | null {
  if (!agentId) {
    return null;
  }

  // task_dispatches may point to non-agent participants, but kanban_cards keeps agent FKs.
  const row = db.prepare(
    `SELECT id
     FROM agents
     WHERE id = ?
     LIMIT 1`,
  ).get(agentId) as { id: string } | undefined;
  return row?.id ?? null;
}

function getMaxSortOrder(db: DatabaseSync, status: KanbanCardStatus, excludingCardId?: string): number {
  const row = excludingCardId
    ? db.prepare(
      `SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order
       FROM kanban_cards
       WHERE status = ? AND id != ?`,
    ).get(status, excludingCardId) as { max_sort_order: number }
    : db.prepare(
      `SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order
       FROM kanban_cards
       WHERE status = ?`,
    ).get(status) as { max_sort_order: number };
  return Number(row.max_sort_order || 0);
}

export function calculateSortOrder(
  db: DatabaseSync,
  status: KanbanCardStatus,
  beforeCardId?: string | null,
  excludingCardId?: string,
): number {
  if (!beforeCardId) {
    return getMaxSortOrder(db, status, excludingCardId) + 1024;
  }

  const target = db.prepare(
    `SELECT id, status, sort_order
     FROM kanban_cards
     WHERE id = ?
     LIMIT 1`,
  ).get(beforeCardId) as { id: string; status: KanbanCardStatus; sort_order: number } | undefined;

  if (!target) {
    return getMaxSortOrder(db, status, excludingCardId) + 1024;
  }

  const targetStatus = target.status;
  const effectiveStatus = targetStatus === status ? status : targetStatus;
  const previous = excludingCardId
    ? db.prepare(
      `SELECT sort_order
       FROM kanban_cards
       WHERE status = ?
         AND id != ?
         AND id != ?
         AND sort_order < ?
       ORDER BY sort_order DESC
       LIMIT 1`,
    ).get(effectiveStatus, target.id, excludingCardId, target.sort_order) as { sort_order: number } | undefined
    : db.prepare(
      `SELECT sort_order
       FROM kanban_cards
       WHERE status = ?
         AND id != ?
         AND sort_order < ?
       ORDER BY sort_order DESC
       LIMIT 1`,
    ).get(effectiveStatus, target.id, target.sort_order) as { sort_order: number } | undefined;

  if (!previous) {
    return target.sort_order - 1024;
  }

  return (Number(previous.sort_order) + Number(target.sort_order)) / 2;
}

function mapDispatchStatusToCardStatus(
  dispatchStatus: TaskDispatchStatus,
  currentStatus: KanbanCardStatus,
): KanbanCardStatus {
  switch (dispatchStatus) {
    case "pending":
    case "dispatched":
      if (["in_progress", "review", "done", "failed", "cancelled"].includes(currentStatus)) {
        return currentStatus;
      }
      return "requested";
    case "in_progress":
      if (["review", "done", "failed", "cancelled"].includes(currentStatus)) {
        return currentStatus;
      }
      return "in_progress";
    case "completed":
      return currentStatus === "done" ? "done" : "review";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function normalizeChecklistItem(value: unknown, index: number): KanbanReviewChecklistItem | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `item-${index + 1}`;
  return {
    id,
    label,
    done: raw.done === true,
  };
}

export function parseKanbanCardMetadata(value: string | null | undefined): KanbanCardMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const reviewChecklist = Array.isArray(parsed.review_checklist)
      ? parsed.review_checklist
        .map((item, index) => normalizeChecklistItem(item, index))
        .filter((item): item is KanbanReviewChecklistItem => Boolean(item))
      : undefined;
    const reward = parsed.reward && typeof parsed.reward === "object"
      ? parsed.reward as KanbanCardMetadata["reward"]
      : undefined;
    return {
      retry_count: typeof parsed.retry_count === "number" ? Math.max(0, Math.trunc(parsed.retry_count)) : undefined,
      failover_count: typeof parsed.failover_count === "number" ? Math.max(0, Math.trunc(parsed.failover_count)) : undefined,
      timed_out_stage: parsed.timed_out_stage === "requested" || parsed.timed_out_stage === "in_progress"
        ? parsed.timed_out_stage
        : undefined,
      timed_out_at: typeof parsed.timed_out_at === "number" ? parsed.timed_out_at : undefined,
      timed_out_reason: typeof parsed.timed_out_reason === "string" ? parsed.timed_out_reason : undefined,
      review_checklist: reviewChecklist,
      reward,
    };
  } catch {
    return {};
  }
}

export function stringifyKanbanCardMetadata(metadata: KanbanCardMetadata): string | null {
  const payload: KanbanCardMetadata = {};
  if (metadata.retry_count && metadata.retry_count > 0) payload.retry_count = metadata.retry_count;
  if (metadata.failover_count && metadata.failover_count > 0) payload.failover_count = metadata.failover_count;
  if (metadata.timed_out_stage) payload.timed_out_stage = metadata.timed_out_stage;
  if (metadata.timed_out_at) payload.timed_out_at = metadata.timed_out_at;
  if (metadata.timed_out_reason) payload.timed_out_reason = metadata.timed_out_reason;
  if (metadata.review_checklist && metadata.review_checklist.length > 0) {
    payload.review_checklist = metadata.review_checklist
      .map((item, index) => normalizeChecklistItem(item, index))
      .filter((item): item is KanbanReviewChecklistItem => Boolean(item));
  }
  if (metadata.reward) payload.reward = metadata.reward;
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;
}

function setCardMetadata(
  db: DatabaseSync,
  cardId: string,
  mutate: (current: KanbanCardMetadata) => KanbanCardMetadata,
): void {
  const row = getRawKanbanCardById(db, cardId);
  if (!row) return;
  const next = mutate(parseKanbanCardMetadata(row.metadata_json));
  db.prepare(
    `UPDATE kanban_cards
     SET metadata_json = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(stringifyKanbanCardMetadata(next), Date.now(), cardId);
}

export function emitKanbanCard(
  db: DatabaseSync,
  id: string,
  type: "kanban_card_created" | "kanban_card_updated",
): KanbanCardRow | undefined {
  const card = getKanbanCardById(db, id);
  if (card) {
    broadcast(type, card);
  }
  return card;
}

export function emitKanbanCardDeleted(id: string): void {
  broadcast("kanban_card_deleted", { id });
}

export function createDispatchForKanbanCard(db: DatabaseSync, cardId: string): KanbanCardRow {
  const card = getRawKanbanCardById(db, cardId);
  if (!card) {
    throw new Error("kanban_card_not_found");
  }
  const requesterAgentId = card.requester_agent_id ?? card.assignee_agent_id;
  if (!requesterAgentId || !card.assignee_agent_id) {
    throw new Error("assignee_agent_id is required to request a dispatch");
  }

  ensurePcdRuntimeDirs();

  const dispatchId = crypto.randomUUID();
  const parentDispatchId = card.parent_card_id
    ? (db.prepare(
      `SELECT latest_dispatch_id
       FROM kanban_cards
       WHERE id = ?
       LIMIT 1`,
    ).get(card.parent_card_id) as { latest_dispatch_id: string | null } | undefined)?.latest_dispatch_id ?? null
    : null;
  const now = Date.now();
  const fileName = `${now}-${dispatchId}.json`;
  const filePath = path.join(PCD_HANDOFF_DIR, fileName);

  const payload = buildDispatchPayload({
    title: card.title,
    description: card.description,
    github_issue_url: card.github_issue_url,
    github_repo: card.github_repo,
    github_issue_number: card.github_issue_number,
  });

  const handoff = {
    dispatch_id: dispatchId,
    from: requesterAgentId,
    to: card.assignee_agent_id,
    type: "generic",
    title: card.title,
    parent_dispatch_id: parentDispatchId,
    context: {
      summary: payload.input.intent || undefined,
      repo_path: process.cwd(),
    },
    instructions: formatInstructionsFromInput(payload.input),
    structured_input: {
      intent: payload.input.intent,
      checklist: payload.input.checklist,
      issue_url: payload.input.issue_url,
      truncated: payload.input.truncated,
      fallback_reason: payload.input.fallback_reason,
    },
  };

  // Insert dispatch row BEFORE updating kanban card to satisfy FK constraint
  const chainDepth = parentDispatchId
    ? ((db.prepare("SELECT chain_depth FROM task_dispatches WHERE id = ? LIMIT 1").get(parentDispatchId) as { chain_depth: number } | undefined)?.chain_depth ?? 0) + 1
    : 0;
  db.prepare(
    `INSERT INTO task_dispatches (id, from_agent_id, to_agent_id, dispatch_type, status, title, context_file, parent_dispatch_id, chain_depth, created_at, dispatched_at)
     VALUES (?, ?, ?, 'generic', 'pending', ?, NULL, ?, ?, ?, NULL)`,
  ).run(dispatchId, requesterAgentId, card.assignee_agent_id, card.title, parentDispatchId, chainDepth, now);

  fs.writeFileSync(filePath, JSON.stringify(handoff, null, 2));

  db.prepare(
    `UPDATE kanban_cards
     SET status = 'requested',
         requester_agent_id = COALESCE(requester_agent_id, assignee_agent_id),
         latest_dispatch_id = ?,
         requested_at = ?,
         started_at = NULL,
         completed_at = NULL,
         updated_at = ?
     WHERE id = ?`,
  ).run(dispatchId, now, now, cardId);

  const updated = emitKanbanCard(db, cardId, "kanban_card_updated");
  if (!updated) {
    throw new Error("kanban_card_not_found");
  }
  return updated;
}

function checklistIncomplete(metadata: KanbanCardMetadata): boolean {
  return Boolean(metadata.review_checklist?.some((item) => !item.done));
}

export function kanbanCardHasIncompleteReviewChecklist(card: KanbanCardBaseRow): boolean {
  return checklistIncomplete(parseKanbanCardMetadata(card.metadata_json));
}

export function rewardKanbanCompletion(db: DatabaseSync, cardId: string): KanbanCardRow | undefined {
  const card = getRawKanbanCardById(db, cardId);
  if (!card || card.status !== "done" || !card.assignee_agent_id) {
    return getKanbanCardById(db, cardId);
  }

  const metadata = parseKanbanCardMetadata(card.metadata_json);
  if (metadata.reward) {
    return getKanbanCardById(db, cardId);
  }

  const now = Date.now();
  const tokenReward = PRIORITY_TOKEN_REWARD[card.priority] + Math.min(Math.max(card.depth, 0), 3) * 4000;
  const xp = Math.floor(tokenReward / 1000);
  db.prepare(
    `UPDATE agents
     SET stats_tasks_done = stats_tasks_done + 1,
         stats_tokens = stats_tokens + ?,
         stats_xp = (stats_tokens + ?) / 1000
     WHERE id = ?`,
  ).run(tokenReward, tokenReward, card.assignee_agent_id);

  const day = new Date(now).toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO daily_activity (agent_id, date, tasks_done, xp_earned, skill_calls)
     VALUES (?, ?, 1, ?, 0)
     ON CONFLICT(agent_id, date)
     DO UPDATE SET
       tasks_done = daily_activity.tasks_done + 1,
       xp_earned = daily_activity.xp_earned + excluded.xp_earned`,
  ).run(card.assignee_agent_id, day, xp);

  metadata.reward = {
    granted_at: now,
    agent_id: card.assignee_agent_id,
    xp,
    tasks_done: 1,
  };
  db.prepare(
    `UPDATE kanban_cards
     SET metadata_json = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(stringifyKanbanCardMetadata(metadata), now, cardId);

  return emitKanbanCard(db, cardId, "kanban_card_updated");
}

export function syncKanbanCardWithDispatch(db: DatabaseSync, dispatchId: string): KanbanCardRow | undefined {
  const dispatch = getTaskDispatchById(db, dispatchId);
  if (!dispatch) {
    return undefined;
  }

  const normalizedFromAgentId = normalizeDispatchParticipantAgentId(db, dispatch.from_agent_id);
  const normalizedToAgentId = normalizeDispatchParticipantAgentId(db, dispatch.to_agent_id);

  ensureChildKanbanCardForDispatch(db, dispatch, normalizedFromAgentId, normalizedToAgentId);

  const card = db.prepare(
    `SELECT *
     FROM kanban_cards
     WHERE latest_dispatch_id = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get(dispatch.id) as KanbanCardBaseRow | undefined;

  if (!card) {
    return undefined;
  }

  const nextStatus = mapDispatchStatusToCardStatus(dispatch.status, card.status);
  const now = Date.now();
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];

  if (normalizedToAgentId !== card.assignee_agent_id) {
    sets.push("assignee_agent_id = ?");
    vals.push(normalizedToAgentId);
  }
  if (dispatch.id !== card.latest_dispatch_id) {
    sets.push("latest_dispatch_id = ?");
    vals.push(dispatch.id);
  }
  if (nextStatus !== card.status) {
    sets.push("status = ?");
    vals.push(nextStatus);
    if (nextStatus === "requested") {
      sets.push("requested_at = COALESCE(requested_at, ?)");
      vals.push(dispatch.dispatched_at ?? dispatch.created_at ?? now);
    }
    if (nextStatus === "in_progress" && !card.started_at) {
      sets.push("started_at = ?");
      vals.push(now);
    }
    if (["failed", "cancelled"].includes(nextStatus)) {
      sets.push("completed_at = ?");
      vals.push(dispatch.completed_at ?? now);
    }
  }

  if (sets.length > 0) {
    sets.push("updated_at = ?");
    vals.push(now);
    vals.push(card.id);
    db.prepare(
      `UPDATE kanban_cards
       SET ${sets.join(", ")}
       WHERE id = ?`,
    ).run(...vals);
  }

  return emitKanbanCard(db, card.id, "kanban_card_updated");
}

function ensureChildKanbanCardForDispatch(
  db: DatabaseSync,
  dispatch: TaskDispatchRow,
  normalizedFromAgentId: string | null,
  normalizedToAgentId: string | null,
): KanbanCardRow | undefined {
  if (!dispatch.parent_dispatch_id) {
    return undefined;
  }

  const existing = db.prepare(
    `SELECT id
     FROM kanban_cards
     WHERE latest_dispatch_id = ?
     LIMIT 1`,
  ).get(dispatch.id) as { id: string } | undefined;
  if (existing) {
    return undefined;
  }

  const parentCard = db.prepare(
    `SELECT *
     FROM kanban_cards
     WHERE latest_dispatch_id = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get(dispatch.parent_dispatch_id) as KanbanCardBaseRow | undefined;

  if (!parentCard) {
    return undefined;
  }

  const status = mapDispatchStatusToCardStatus(dispatch.status, "requested");
  const now = Date.now();
  const id = crypto.randomUUID();
  const sortOrder = calculateSortOrder(db, status, null);
  const metadata = JSON.stringify({ auto_created_from_dispatch: true });

  db.prepare(
    `INSERT INTO kanban_cards (
      id, title, description, status, github_repo, owner_agent_id, requester_agent_id, assignee_agent_id,
      parent_card_id, latest_dispatch_id, sort_order, priority, depth, blocked_reason, review_notes,
      github_issue_number, github_issue_url, metadata_json, created_at, updated_at, started_at,
      requested_at, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    dispatch.title,
    null,
    status,
    parentCard.github_repo,
    normalizedFromAgentId,
    normalizedFromAgentId,
    normalizedToAgentId,
    parentCard.id,
    dispatch.id,
    sortOrder,
    parentCard.priority,
    parentCard.depth + 1,
    null,
    null,
    null,
    null,
    metadata,
    now,
    now,
    status === "in_progress" ? now : null,
    status === "requested" ? (dispatch.dispatched_at ?? dispatch.created_at ?? now) : null,
    ["failed", "cancelled"].includes(status) ? (dispatch.completed_at ?? now) : null,
  );

  return emitKanbanCard(db, id, "kanban_card_created");
}

export function promoteRequestedKanbanCardForAgent(db: DatabaseSync, agentId: string): KanbanCardRow | undefined {
  const requestedCards = db.prepare(
    `SELECT *
     FROM kanban_cards
     WHERE assignee_agent_id = ?
       AND status = 'requested'
     ORDER BY COALESCE(requested_at, updated_at, created_at) DESC`,
  ).all(agentId) as unknown as KanbanCardBaseRow[];

  if (requestedCards.length !== 1) {
    return undefined;
  }

  const card = requestedCards[0];
  const now = Date.now();

  db.prepare(
    `UPDATE kanban_cards
     SET status = 'in_progress',
         started_at = COALESCE(started_at, ?),
         updated_at = ?
     WHERE id = ?`,
  ).run(now, now, card.id);

  if (card.latest_dispatch_id) {
    const dispatch = getTaskDispatchById(db, card.latest_dispatch_id);
    if (dispatch && (dispatch.status === "pending" || dispatch.status === "dispatched")) {
      db.prepare(
        `UPDATE task_dispatches
         SET status = 'in_progress'
         WHERE id = ?`,
      ).run(card.latest_dispatch_id);
      const updatedDispatch = getTaskDispatchById(db, card.latest_dispatch_id);
      if (updatedDispatch) {
        broadcast("task_dispatch_updated", updatedDispatch);
      }
    }
  }

  return emitKanbanCard(db, card.id, "kanban_card_updated");
}

export function retryKanbanCard(
  db: DatabaseSync,
  cardId: string,
  options?: { assignee_agent_id?: string | null; request_now?: boolean },
): KanbanCardRow {
  const card = getRawKanbanCardById(db, cardId);
  if (!card) {
    throw new Error("kanban_card_not_found");
  }

  const assigneeId = options?.assignee_agent_id ?? card.assignee_agent_id;
  if (!assigneeId) {
    throw new Error("assignee_agent_id is required");
  }

  const now = Date.now();
  const metadata = parseKanbanCardMetadata(card.metadata_json);
  metadata.retry_count = (metadata.retry_count ?? 0) + 1;
  if (card.assignee_agent_id && assigneeId !== card.assignee_agent_id) {
    metadata.failover_count = (metadata.failover_count ?? 0) + 1;
  }
  delete metadata.timed_out_at;
  delete metadata.timed_out_reason;
  delete metadata.timed_out_stage;

  db.prepare(
    `UPDATE kanban_cards
     SET assignee_agent_id = ?,
         owner_agent_id = COALESCE(owner_agent_id, ?),
         requester_agent_id = COALESCE(requester_agent_id, ?),
         status = 'ready',
         latest_dispatch_id = NULL,
         blocked_reason = NULL,
         requested_at = NULL,
         started_at = NULL,
         completed_at = NULL,
         metadata_json = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    assigneeId,
    assigneeId,
    assigneeId,
    stringifyKanbanCardMetadata(metadata),
    now,
    cardId,
  );

  if (options?.request_now === false) {
    const updated = emitKanbanCard(db, cardId, "kanban_card_updated");
    if (!updated) throw new Error("kanban_card_not_found");
    return updated;
  }

  return createDispatchForKanbanCard(db, cardId);
}

function transitionCardToStatus(
  db: DatabaseSync,
  card: KanbanCardBaseRow,
  nextStatus: KanbanCardStatus,
  reason: string,
  stage: "requested" | "in_progress",
): KanbanCardRow | undefined {
  const now = Date.now();
  const metadata = parseKanbanCardMetadata(card.metadata_json);
  metadata.timed_out_stage = stage;
  metadata.timed_out_at = now;
  metadata.timed_out_reason = reason;
  db.prepare(
    `UPDATE kanban_cards
     SET status = ?,
         blocked_reason = CASE
           WHEN blocked_reason IS NULL OR blocked_reason = '' THEN ?
           ELSE blocked_reason
         END,
         metadata_json = ?,
         completed_at = CASE WHEN ? = 'failed' THEN COALESCE(completed_at, ?) ELSE completed_at END,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    nextStatus,
    reason,
    stringifyKanbanCardMetadata(metadata),
    nextStatus,
    now,
    now,
    card.id,
  );
  return emitKanbanCard(db, card.id, "kanban_card_updated");
}

export function enforceKanbanTimeouts(db: DatabaseSync): {
  timedOutRequested: KanbanCardRow[];
  stalledInProgress: KanbanCardRow[];
} {
  const now = Date.now();
  const requestedCutoff = now - REQUEST_ACK_TIMEOUT_MS;
  const progressCutoff = now - IN_PROGRESS_STALE_MS;

  const timedOutRequested: KanbanCardRow[] = [];
  const stalledInProgress: KanbanCardRow[] = [];

  const requestedRows = db.prepare(
    `SELECT *
     FROM kanban_cards
     WHERE status = 'requested'
       AND COALESCE(requested_at, updated_at, created_at) < ?`,
  ).all(requestedCutoff) as unknown as KanbanCardBaseRow[];

  for (const card of requestedRows) {
    if (card.latest_dispatch_id) {
      db.prepare(
        `UPDATE task_dispatches
         SET status = 'failed',
             result_summary = COALESCE(result_summary, ?),
             completed_at = COALESCE(completed_at, ?)
         WHERE id = ?
           AND status IN ('pending', 'dispatched')`,
      ).run("Timed out waiting for agent acceptance", now, card.latest_dispatch_id);
      const updatedDispatch = getTaskDispatchById(db, card.latest_dispatch_id);
      if (updatedDispatch) {
        broadcast("task_dispatch_updated", updatedDispatch);
      }
    }
    const updated = transitionCardToStatus(
      db,
      card,
      "failed",
      "Timed out waiting for agent acceptance",
      "requested",
    );
    if (updated) timedOutRequested.push(updated);
  }

  const progressRows = db.prepare(
    `SELECT *
     FROM kanban_cards
     WHERE status = 'in_progress'
       AND COALESCE(started_at, updated_at, created_at) < ?`,
  ).all(progressCutoff) as unknown as KanbanCardBaseRow[];

  for (const card of progressRows) {
    const updated = transitionCardToStatus(
      db,
      card,
      "blocked",
      "No progress signal received for extended time",
      "in_progress",
    );
    if (updated) stalledInProgress.push(updated);
  }

  return { timedOutRequested, stalledInProgress };
}

// ── GitHub issue state sync ──

const ACTIVE_CARD_STATUSES = ["requested", "in_progress", "review", "blocked"] as const;

interface GhIssueState {
  number: number;
  state: string;
}

function ghIssueState(repo: string, issueNumber: number): string | null {
  try {
    const raw = execFileSync("gh", [
      "issue", "view", String(issueNumber),
      "--repo", repo,
      "--json", "state",
    ], { timeout: 10000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const parsed = JSON.parse(raw) as GhIssueState;
    return parsed.state?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * Check active kanban cards linked to GitHub issues.
 * If the GitHub issue is closed, transition the card to "done".
 * If the issue was reopened while card is done/cancelled, transition back to "in_progress".
 */
export function syncGitHubIssueStates(db: DatabaseSync): KanbanCardRow[] {
  const activeCards = db.prepare(
    `SELECT *
     FROM kanban_cards
     WHERE github_repo IS NOT NULL
       AND github_issue_number IS NOT NULL
       AND status IN ('requested', 'in_progress', 'review', 'blocked')`,
  ).all() as unknown as KanbanCardBaseRow[];

  const changed: KanbanCardRow[] = [];

  for (const card of activeCards) {
    if (!card.github_repo || !card.github_issue_number) continue;

    const state = ghIssueState(card.github_repo, card.github_issue_number);
    if (!state) continue;

    if (state === "CLOSED") {
      const now = Date.now();

      // Close linked dispatch if still active
      if (card.latest_dispatch_id) {
        db.prepare(
          `UPDATE task_dispatches
           SET status = 'completed',
               result_summary = COALESCE(result_summary, 'GitHub issue closed externally'),
               completed_at = COALESCE(completed_at, ?)
           WHERE id = ?
             AND status IN ('pending', 'dispatched', 'in_progress')`,
        ).run(now, card.latest_dispatch_id);
        const updated = getTaskDispatchById(db, card.latest_dispatch_id);
        if (updated) broadcast("task_dispatch_updated", updated);
      }

      db.prepare(
        `UPDATE kanban_cards
         SET status = 'done',
             completed_at = COALESCE(completed_at, ?),
             updated_at = ?
         WHERE id = ?`,
      ).run(now, now, card.id);

      const updatedCard = emitKanbanCard(db, card.id, "kanban_card_updated");
      if (updatedCard) changed.push(updatedCard);

      console.log(`[PCD] github-sync: ${card.github_repo}#${card.github_issue_number} closed → card ${card.id} done`);
    }
  }

  return changed;
}
