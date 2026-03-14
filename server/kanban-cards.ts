import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { buildDispatchPayload, formatInstructionsFromInput } from "./dispatch-input.js";
import { getDb } from "./db/runtime.js";
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

export const KANBAN_REVIEW_STATUSES = [
  "awaiting_dod",
  "reviewing",
  "suggestion_pending",
  "improve_rework",
  "dilemma_pending",
  "decided",
] as const;
export type KanbanReviewStatus = (typeof KANBAN_REVIEW_STATUSES)[number];

export const KANBAN_CARD_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
import { getRuntimeConfig } from "./runtime-config.js";

export function getRequestAckTimeoutMs(): number {
  return getRuntimeConfig().requestedAckTimeoutMin * 60 * 1000;
}
export function getInProgressStaleMs(): number {
  return getRuntimeConfig().inProgressStaleMin * 60 * 1000;
}
// Legacy exports for code that imports these constants
export const REQUEST_ACK_TIMEOUT_MS = 45 * 60 * 1000;
export const IN_PROGRESS_STALE_MS = 60 * 60 * 1000;

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
  redispatch_count?: number;
  redispatch_reason?: string;
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
  pipeline_stage_id: string | null;
  review_status: KanbanReviewStatus | null;
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

/**
 * Close the linked GitHub issue when a kanban card reaches a terminal state (done/cancelled).
 * Runs sync (fire-and-forget style) — errors are logged but don't block the response.
 */
export function closeGitHubIssueOnDone(card: {
  github_repo?: string | null;
  github_issue_number?: number | null;
  title: string;
  id: string;
  status?: string;
}): void {
  const repo = card.github_repo;
  const issueNum = card.github_issue_number;
  if (!repo || !issueNum) return;

  const status = card.status ?? "done";
  const emoji = status === "cancelled" ? "🚫" : "✅";
  const label = status === "cancelled" ? "cancelled" : "done";
  const comment = `${emoji} Closed automatically by PCD kanban — card "${card.title}" marked ${label}.`;

  // Check if issue is already closed — skip if so
  try {
    const result = execFileSync("gh", ["issue", "view", String(issueNum), "--repo", repo, "--json", "state", "-q", ".state"], {
      timeout: 15_000,
      stdio: "pipe",
    });
    if (result.toString().trim() === "CLOSED") {
      console.log(`[kanban] GitHub issue ${repo}#${issueNum} already closed, skipping`);
      return;
    }
  } catch (e) {
    console.error(`[kanban] gh issue view failed for ${repo}#${issueNum}:`, (e as Error).message);
    return;
  }

  // Comment then close
  try {
    execFileSync("gh", ["issue", "comment", String(issueNum), "--repo", repo, "--body", comment], {
      timeout: 15_000,
      stdio: "pipe",
    });
  } catch (e) {
    console.error(`[kanban] gh issue comment failed for ${repo}#${issueNum}:`, (e as Error).message);
  }

  try {
    execFileSync("gh", ["issue", "close", String(issueNum), "--repo", repo], {
      timeout: 15_000,
      stdio: "pipe",
    });
    console.log(`[kanban] closed GitHub issue ${repo}#${issueNum} (card ${label})`);
  } catch (e) {
    console.error(`[kanban] gh issue close failed for ${repo}#${issueNum}:`, (e as Error).message);
  }
}

/**
 * Parse DoD section from a GitHub issue body and extract checkbox states.
 * Returns an array of { label, done } objects, or null if no DoD section found.
 */
function parseDodFromBody(body: string): Array<{ label: string; done: boolean }> | null {
  if (!body.includes("## DoD")) return null;
  const sections: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentLines: string[] = [];
  for (const line of body.split("\n")) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (currentKey) sections[currentKey] = currentLines.join("\n").trim();
      currentKey = heading[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentKey) sections[currentKey] = currentLines.join("\n").trim();
  const dodText = sections["DoD"] ?? "";
  if (!dodText) return null;
  const items: Array<{ label: string; done: boolean }> = [];
  for (const line of dodText.split("\n")) {
    const m = line.match(/^-\s*\[([ x])\]\s*(.+)$/);
    if (m) {
      const label = m[2].trim();
      if (label) items.push({ label, done: m[1] === "x" });
    }
  }
  return items.length > 0 ? items : null;
}

/**
 * Fetch the GitHub issue body and mirror DoD checkbox states into the kanban
 * card's review_checklist metadata. GitHub is the source of truth.
 * Returns the updated checklist, or null if mirroring was not possible.
 */
