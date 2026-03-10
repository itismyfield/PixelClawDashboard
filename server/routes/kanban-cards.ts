import { Router } from "express";
import crypto from "node:crypto";
import { appendAuditLog, getAuditActor } from "../audit-log.js";
import { getDb } from "../db/runtime.js";
import {
  calculateSortOrder,
  createDispatchForKanbanCard,
  emitKanbanCard,
  emitKanbanCardDeleted,
  getKanbanCardById,
  getRawKanbanCardById,
  parseKanbanCardMetadata,
  KANBAN_CARD_PRIORITIES,
  KANBAN_CARD_STATUSES,
  listKanbanCards,
  retryKanbanCard,
  rewardKanbanCompletion,
} from "../kanban-cards.js";
import { broadcast } from "../ws.js";

const router = Router();

function isKanbanStatus(value: string): value is typeof KANBAN_CARD_STATUSES[number] {
  return (KANBAN_CARD_STATUSES as readonly string[]).includes(value);
}

function isKanbanPriority(value: string): value is typeof KANBAN_CARD_PRIORITIES[number] {
  return (KANBAN_CARD_PRIORITIES as readonly string[]).includes(value);
}

function normalizeNullableText(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeNullableInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function normalizeMetadataJson(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return JSON.stringify(value);
}

function normalizeGitHubRepo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : null;
}

router.get("/api/kanban-cards", (req, res) => {
  const db = getDb();
  const cards = listKanbanCards(db, {
    status: typeof req.query.status === "string" ? req.query.status : null,
    github_repo: typeof req.query.github_repo === "string" ? req.query.github_repo : null,
    assignee_agent_id: typeof req.query.assignee_agent_id === "string" ? req.query.assignee_agent_id : null,
    requester_agent_id: typeof req.query.requester_agent_id === "string" ? req.query.requester_agent_id : null,
    limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
  });
  res.json({ cards });
});

router.post("/api/kanban-cards/assign-issue", (req, res) => {
  const db = getDb();
  const repo = normalizeGitHubRepo(req.body?.github_repo);
  const issueNumber = normalizeNullableInteger(req.body?.github_issue_number);
  const issueUrl = normalizeNullableText(req.body?.github_issue_url);
  const assigneeId = normalizeNullableText(req.body?.assignee_agent_id);
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const description = normalizeNullableText(req.body?.description);
  const now = Date.now();

  if (!repo) {
    res.status(400).json({ error: "github_repo is required" });
    return;
  }
  if (!issueNumber) {
    res.status(400).json({ error: "github_issue_number is required" });
    return;
  }
  if (!assigneeId) {
    res.status(400).json({ error: "assignee_agent_id is required" });
    return;
  }
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const existing = db.prepare(
    `SELECT id, status
     FROM kanban_cards
     WHERE github_repo = ?
       AND github_issue_number = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get(repo, issueNumber) as { id: string; status: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE kanban_cards
       SET title = ?,
           description = COALESCE(?, description),
           assignee_agent_id = ?,
           owner_agent_id = COALESCE(owner_agent_id, ?),
           requester_agent_id = COALESCE(requester_agent_id, ?),
           github_issue_url = COALESCE(?, github_issue_url),
           status = CASE WHEN status = 'backlog' THEN 'ready' ELSE status END,
           updated_at = ?
       WHERE id = ?`,
    ).run(title, description, assigneeId, assigneeId, assigneeId, issueUrl, now, existing.id);

    const updated = emitKanbanCard(db, existing.id, "kanban_card_updated");
    if (!updated) {
      res.status(404).json({ error: "kanban_card_not_found" });
      return;
    }

    appendAuditLog({
      actor: getAuditActor(req),
      action: "assign_issue",
      entityType: "kanban_card",
      entityId: existing.id,
      summary: `GitHub issue assigned: ${repo}#${issueNumber}`,
      metadata: { github_repo: repo, github_issue_number: issueNumber, assignee_agent_id: assigneeId },
    });
    res.json(updated);
    return;
  }

  const id = crypto.randomUUID();
  const sortOrder = calculateSortOrder(db, "ready", undefined);
  db.prepare(
    `INSERT INTO kanban_cards (
      id, title, description, status, github_repo, owner_agent_id, requester_agent_id, assignee_agent_id,
      parent_card_id, latest_dispatch_id, sort_order, priority, depth, blocked_reason, review_notes,
      github_issue_number, github_issue_url, metadata_json, created_at, updated_at, started_at,
      requested_at, completed_at
    )
    VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, NULL, NULL, ?, 'medium', 0, NULL, NULL, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`,
  ).run(
    id,
    title,
    description,
    repo,
    assigneeId,
    assigneeId,
    assigneeId,
    sortOrder,
    issueNumber,
    issueUrl,
    now,
    now,
  );

  const created = emitKanbanCard(db, id, "kanban_card_created");
  if (!created) {
    res.status(500).json({ error: "kanban_card_create_failed" });
    return;
  }

  appendAuditLog({
    actor: getAuditActor(req),
    action: "assign_issue",
    entityType: "kanban_card",
    entityId: id,
    summary: `GitHub issue assigned: ${repo}#${issueNumber}`,
    metadata: { github_repo: repo, github_issue_number: issueNumber, assignee_agent_id: assigneeId },
  });

  res.status(201).json(created);
});

