import { Router } from "express";
import { getDb } from "../db/runtime.js";
import { syncKanbanCardWithDispatch } from "../kanban-cards.js";
import { broadcast } from "../ws.js";

const router = Router();

// List task dispatches
router.get("/api/dispatches", (req, res) => {
  const db = getDb();
  const { status, from_agent_id, to_agent_id, limit } = req.query;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(String(status));
  }
  if (from_agent_id) {
    conditions.push("from_agent_id = ?");
    params.push(String(from_agent_id));
  }
  if (to_agent_id) {
    conditions.push("to_agent_id = ?");
    params.push(String(to_agent_id));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitVal = Math.min(Math.max(parseInt(String(limit || "50"), 10), 1), 200);

  const rows = db
    .prepare(
      `SELECT * FROM task_dispatches ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limitVal);

  res.json({ dispatches: rows });
});

// Get single dispatch with chain info
router.get("/api/dispatches/:id", (req, res) => {
  const db = getDb();
  const dispatch = db
    .prepare("SELECT * FROM task_dispatches WHERE id = ?")
    .get(req.params.id);

  if (!dispatch) {
    res.status(404).json({ error: "Dispatch not found" });
    return;
  }

  // Get chain (all dispatches with same root)
  const chain = db
    .prepare(
      `WITH RECURSIVE chain AS (
         SELECT * FROM task_dispatches WHERE id = ?
         UNION ALL
         SELECT td.* FROM task_dispatches td
         JOIN chain c ON td.parent_dispatch_id = c.id
       )
       SELECT * FROM chain ORDER BY chain_depth ASC`,
    )
    .all(req.params.id);

  // Also get ancestors
  const d = dispatch as { parent_dispatch_id: string | null };
  const ancestors: unknown[] = [];
  let parentId = d.parent_dispatch_id;
  while (parentId) {
    const parent = db
      .prepare("SELECT * FROM task_dispatches WHERE id = ?")
      .get(parentId) as { parent_dispatch_id: string | null } | undefined;
    if (!parent) break;
    ancestors.unshift(parent);
    parentId = parent.parent_dispatch_id;
  }

  res.json({ dispatch, chain, ancestors });
});

// Manual dispatch creation
router.post("/api/dispatches", (req, res) => {
  const db = getDb();
  const { id, from_agent_id, to_agent_id, dispatch_type, title, parent_dispatch_id } =
    req.body;

  if (!id || !from_agent_id || !title) {
    res.status(400).json({ error: "id, from_agent_id, and title are required" });
    return;
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO task_dispatches (id, from_agent_id, to_agent_id, dispatch_type, status, title, parent_dispatch_id, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    from_agent_id,
    to_agent_id ?? null,
    dispatch_type || "generic",
    title,
    parent_dispatch_id ?? null,
    now,
  );

  const created = db.prepare("SELECT * FROM task_dispatches WHERE id = ?").get(id);
  broadcast("task_dispatch_created", created);
  syncKanbanCardWithDispatch(db, String(id));
  res.status(201).json(created);
});

// Update dispatch status (manual cancel, etc.)
router.patch("/api/dispatches/:id", (req, res) => {
  const db = getDb();
  const { status } = req.body;

  const existing = db
    .prepare("SELECT * FROM task_dispatches WHERE id = ?")
    .get(req.params.id);

  if (!existing) {
    res.status(404).json({ error: "Dispatch not found" });
    return;
  }

  const validStatuses = [
    "pending", "dispatched", "in_progress", "completed", "failed", "cancelled",
  ];
  if (status && !validStatuses.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    return;
  }

  const sets: string[] = [];
  const vals: (string | number | null)[] = [];

  if (status) {
    sets.push("status = ?");
    vals.push(status);
    if (status === "completed" || status === "failed" || status === "cancelled") {
      sets.push("completed_at = ?");
      vals.push(Date.now());
    }
  }

  if (sets.length === 0) {
    res.json(existing);
    return;
  }

  vals.push(req.params.id);
  db.prepare(`UPDATE task_dispatches SET ${sets.join(", ")} WHERE id = ?`).run(
    ...vals,
  );

  const updated = db
    .prepare("SELECT * FROM task_dispatches WHERE id = ?")
    .get(req.params.id);
  broadcast("task_dispatch_updated", updated);
  syncKanbanCardWithDispatch(db, req.params.id);
  res.json(updated);
});

export default router;