export function mirrorGitHubDodToChecklist(
  db: DatabaseSync,
  cardId: string,
  repo: string,
  issueNumber: number,
): KanbanReviewChecklistItem[] | null {
  let body: string;
  try {
    body = execFileSync("gh", [
      "issue", "view", String(issueNumber), "--repo", repo, "--json", "body", "-q", ".body",
    ], { timeout: 15_000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    console.error(`[kanban] gh issue view (DoD mirror) failed for ${repo}#${issueNumber}:`, (e as Error).message);
    return null;
  }

  const dodItems = parseDodFromBody(body);
  if (!dodItems) return null;

  const checklist: KanbanReviewChecklistItem[] = dodItems.map((item, i) => ({
    id: `item-${i + 1}`,
    label: item.label,
    done: item.done,
  }));

  setCardMetadata(db, cardId, (meta) => ({
    ...meta,
    review_checklist: checklist,
  }));
  emitKanbanCard(db, cardId, "kanban_card_updated");
  console.log(`[kanban] mirrored DoD from ${repo}#${issueNumber} → card ${cardId} (${dodItems.filter((d) => d.done).length}/${dodItems.length} done)`);
  return checklist;
}

/**
 * When a kanban card transitions to "review":
 * 1. Mirror GitHub issue DoD checkbox states into review_checklist
 * 2. Add a "리뷰 대기중" comment on the GitHub issue
 * Fire-and-forget — errors are logged but don't block the caller.
 */
export function updateGitHubChecklistOnReview(card: {
  github_repo?: string | null;
  github_issue_number?: number | null;
  title: string;
  id: string;
  metadata_json?: string | null;
  assignee_agent_id?: string | null;
}): void {
  const repo = card.github_repo;
  const issueNum = card.github_issue_number;
  if (!repo || !issueNum) return;

  // Mirror GitHub DoD → review_checklist (GitHub is source of truth)
  const db = getDb();
  const checklist = mirrorGitHubDodToChecklist(db, card.id, repo, issueNum);
  const checkedCount = checklist?.filter((item) => item.done).length ?? 0;
  const totalCount = checklist?.length ?? 0;

  // Add review-pending comment
  const agentName = card.assignee_agent_id ?? "unknown";
  const summary = totalCount > 0 ? ` (${checkedCount}/${totalCount} DoD 항목 완료)` : "";
  const comment = `🔍 **리뷰 대기중**${summary}\n\n카드 "${card.title}" — 에이전트 ${agentName} 작업 완료, 리뷰를 기다리고 있습니다.`;
  try {
    execFileSync("gh", ["issue", "comment", String(issueNum), "--repo", repo, "--body", comment], {
      timeout: 15_000,
      stdio: "pipe",
    });
    console.log(`[kanban] posted review-pending comment on ${repo}#${issueNum}`);
  } catch (e) {
    console.error(`[kanban] gh issue comment (review) failed for ${repo}#${issueNum}:`, (e as Error).message);
  }
}

/**
 * Post a "blocked" comment on the linked GitHub issue.
 * Fire-and-forget — errors are logged but don't block the caller.
 */
export function commentBlockedOnGitHub(
  repo: string,
  issueNumber: number,
  reason: string,
  agentName: string,
  cardId: string,
): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const body = [
    `🔴 **에이전트 질문 (blocked)**`,
    ``,
    reason,
    ``,
    `---`,
    `*카드: ${cardId} | 에이전트: ${agentName} | 시각: ${ts}*`,
  ].join("\n");
  try {
    execFileSync("gh", ["issue", "comment", String(issueNumber), "--repo", repo, "--body", body], {
      timeout: 15_000,
      stdio: "pipe",
    });
    console.log(`[kanban] posted blocked comment on ${repo}#${issueNumber}`);
  } catch (e) {
    console.error(`[kanban] gh issue comment (blocked) failed for ${repo}#${issueNumber}:`, (e as Error).message);
  }
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

  let nextStatus = mapDispatchStatusToCardStatus(dispatch.status, card.status);
  const now = Date.now();

  // If dispatch completed and card would go to review, but GitHub issue is
  // already closed, skip review and go straight to done.
  if (nextStatus === "review" && card.github_repo && card.github_issue_number) {
    try {
      const state = execFileSync("gh", [
        "issue", "view", String(card.github_issue_number),
        "--repo", card.github_repo, "--json", "state", "-q", ".state",
      ], { timeout: 10_000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (state === "CLOSED") {
        nextStatus = "done";
        console.log(`[kanban] GitHub issue ${card.github_repo}#${card.github_issue_number} already closed — skipping review, card → done`);
      }
    } catch {
      // gh CLI failure — proceed with review as normal
    }
  }

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
    if (["done", "failed", "cancelled"].includes(nextStatus)) {
      sets.push("completed_at = COALESCE(completed_at, ?)");
      vals.push(dispatch.completed_at ?? now);
    }
    if (nextStatus === "done") {
      sets.push("review_status = NULL");
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

  // When a review dispatch completes without a .result.json verdict,
  // surface it for manual decision instead of auto-passing.
  // The review agent may have found real issues that weren't delivered as a result file.
  if (dispatch.status === "completed" && dispatch.dispatch_type === "review" && !dispatch.result_file) {
    const pendingReview = db.prepare(
      `SELECT id FROM kanban_reviews WHERE review_dispatch_id = ? AND verdict = 'pending' LIMIT 1`,
    ).get(dispatch.id) as { id: string } | undefined;
    if (pendingReview) {
      const reviewCard = db.prepare(
        `SELECT id FROM kanban_cards WHERE latest_dispatch_id = ? LIMIT 1`,
      ).get(dispatch.id) as { id: string } | undefined;
      // Update review row to 'improve' with a placeholder item prompting manual check
      const now2 = Date.now();
      db.prepare(
        `UPDATE kanban_reviews SET verdict = 'improve', items_json = ?, completed_at = ? WHERE id = ?`,
      ).run(
        JSON.stringify([{ id: "missing-verdict", category: "improve", summary: "리뷰 에이전트가 완료했으나 verdict 미전달 — 리뷰 결과를 직접 확인하세요" }]),
        now2,
        pendingReview.id,
      );
      // Set card to suggestion_pending so user sees it in decision UI
      db.prepare(
        `UPDATE kanban_cards SET review_status = 'suggestion_pending', updated_at = ? WHERE id = ?`,
      ).run(now2, card.id);
      if (reviewCard) {
        emitKanbanCard(db, reviewCard.id, "kanban_card_updated");
      }
      console.warn(`[kanban] Review ${dispatch.id} completed without verdict — marked suggestion_pending for manual decision`);
    }
  }

  const updatedCard = emitKanbanCard(db, card.id, "kanban_card_updated");

  // Auto-queue: progress to next card when this card reaches terminal state
  if (["done", "failed", "cancelled"].includes(nextStatus) && !["done", "failed", "cancelled"].includes(card.status)) {
    import("./auto-queue.js").then(({ onCardTerminal: oct }) => {
      try {
        oct(db, card.id, nextStatus);
      } catch (e) {
        console.error(`[kanban] syncKanbanCard auto-queue onCardTerminal error:`, (e as Error).message);
      }
    }).catch(() => {});
  }

  return updatedCard;
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

/**
 * Redispatch a kanban card: cancel current dispatch, fetch latest GitHub issue
 * body, rebuild dispatch payload, and create a new dispatch.
 * Only valid for `requested` and `in_progress` cards.
 */
export function redispatchKanbanCard(
  db: DatabaseSync,
  cardId: string,
  options?: { reason?: string | null },
): KanbanCardRow {
  const card = getRawKanbanCardById(db, cardId);
  if (!card) throw new Error("kanban_card_not_found");
  if (!["requested", "in_progress"].includes(card.status)) {
    throw new Error("redispatch_invalid_status");
  }
  if (!card.assignee_agent_id) throw new Error("assignee_agent_id is required");

  const now = Date.now();

  // 1. Cancel current dispatch if exists
  if (card.latest_dispatch_id) {
    db.prepare(
      `UPDATE task_dispatches SET status = 'cancelled', completed_at = ? WHERE id = ? AND status NOT IN ('completed','cancelled','failed')`,
    ).run(now, card.latest_dispatch_id);
  }

  // 2. Fetch latest GitHub issue body if linked
  let updatedDescription = card.description;
  if (card.github_repo && card.github_issue_number) {
    try {
      const body = execFileSync("gh", [
        "issue", "view", String(card.github_issue_number),
        "--repo", card.github_repo,
        "--json", "body", "-q", ".body",
      ], { timeout: 15_000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (body) updatedDescription = body;
    } catch (e) {
      console.error(`[kanban] gh issue view failed for redispatch ${card.github_repo}#${card.github_issue_number}:`, (e as Error).message);
    }
  }

  // 3. Update card description if changed
  if (updatedDescription !== card.description) {
    db.prepare(`UPDATE kanban_cards SET description = ?, updated_at = ? WHERE id = ?`).run(
      updatedDescription, now, cardId,
    );
  }

  // 4. Track redispatch metadata
  const metadata = parseKanbanCardMetadata(card.metadata_json);
  metadata.redispatch_count = (metadata.redispatch_count ?? 0) + 1;
  if (options?.reason) {
    metadata.redispatch_reason = options.reason;
  }
  db.prepare(`UPDATE kanban_cards SET metadata_json = ?, updated_at = ? WHERE id = ?`).run(
    stringifyKanbanCardMetadata(metadata), now, cardId,
  );

  // 5. Reset card to ready state, then create new dispatch
  db.prepare(
    `UPDATE kanban_cards
     SET status = 'ready',
         latest_dispatch_id = NULL,
         review_status = NULL,
         requested_at = NULL,
         started_at = NULL,
         completed_at = NULL,
         updated_at = ?
     WHERE id = ?`,
  ).run(now, cardId);

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
  const requestedCutoff = now - getRequestAckTimeoutMs();
  const progressCutoff = now - getInProgressStaleMs();

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

  // Auto-pass stale pending reviews whose dispatch already completed
  const staleReviews = db.prepare(
    `SELECT kr.id, kr.review_dispatch_id
     FROM kanban_reviews kr
     JOIN task_dispatches td ON td.id = kr.review_dispatch_id
     WHERE kr.verdict = 'pending'
       AND td.status IN ('completed', 'failed')`,
  ).all() as unknown as Array<{ id: string; review_dispatch_id: string }>;

  for (const sr of staleReviews) {
    try {
      processReviewVerdict(db, sr.review_dispatch_id, {
        overall: "pass",
        items: [{ id: "auto-pass", category: "pass", summary: "리뷰 dispatch 완료 후 verdict 미반환 — 자동 pass" }],
      });
      console.warn(`[kanban-timeout] Auto-passed stale review ${sr.id} (dispatch ${sr.review_dispatch_id})`);
    } catch (e) {
      console.error(`[kanban-timeout] Failed to auto-pass review ${sr.id}:`, (e as Error).message);
    }
  }

  return { timedOutRequested, stalledInProgress };
}

// ── GitHub issue state sync ──

const TERMINAL_OR_BACKLOG: readonly KanbanCardStatus[] = ["backlog", "done", "cancelled"];
const ACTIVE_CARD_STATUSES = KANBAN_CARD_STATUSES.filter(
  (s) => !TERMINAL_OR_BACKLOG.includes(s),
);

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
  const placeholders = ACTIVE_CARD_STATUSES.map(() => "?").join(", ");
  const activeCards = db.prepare(
    `SELECT *
     FROM kanban_cards
     WHERE github_repo IS NOT NULL
       AND github_issue_number IS NOT NULL
       AND status IN (${placeholders})`,
  ).all(...ACTIVE_CARD_STATUSES) as unknown as KanbanCardBaseRow[];

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
             review_status = NULL,
             completed_at = COALESCE(completed_at, ?),
             updated_at = ?
         WHERE id = ?`,
      ).run(now, now, card.id);

      rewardKanbanCompletion(db, card.id);

      const updatedCard = emitKanbanCard(db, card.id, "kanban_card_updated");
      if (updatedCard) changed.push(updatedCard);

      console.log(`[PCD] github-sync: ${card.github_repo}#${card.github_issue_number} closed → card ${card.id} done`);
    } else if (state === "OPEN" && card.status === "review") {
      // Periodically mirror DoD checkbox states for review cards
      mirrorGitHubDodToChecklist(db, card.id, card.github_repo!, card.github_issue_number!);
    }
  }

  return changed;
}

// ── Counter-model review system ──

export interface ReviewVerdictItem {
  id: string;
  category: "pass" | "improve" | "dilemma";
  summary: string;
  detail?: string;
  suggestion?: string;
  pros?: string;
  cons?: string;
}

export interface ReviewVerdict {
  overall: "pass" | "improve" | "dilemma" | "mixed";
  items: ReviewVerdictItem[];
}

interface KanbanReviewRow {
  id: string;
  card_id: string;
  round: number;
  original_dispatch_id: string | null;
  original_agent_id: string | null;
  original_provider: string | null;
  review_dispatch_id: string | null;
  reviewer_agent_id: string | null;
  reviewer_provider: string | null;
  verdict: string;
  items_json: string | null;
  github_comment_id: string | null;
  created_at: number;
  completed_at: number | null;
}

export function listKanbanReviews(db: DatabaseSync, cardId: string): KanbanReviewRow[] {
  return db.prepare(
    "SELECT * FROM kanban_reviews WHERE card_id = ? ORDER BY round ASC",
  ).all(cardId) as unknown as KanbanReviewRow[];
}

/**
 * Determine which provider handled the original dispatch.
 * Uses dispatched_sessions history (most recent session with matching dispatch_id).
 */
function getOriginalProviderForDispatch(db: DatabaseSync, dispatchId: string): string | null {
  const row = db.prepare(
    `SELECT provider FROM dispatched_sessions
     WHERE active_dispatch_id = ?
     ORDER BY last_seen_at DESC LIMIT 1`,
  ).get(dispatchId) as { provider: string } | undefined;
  return row?.provider ?? null;
}

interface AgentChannelInfo {
  id: string;
  role_id: string | null;
  discord_channel_id: string | null;
  discord_channel_id_alt: string | null;
  discord_channel_id_codex: string | null;
  discord_prefer_alt: number;
}

/**
 * Get the counter model's channel for review dispatch.
 * claude → codex channel, codex → primary claude channel.
 * Returns null if no counter channel exists (fallback to manual review).
 */
function getCounterChannel(agent: AgentChannelInfo, originalProvider: string): { channelId: string; provider: string } | null {
  if (originalProvider === "codex") {
    // Counter = claude channel
    const ch = agent.discord_prefer_alt ? agent.discord_channel_id_alt : agent.discord_channel_id;
    return ch ? { channelId: ch, provider: "claude" } : null;
  }
  // Default: original was claude → counter = codex
  const ch = agent.discord_channel_id_codex;
  return ch ? { channelId: ch, provider: "codex" } : null;
}

/**
 * Trigger counter-model review when a card enters review with all DoD complete.
 * Creates a review dispatch to the counter model's channel.
 * Returns true if review was triggered, false if manual review fallback.
 */
export function triggerCounterModelReview(db: DatabaseSync, cardId: string): boolean {
  const card = getRawKanbanCardById(db, cardId);
  if (!card || card.status !== "review") return false;

  // Check DoD — all must be done
  const metadata = parseKanbanCardMetadata(card.metadata_json);
  if (!metadata.review_checklist || metadata.review_checklist.some((item) => !item.done)) {
    // DoD not all done — set review_status = awaiting_dod
    db.prepare("UPDATE kanban_cards SET review_status = 'awaiting_dod', updated_at = ? WHERE id = ?")
      .run(Date.now(), cardId);
    emitKanbanCard(db, cardId, "kanban_card_updated");
    return false;
  }

  // Get original dispatch info
  const dispatchId = card.latest_dispatch_id;
  if (!dispatchId) return false;

  const originalProvider = getOriginalProviderForDispatch(db, dispatchId) ?? "claude";

  // Get agent channel info
  const agent = db.prepare(
    `SELECT id, role_id, discord_channel_id, discord_channel_id_alt, discord_channel_id_codex, discord_prefer_alt
     FROM agents WHERE id = ? LIMIT 1`,
  ).get(card.assignee_agent_id) as AgentChannelInfo | undefined;
  if (!agent) return false;

  const counter = getCounterChannel(agent, originalProvider);
  if (!counter) {
    // No counter channel — manual review fallback
    console.log(`[kanban-review] No counter channel for agent ${card.assignee_agent_id}, manual review`);
    return false;
  }

  // Check round limit
  const { maxReviewRounds } = getRuntimeConfig();
  const existingReviews = db.prepare(
    "SELECT COUNT(*) as cnt FROM kanban_reviews WHERE card_id = ?",
  ).get(cardId) as { cnt: number };
  const round = existingReviews.cnt + 1;

  if (round > maxReviewRounds) {
    // Max rounds reached — force dilemma
    db.prepare("UPDATE kanban_cards SET review_status = 'dilemma_pending', updated_at = ? WHERE id = ?")
      .run(Date.now(), cardId);
    emitKanbanCard(db, cardId, "kanban_card_updated");
    console.log(`[kanban-review] Max review rounds (${maxReviewRounds}) reached for card ${cardId}, forcing dilemma`);
    return false;
  }

  // Build review handoff
  ensurePcdRuntimeDirs();
  const reviewDispatchId = crypto.randomUUID();
  const now = Date.now();

  // Collect changed files from git diff if possible
  let changedFiles: string[] = [];
  try {
    const raw = execFileSync("git", ["diff", "--name-only", "HEAD~1"], {
      timeout: 10_000,
      encoding: "utf-8",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    changedFiles = raw ? raw.split("\n").filter(Boolean) : [];
  } catch { /* ignore */ }

  const dodItems = metadata.review_checklist.map((item) => ({
    text: item.label,
    checked: item.done,
  }));

  const reviewInstructions = [
    `## 읽기 전용 코드 리뷰`,
    ``,
    `⚠️ **중요: 이것은 읽기 전용 리뷰입니다. 코드를 절대 수정하지 마세요.**`,
    `- 파일을 편집(Edit/Write)하지 마세요`,
    `- git commit/push를 하지 마세요`,
    `- 코드를 읽고 검토 항목만 추출하세요`,
    ``,
    `## 리뷰 대상`,
    `- 이슈: ${card.github_issue_url ?? card.title}`,
    `- 원본 모델: ${originalProvider}`,
    `- 라운드: ${round}/${maxReviewRounds}`,
    ``,
    `## DoD 항목`,
    ...dodItems.map((item, i) => `${i + 1}. ${item.text}`),
    ``,
    `## 변경 파일`,
    ...(changedFiles.length > 0 ? changedFiles.map((f) => `- ${f}`) : ["- (없음)"]),
    ``,
    `## 리뷰 지침`,
    `각 DoD 항목과 변경 파일을 읽고, 발견된 문제/개선점을 항목별로 나열하세요.`,
    `당신은 판정(pass/fail)을 내리지 않습니다 — 검토 항목 추출만 합니다.`,
    `문제가 없으면 items를 빈 배열로 반환하세요.`,
    ``,
    `## 결과 반환 (필수)`,
    `리뷰가 끝나면 아래 경로에 JSON 파일을 **반드시** 작성하세요:`,
    `\`${PCD_HANDOFF_DIR}/${reviewDispatchId}.result.json\``,
    ``,
    `파일 내용 (JSON):`,
    `\`\`\`json`,
    `{`,
    `  "dispatch_id": "${reviewDispatchId}",`,
    `  "from": "${agent.id}",`,
    `  "to": "${card.requester_agent_id ?? card.assignee_agent_id}",`,
    `  "status": "pass",`,
    `  "summary": "리뷰 완료 요약 (1줄)",`,
    `  "review_verdict": {`,
    `    "overall": "pass 또는 improve",`,
    `    "items": [`,
    `      { "id": "item-1", "category": "improve", "summary": "발견 사항 요약", "detail": "상세 설명", "suggestion": "개선 제안" }`,
    `    ]`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `- items가 비어있으면 overall을 "pass"로, 항목이 있으면 "improve"로 설정하세요.`,
    `- category는 모두 "improve"로 통일하세요 (판정은 작업 모델이 합니다).`,
    `- **이 파일을 작성하지 않으면 리뷰 결과가 반영되지 않습니다.**`,
  ].join("\n");

  const handoff = {
    dispatch_id: reviewDispatchId,
    from: card.requester_agent_id ?? card.assignee_agent_id,
    to: card.assignee_agent_id,
    type: "review",
    title: `[Review R${round}] ${card.title}`,
    parent_dispatch_id: dispatchId,
    delivery_channel_id: counter.channelId,
    context: {
      summary: `Counter-model review round ${round} for: ${card.title}`,
      changed_files: changedFiles,
      repo_path: process.cwd(),
    },
    review_context: {
      original_dispatch_id: dispatchId,
      original_agent_id: card.assignee_agent_id,
      original_provider: originalProvider,
      review_round: round,
      max_rounds: maxReviewRounds,
      dod_items: dodItems,
    },
    instructions: reviewInstructions,
  };

  // Insert dispatch row
  const chainDepth = (() => {
    if (!dispatchId) return 0;
    const parent = db.prepare("SELECT chain_depth FROM task_dispatches WHERE id = ? LIMIT 1")
      .get(dispatchId) as { chain_depth: number } | undefined;
    return (parent?.chain_depth ?? 0) + 1;
  })();

  db.prepare(
    `INSERT INTO task_dispatches (id, from_agent_id, to_agent_id, dispatch_type, status, title, context_file, parent_dispatch_id, chain_depth, created_at, dispatched_at)
     VALUES (?, ?, ?, 'review', 'pending', ?, NULL, ?, ?, ?, NULL)`,
  ).run(
    reviewDispatchId,
    card.requester_agent_id ?? card.assignee_agent_id,
    card.assignee_agent_id,
    handoff.title,
    dispatchId,
    chainDepth,
    now,
  );

  // Insert review row
  const reviewId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO kanban_reviews (id, card_id, round, original_dispatch_id, original_agent_id, original_provider, review_dispatch_id, reviewer_agent_id, reviewer_provider, verdict, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    reviewId,
    cardId,
    round,
    dispatchId,
    card.assignee_agent_id,
    originalProvider,
    reviewDispatchId,
    card.assignee_agent_id,
    counter.provider,
    now,
  );

  // Write handoff file
  const fileName = `${now}-${reviewDispatchId}.json`;
  const filePath = path.join(PCD_HANDOFF_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(handoff, null, 2));

  // Update card review_status
  db.prepare("UPDATE kanban_cards SET review_status = 'reviewing', updated_at = ? WHERE id = ?")
    .run(now, cardId);
  emitKanbanCard(db, cardId, "kanban_card_updated");

  console.log(`[kanban-review] Triggered counter-model review: card=${cardId}, round=${round}, ${originalProvider}→${counter.provider}`);
  return true;
}

/**
 * Process the verdict from a counter-model review.
 * Called when a review result file is processed by the dispatch watcher.
 */
export function processReviewVerdict(
  db: DatabaseSync,
  reviewDispatchId: string,
  verdict: ReviewVerdict,
): void {
  const review = db.prepare(
    "SELECT * FROM kanban_reviews WHERE review_dispatch_id = ? LIMIT 1",
  ).get(reviewDispatchId) as KanbanReviewRow | undefined;
  if (!review) {
    console.error(`[kanban-review] No review found for dispatch ${reviewDispatchId}`);
    return;
  }

  const card = getRawKanbanCardById(db, review.card_id);
  if (!card) return;

  const now = Date.now();

  // Update review row
  db.prepare(
    `UPDATE kanban_reviews SET verdict = ?, items_json = ?, completed_at = ? WHERE id = ?`,
  ).run(verdict.overall, JSON.stringify(verdict.items), now, review.id);

  // Post GitHub comment with review results
  if (card.github_repo && card.github_issue_number) {
    postReviewCommentOnGitHub(card, review.round, verdict);
  }

  switch (verdict.overall) {
    case "pass": {
      // Auto-done: mark card as done
      db.prepare(
        `UPDATE kanban_cards SET status = 'done', review_status = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
      ).run(now, now, card.id);
      // Complete the original dispatch
      if (card.latest_dispatch_id) {
        db.prepare(
          `UPDATE task_dispatches SET status = 'completed', result_summary = 'Review passed', completed_at = ? WHERE id = ? AND status IN ('pending','dispatched','in_progress','completed')`,
        ).run(now, card.latest_dispatch_id);
      }
      emitKanbanCard(db, card.id, "kanban_card_updated");
      // Reward + close issue
      rewardKanbanCompletion(db, card.id);
      closeGitHubIssueOnDone(card);
      console.log(`[kanban-review] Card ${card.id} passed review → done`);
      break;
    }
    case "improve":
    case "mixed": {
      // Present findings for decision — original model (or human) decides accept/reject
      db.prepare(
        `UPDATE kanban_cards SET review_status = 'suggestion_pending', updated_at = ? WHERE id = ?`,
      ).run(now, card.id);
      emitKanbanCard(db, card.id, "kanban_card_updated");
      console.log(`[kanban-review] Card ${card.id} has review findings → awaiting decision`);
      break;
    }
    case "dilemma": {
      // Also route through suggestion_pending for consistency
      db.prepare(
        `UPDATE kanban_cards SET review_status = 'suggestion_pending', updated_at = ? WHERE id = ?`,
      ).run(now, card.id);
      emitKanbanCard(db, card.id, "kanban_card_updated");
      console.log(`[kanban-review] Card ${card.id} has dilemma items → awaiting decision`);
      break;
    }
  }

  // Complete review child card — the review work itself is done regardless of verdict
  const reviewChildCard = db.prepare(
    `SELECT id, status FROM kanban_cards WHERE latest_dispatch_id = ? AND id != ? LIMIT 1`,
  ).get(reviewDispatchId, card.id) as { id: string; status: string } | undefined;
  if (reviewChildCard && !["done", "failed", "cancelled"].includes(reviewChildCard.status)) {
    db.prepare(
      `UPDATE kanban_cards SET status = 'done', review_status = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, reviewChildCard.id);
    emitKanbanCard(db, reviewChildCard.id, "kanban_card_updated");
    console.log(`[kanban-review] Review child card ${reviewChildCard.id} → done`);
  }
}

/**
 * Create a rework dispatch back to the original model.
 */
function createReworkDispatch(
  db: DatabaseSync,
  card: KanbanCardBaseRow,
  review: KanbanReviewRow,
  verdict: ReviewVerdict,
): void {
  ensurePcdRuntimeDirs();
  const reworkDispatchId = crypto.randomUUID();
  const now = Date.now();

  const improvements = verdict.items
    .filter((i) => i.category === "improve")
    .map((i, idx) => `${idx + 1}. ${i.summary}${i.suggestion ? `\n   제안: ${i.suggestion}` : ""}`)
    .join("\n");

  const reworkInstructions = [
    `이전 구현에 대한 카운터 모델 리뷰에서 개선 사항이 발견되었습니다.`,
    `리뷰 라운드: ${review.round}`,
    ``,
    `## 개선 필요 항목`,
    improvements,
    ``,
    `위 항목들을 수정한 뒤, 작업 완료 시 DoD를 다시 체크해 주세요.`,
  ].join("\n");

  const handoff = {
    dispatch_id: reworkDispatchId,
    from: card.requester_agent_id ?? card.assignee_agent_id,
    to: card.assignee_agent_id,
    type: "generic",
    title: `[Rework R${review.round}] ${card.title}`,
    parent_dispatch_id: review.review_dispatch_id,
    context: {
      summary: `Rework after review round ${review.round}: ${card.title}`,
      repo_path: process.cwd(),
    },
    instructions: reworkInstructions,
  };

  const chainDepth = (() => {
    if (!review.review_dispatch_id) return 0;
    const parent = db.prepare("SELECT chain_depth FROM task_dispatches WHERE id = ? LIMIT 1")
      .get(review.review_dispatch_id) as { chain_depth: number } | undefined;
    return (parent?.chain_depth ?? 0) + 1;
  })();

  db.prepare(
    `INSERT INTO task_dispatches (id, from_agent_id, to_agent_id, dispatch_type, status, title, context_file, parent_dispatch_id, chain_depth, created_at, dispatched_at)
     VALUES (?, ?, ?, 'generic', 'pending', ?, NULL, ?, ?, ?, NULL)`,
  ).run(
    reworkDispatchId,
    card.requester_agent_id ?? card.assignee_agent_id,
    card.assignee_agent_id,
    handoff.title,
    review.review_dispatch_id,
    chainDepth,
    now,
  );

  // Update card to in_progress with rework dispatch
  db.prepare(
    `UPDATE kanban_cards SET status = 'in_progress', latest_dispatch_id = ?, started_at = ?, completed_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(reworkDispatchId, now, now, card.id);

  const fileName = `${now}-${reworkDispatchId}.json`;
  const filePath = path.join(PCD_HANDOFF_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(handoff, null, 2));

  emitKanbanCard(db, card.id, "kanban_card_updated");
}

/**
 * Post a structured review comment on the GitHub issue.
 */
function postReviewCommentOnGitHub(
  card: KanbanCardBaseRow,
  round: number,
  verdict: ReviewVerdict,
): void {
  if (!card.github_repo || !card.github_issue_number) return;

  const emoji = verdict.overall === "pass" ? "✅" : verdict.overall === "improve" ? "🔧" : verdict.overall === "dilemma" ? "🤔" : "⚠️";
  const lines = [
    `${emoji} **카운터 모델 리뷰 (R${round})** — ${verdict.overall.toUpperCase()}`,
    ``,
  ];

  for (const item of verdict.items) {
    const cat = item.category === "pass" ? "✅" : item.category === "improve" ? "🔧" : "🤔";
    lines.push(`${cat} **${item.summary}**`);
    if (item.detail) lines.push(`  ${item.detail}`);
    if (item.suggestion) lines.push(`  💡 ${item.suggestion}`);
    if (item.pros) lines.push(`  👍 ${item.pros}`);
    if (item.cons) lines.push(`  👎 ${item.cons}`);
    lines.push("");
  }

  const body = lines.join("\n");
  try {
    const result = execFileSync("gh", [
      "issue", "comment", String(card.github_issue_number),
      "--repo", card.github_repo, "--body", body,
    ], { timeout: 15_000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    // Try to extract comment ID for tracking
    const urlMatch = result.match(/\/comments\/(\d+)/);
    if (urlMatch) {
      const db = getDb();
      db.prepare(
        "UPDATE kanban_reviews SET github_comment_id = ? WHERE card_id = ? AND round = ?",
      ).run(urlMatch[1], card.id, round);
    }
    console.log(`[kanban-review] Posted review comment on ${card.github_repo}#${card.github_issue_number}`);
  } catch (e) {
    console.error(`[kanban-review] gh issue comment failed:`, (e as Error).message);
  }
}

// ── Dilemma decision system ──

export interface ReviewDecisionInput {
  item_id: string;
  decision: "accept" | "reject";
}

/**
 * Save accept/reject decisions for individual review items.
 * Updates items_json in kanban_reviews with decision + decided_at fields.
 */
export function saveReviewDecisions(
  db: DatabaseSync,
  reviewId: string,
  decisions: ReviewDecisionInput[],
): KanbanReviewRow {
  const review = db.prepare(
    "SELECT * FROM kanban_reviews WHERE id = ? LIMIT 1",
  ).get(reviewId) as KanbanReviewRow | undefined;
  if (!review) throw new Error("review_not_found");

  const items: ReviewVerdictItem[] = review.items_json
    ? (JSON.parse(review.items_json) as ReviewVerdictItem[])
    : [];
  if (items.length === 0) throw new Error("review_has_no_items");

  const now = Date.now();
  const decisionMap = new Map(decisions.map((d) => [d.item_id, d.decision]));

  for (const item of items) {
    const dec = decisionMap.get(item.id);
    if (dec) {
      (item as ReviewVerdictItem & { decision?: string; decided_at?: number }).decision = dec;
      (item as ReviewVerdictItem & { decided_at?: number }).decided_at = now;
    }
  }

  db.prepare(
    "UPDATE kanban_reviews SET items_json = ? WHERE id = ?",
  ).run(JSON.stringify(items), reviewId);

  return db.prepare(
    "SELECT * FROM kanban_reviews WHERE id = ? LIMIT 1",
  ).get(reviewId) as unknown as KanbanReviewRow;
}

/**
 * After all dilemma items have decisions, trigger rework with accepted items.
 * Validates all dilemma items have decisions, updates verdict to "decided",
 * creates rework handoff with accepted suggestions, and posts GitHub comment.
 */
export function triggerDecidedRework(
  db: DatabaseSync,
  reviewId: string,
): void {
  const review = db.prepare(
    "SELECT * FROM kanban_reviews WHERE id = ? LIMIT 1",
  ).get(reviewId) as KanbanReviewRow | undefined;
  if (!review) throw new Error("review_not_found");

  const card = getRawKanbanCardById(db, review.card_id);
  if (!card) throw new Error("card_not_found");

  const items: Array<ReviewVerdictItem & { decision?: string; decided_at?: number }> = review.items_json
    ? (JSON.parse(review.items_json) as Array<ReviewVerdictItem & { decision?: string; decided_at?: number }>)
    : [];

  // Validate: all non-pass items must have decisions
  const actionableItems = items.filter((i) => i.category !== "pass");
  const undecided = actionableItems.filter((i) => !i.decision);
  if (undecided.length > 0) {
    throw new Error(`undecided_items: ${undecided.map((i) => i.id).join(",")}`);
  }

  const now = Date.now();

  // Update review verdict to "decided"
  db.prepare(
    "UPDATE kanban_reviews SET verdict = 'decided', items_json = ?, completed_at = ? WHERE id = ?",
  ).run(JSON.stringify(items), now, reviewId);

  const acceptedItems = items.filter((i) => i.decision === "accept");
  const rejectedItems = items.filter((i) => i.decision === "reject");

  // Post decision comment on GitHub
  if (card.github_repo && card.github_issue_number) {
    postDecisionCommentOnGitHub(card, review.round, acceptedItems, rejectedItems);
  }

  // Rework items = only accepted items (original model decides what to fix)
  const reworkItems = acceptedItems;
  if (reworkItems.length > 0) {
    const reworkVerdict: ReviewVerdict = {
      overall: "improve",
      items: reworkItems.map((i) => ({
        id: i.id,
        category: "improve" as const,
        summary: i.summary,
        detail: i.detail,
        suggestion: i.suggestion,
      })),
    };

    // Transition card: review → requested (via initiateRework)
    initiateRework(db, card, review, reworkVerdict, rejectedItems);
  } else {
    // All dilemma items rejected, no improve items → card can be done
    db.prepare(
      "UPDATE kanban_cards SET status = 'done', review_status = NULL, completed_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, card.id);
    if (card.latest_dispatch_id) {
      db.prepare(
        "UPDATE task_dispatches SET status = 'completed', result_summary = 'Review decided — all rejected', completed_at = ? WHERE id = ? AND status IN ('pending','dispatched','in_progress','completed')",
      ).run(now, card.latest_dispatch_id);
    }
    emitKanbanCard(db, card.id, "kanban_card_updated");
    rewardKanbanCompletion(db, card.id);
    closeGitHubIssueOnDone(card);
    console.log(`[kanban-review] Card ${card.id} all dilemma items rejected → done`);
  }
}

/**
 * Transition card from review→requested with a rework dispatch.
 * Uses direct UPDATE instead of state machine since review→requested is not in standard transitions.
 */
function initiateRework(
  db: DatabaseSync,
  card: KanbanCardBaseRow,
  review: KanbanReviewRow,
  verdict: ReviewVerdict,
  rejectedItems: Array<ReviewVerdictItem & { decision?: string }>,
): void {
  ensurePcdRuntimeDirs();
  const reworkDispatchId = crypto.randomUUID();
  const now = Date.now();

  const acceptedSection = verdict.items
    .map((i, idx) => `${idx + 1}. [수용] ${i.summary}${i.suggestion ? `\n   제안: ${i.suggestion}` : ""}`)
    .join("\n");

  const rejectedSection = rejectedItems.length > 0
    ? rejectedItems
        .map((i, idx) => `${idx + 1}. [불수용] ${i.summary} — 이 항목은 수정하지 마세요.`)
        .join("\n")
    : "";

  const reworkInstructions = [
    `리뷰 딜레마에 대한 사용자 결정이 내려졌습니다.`,
    `리뷰 라운드: ${review.round}`,
    ``,
    `## 수용된 제안 (반드시 반영)`,
    acceptedSection || "(없음)",
    ...(rejectedSection ? [``, `## 불수용된 제안 (수정 금지)`, rejectedSection] : []),
    ``,
    `위 수용 항목을 반영한 뒤, 작업 완료 시 DoD를 다시 체크해 주세요.`,
  ].join("\n");

  const handoff = {
    dispatch_id: reworkDispatchId,
    from: card.requester_agent_id ?? card.assignee_agent_id,
    to: card.assignee_agent_id,
    type: "generic",
    title: `[Rework R${review.round}] ${card.title}`,
    parent_dispatch_id: review.review_dispatch_id,
    context: {
      summary: `Decided rework after review round ${review.round}: ${card.title}`,
      repo_path: process.cwd(),
    },
    review_context: {
      original_dispatch_id: review.original_dispatch_id,
      original_agent_id: review.original_agent_id,
      original_provider: review.original_provider,
      review_round: (review.round ?? 0) + 1,
    },
    instructions: reworkInstructions,
  };

  const chainDepth = (() => {
    if (!review.review_dispatch_id) return 0;
    const parent = db.prepare("SELECT chain_depth FROM task_dispatches WHERE id = ? LIMIT 1")
      .get(review.review_dispatch_id) as { chain_depth: number } | undefined;
    return (parent?.chain_depth ?? 0) + 1;
  })();

  db.prepare(
    `INSERT INTO task_dispatches (id, from_agent_id, to_agent_id, dispatch_type, status, title, context_file, parent_dispatch_id, chain_depth, created_at, dispatched_at)
     VALUES (?, ?, ?, 'generic', 'pending', ?, NULL, ?, ?, ?, NULL)`,
  ).run(
    reworkDispatchId,
    card.requester_agent_id ?? card.assignee_agent_id,
    card.assignee_agent_id,
    handoff.title,
    review.review_dispatch_id,
    chainDepth,
    now,
  );

  // Direct UPDATE: review → requested (bypasses state machine)
  db.prepare(
    `UPDATE kanban_cards
     SET status = 'requested',
         review_status = 'improve_rework',
         latest_dispatch_id = ?,
         requested_at = ?,
         started_at = NULL,
         completed_at = NULL,
         updated_at = ?
     WHERE id = ?`,
  ).run(reworkDispatchId, now, now, card.id);

  const fileName = `${now}-${reworkDispatchId}.json`;
  const filePath = path.join(PCD_HANDOFF_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(handoff, null, 2));

  emitKanbanCard(db, card.id, "kanban_card_updated");
  console.log(`[kanban-review] Decided rework dispatched: card=${card.id}, round=${review.round}`);
}

function postDecisionCommentOnGitHub(
  card: KanbanCardBaseRow,
  round: number,
  acceptedItems: Array<ReviewVerdictItem & { decision?: string }>,
  rejectedItems: Array<ReviewVerdictItem & { decision?: string }>,
): void {
  if (!card.github_repo || !card.github_issue_number) return;

  const lines = [
    `🗳️ **리뷰 딜레마 결정 (R${round})**`,
    ``,
  ];

  if (acceptedItems.length > 0) {
    lines.push(`### ✅ 수용`);
    for (const item of acceptedItems) {
      lines.push(`- ${item.summary}`);
    }
    lines.push("");
  }

  if (rejectedItems.length > 0) {
    lines.push(`### ❌ 불수용`);
    for (const item of rejectedItems) {
      lines.push(`- ${item.summary}`);
    }
    lines.push("");
  }

  const body = lines.join("\n");
  try {
    execFileSync("gh", [
      "issue", "comment", String(card.github_issue_number),
      "--repo", card.github_repo, "--body", body,
    ], { timeout: 15_000, stdio: "pipe" });
    console.log(`[kanban-review] Posted decision comment on ${card.github_repo}#${card.github_issue_number}`);
  } catch (e) {
    console.error(`[kanban-review] gh decision comment failed:`, (e as Error).message);
  }
}