router.get("/api/kanban-cards/:id", (req, res) => {
  const db = getDb();
  const card = getKanbanCardById(db, req.params.id);
  if (!card) {
    res.status(404).json({ error: "kanban_card_not_found" });
    return;
  }
  const children = listKanbanCards(db, { limit: 1000 }).filter((row) => row.parent_card_id === req.params.id);
  res.json({ card, children });
});

router.post("/api/kanban-cards/:id/retry", (req, res) => {
  const db = getDb();
  try {
    const card = retryKanbanCard(db, req.params.id, {
      assignee_agent_id: normalizeNullableText(req.body?.assignee_agent_id),
      request_now: req.body?.request_now !== false,
    });
    appendAuditLog({
      actor: getAuditActor(req),
      action: "retry",
      entityType: "kanban_card",
      entityId: req.params.id,
      summary: `Kanban card retried: ${card.title}`,
      metadata: {
        assignee_agent_id: card.assignee_agent_id,
        status: card.status,
      },
    });
    res.json(card);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "kanban_card_retry_failed" });
  }
});

router.post("/api/kanban-cards", (req, res) => {
  const db = getDb();
  const {
    title,
    description,
    status,
    owner_agent_id,
    requester_agent_id,
    assignee_agent_id,
    parent_card_id,
    before_card_id,
    priority,
    blocked_reason,
    review_notes,
    github_repo,
    github_issue_number,
    github_issue_url,
    metadata_json,
  } = req.body ?? {};

  const normalizedTitle = typeof title === "string" ? title.trim() : "";
  if (!normalizedTitle) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const desiredStatus = typeof status === "string" ? status : "ready";
  if (!isKanbanStatus(desiredStatus)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${KANBAN_CARD_STATUSES.join(", ")}` });
    return;
  }
  const desiredStatusTyped = desiredStatus;

  const normalizedPriority = typeof priority === "string" ? priority : "medium";
  if (!isKanbanPriority(normalizedPriority)) {
    res.status(400).json({ error: `Invalid priority. Must be one of: ${KANBAN_CARD_PRIORITIES.join(", ")}` });
    return;
  }
  const normalizedPriorityTyped = normalizedPriority;

  const initialStatus = desiredStatusTyped === "requested" ? "ready" : desiredStatusTyped;
  const sortOrder = calculateSortOrder(db, initialStatus, normalizeNullableText(before_card_id) ?? undefined);
  const now = Date.now();
  const id = crypto.randomUUID();
  const parentId = normalizeNullableText(parent_card_id);
  const githubRepo = normalizeGitHubRepo(github_repo);
  const baseMetadata = normalizeMetadataJson(metadata_json);
  const requesterId = normalizeNullableText(requester_agent_id);
  const assigneeId = normalizeNullableText(assignee_agent_id);
  const ownerId = normalizeNullableText(owner_agent_id) ?? requesterId ?? assigneeId;
  const normalizedDescription = normalizeNullableText(description);

  db.prepare(
    `INSERT INTO kanban_cards (
      id, title, description, status, github_repo, owner_agent_id, requester_agent_id, assignee_agent_id,
      parent_card_id, latest_dispatch_id, sort_order, priority, depth, blocked_reason, review_notes,
      github_issue_number, github_issue_url, metadata_json, created_at, updated_at, started_at,
      requested_at, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    normalizedTitle,
    normalizedDescription,
    initialStatus,
    githubRepo,
    ownerId,
    requesterId,
    assigneeId,
    parentId,
    sortOrder,
    normalizedPriorityTyped,
    parentId
      ? ((db.prepare("SELECT depth FROM kanban_cards WHERE id = ?").get(parentId) as { depth: number } | undefined)?.depth ?? 0) + 1
      : 0,
    normalizeNullableText(blocked_reason),
    normalizeNullableText(review_notes),
    normalizeNullableInteger(github_issue_number),
    normalizeNullableText(github_issue_url),
    baseMetadata,
    now,
    now,
    initialStatus === "in_progress" ? now : null,
    null,
    ["done", "failed", "cancelled"].includes(initialStatus) ? now : null,
  );

  const created = emitKanbanCard(db, id, "kanban_card_created");
  if (!created) {
    res.status(500).json({ error: "kanban_card_create_failed" });
    return;
  }

  appendAuditLog({
    actor: getAuditActor(req),
    action: "create",
    entityType: "kanban_card",
    entityId: id,
    summary: `Kanban card created: ${normalizedTitle}`,
    metadata: {
      status: initialStatus,
      requester_agent_id: requesterId,
      assignee_agent_id: assigneeId,
    },
  });

  try {
    const finalCard = desiredStatusTyped === "requested"
      ? createDispatchForKanbanCard(db, id)
      : created;
    res.status(201).json(finalCard);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "kanban_card_request_failed" });
  }
});

router.patch("/api/kanban-cards/:id", (req, res) => {
  const db = getDb();
  const existing = getRawKanbanCardById(db, req.params.id);

  if (!existing) {
    res.status(404).json({ error: "kanban_card_not_found" });
    return;
  }

  const beforeCardId = normalizeNullableText(req.body?.before_card_id);
  const targetCard = beforeCardId
    ? (db.prepare(
      `SELECT id, status
       FROM kanban_cards
       WHERE id = ?
       LIMIT 1`,
    ).get(beforeCardId) as { id: string; status: string } | undefined)
    : undefined;
  const desiredStatusValue = typeof req.body?.status === "string"
    ? req.body.status
    : targetCard?.status ?? existing.status;

  if (!isKanbanStatus(desiredStatusValue)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${KANBAN_CARD_STATUSES.join(", ")}` });
    return;
  }
  const desiredStatus = desiredStatusValue;

  const desiredPriority = typeof req.body?.priority === "string" ? req.body.priority : existing.priority;
  if (!isKanbanPriority(desiredPriority)) {
    res.status(400).json({ error: `Invalid priority. Must be one of: ${KANBAN_CARD_PRIORITIES.join(", ")}` });
    return;
  }
  const desiredPriorityTyped = desiredPriority;
  const intendedMetadataJson = "metadata_json" in (req.body ?? {})
    ? normalizeMetadataJson(req.body.metadata_json)
    : existing.metadata_json;
  const intendedMetadata = parseKanbanCardMetadata(intendedMetadataJson);

  if (desiredStatus === "done" && intendedMetadata.review_checklist?.some((item) => !item.done)) {
    res.status(400).json({ error: "review_checklist_incomplete" });
    return;
  }

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  const changedFields: string[] = [];
  const pushField = (field: string, value: string | number | null) => {
    sets.push(`${field} = ?`);
    vals.push(value);
    changedFields.push(field);
  };

  const textFields = [
    "title",
    "description",
    "owner_agent_id",
    "requester_agent_id",
    "assignee_agent_id",
    "parent_card_id",
    "blocked_reason",
    "review_notes",
    "github_repo",
    "github_issue_url",
  ] as const;

  for (const field of textFields) {
    if (field in (req.body ?? {})) {
      const normalized = field === "title"
        ? (typeof req.body[field] === "string" ? req.body[field].trim() : "")
        : field === "github_repo"
          ? normalizeGitHubRepo(req.body[field])
          : normalizeNullableText(req.body[field]);
      if (field === "title" && !normalized) {
        res.status(400).json({ error: "title is required" });
        return;
      }
      if (normalized !== existing[field]) {
        pushField(field, normalized);
      }
    }
  }

  if ("github_issue_number" in (req.body ?? {})) {
    const normalizedIssueNumber = normalizeNullableInteger(req.body.github_issue_number);
    if (normalizedIssueNumber !== existing.github_issue_number) {
      pushField("github_issue_number", normalizedIssueNumber);
    }
  }

  if ("metadata_json" in (req.body ?? {})) {
    if (intendedMetadataJson !== existing.metadata_json) {
      pushField("metadata_json", intendedMetadataJson);
    }
  }

  if (desiredPriorityTyped !== existing.priority) {
    pushField("priority", desiredPriorityTyped);
  }
  const needsSortRecalc = beforeCardId !== null || desiredStatus !== existing.status;
  if (needsSortRecalc) {
    const nextSortOrder = calculateSortOrder(db, desiredStatus, beforeCardId ?? undefined, existing.id);
    if (desiredStatus !== existing.status) {
      pushField("status", desiredStatus);
    }
    if (nextSortOrder !== existing.sort_order) {
      pushField("sort_order", nextSortOrder);
    }
  }

  const now = Date.now();
  if (desiredStatus === "requested" && existing.status !== "requested") {
    pushField("requested_at", now);
    pushField("started_at", null);
    pushField("completed_at", null);
  } else if (desiredStatus === "in_progress" && !existing.started_at) {
    pushField("started_at", now);
  } else if (["done", "failed", "cancelled"].includes(desiredStatus)) {
    pushField("completed_at", now);
  } else if (["backlog", "ready", "requested", "in_progress", "blocked", "review"].includes(desiredStatus) && existing.completed_at) {
    pushField("completed_at", null);
  }

  if (sets.length > 0) {
    sets.push("updated_at = ?");
    vals.push(now);
    vals.push(req.params.id);
    db.prepare(
      `UPDATE kanban_cards
       SET ${sets.join(", ")}
       WHERE id = ?`,
    ).run(...vals);
  }

  try {
    let finalCard = getKanbanCardById(db, req.params.id);
    if (!finalCard) {
      res.status(404).json({ error: "kanban_card_not_found" });
      return;
    }

    if (desiredStatus === "requested" && existing.status !== "requested") {
      finalCard = createDispatchForKanbanCard(db, req.params.id);
    } else {
      if (finalCard.latest_dispatch_id) {
        const latestDispatch = db.prepare(
          `SELECT *
           FROM task_dispatches
           WHERE id = ?
           LIMIT 1`,
        ).get(finalCard.latest_dispatch_id) as {
          id: string;
          status: "pending" | "dispatched" | "in_progress" | "completed" | "failed" | "cancelled";
        } | undefined;

        const desiredDispatchStatus =
          desiredStatus === "in_progress"
            ? "in_progress"
            : desiredStatus === "review" || desiredStatus === "done"
              ? "completed"
              : desiredStatus === "failed"
                ? "failed"
                : desiredStatus === "cancelled"
                  ? "cancelled"
                  : null;

        if (latestDispatch && desiredDispatchStatus && latestDispatch.status !== desiredDispatchStatus) {
          db.prepare(
            `UPDATE task_dispatches
             SET status = ?,
                 completed_at = CASE
                   WHEN ? IN ('completed','failed','cancelled') THEN COALESCE(completed_at, ?)
                   ELSE completed_at
                 END
             WHERE id = ?`,
          ).run(desiredDispatchStatus, desiredDispatchStatus, now, latestDispatch.id);

          const updatedDispatch = db.prepare(
            `SELECT *
             FROM task_dispatches
             WHERE id = ?
             LIMIT 1`,
          ).get(latestDispatch.id);
          broadcast("task_dispatch_updated", updatedDispatch);
        }
      }

      finalCard = emitKanbanCard(db, req.params.id, "kanban_card_updated");
      if (!finalCard) {
        res.status(404).json({ error: "kanban_card_not_found" });
        return;
      }
    }

    if (changedFields.length > 0 || desiredStatus !== existing.status || beforeCardId !== null) {
      appendAuditLog({
        actor: getAuditActor(req),
        action: "update",
        entityType: "kanban_card",
        entityId: req.params.id,
        summary: `Kanban card updated: ${finalCard.title}`,
        metadata: {
          fields: Array.from(new Set(changedFields.concat(needsSortRecalc ? ["sort_order"] : []))),
          status: finalCard.status,
        },
      });
    }

    if (finalCard.status === "done") {
      finalCard = rewardKanbanCompletion(db, finalCard.id) ?? finalCard;
    }

    res.json(finalCard);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "kanban_card_update_failed" });
  }
});

router.delete("/api/kanban-cards/:id", (req, res) => {
  const db = getDb();
  const existing = getRawKanbanCardById(db, req.params.id);
  if (!existing) {
    res.status(404).json({ error: "kanban_card_not_found" });
    return;
  }

  db.prepare("DELETE FROM kanban_cards WHERE id = ?").run(req.params.id);
  emitKanbanCardDeleted(req.params.id);
  appendAuditLog({
    actor: getAuditActor(req),
    action: "delete",
    entityType: "kanban_card",
    entityId: req.params.id,
    summary: `Kanban card deleted: ${existing.title}`,
  });
  res.json({ ok: true });
});

export default router;
