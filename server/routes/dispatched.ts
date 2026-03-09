import { Router } from "express";
import { appendAuditLog, getAuditActor } from "../audit-log.js";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";

const router = Router();

// List active dispatched sessions (default: unmerged only)
router.get("/api/dispatched-sessions", (req, res) => {
  const db = getDb();
  const includeMerged = String(req.query.includeMerged || "0") === "1";
  const where = includeMerged
    ? "WHERE ds.status != 'disconnected'"
    : "WHERE ds.status != 'disconnected' AND ds.linked_agent_id IS NULL";

  const rows = db
    .prepare(
      `SELECT ds.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
       FROM dispatched_sessions ds
       LEFT JOIN departments d ON ds.department_id = d.id
       ${where}
       ORDER BY ds.connected_at DESC`,
    )
    .all();
  res.json({ sessions: rows });
});

// Assign dispatched session to department
router.patch("/api/dispatched-sessions/:id", (req, res) => {
  const db = getDb();
  const { department_id, name, sprite_number, avatar_emoji } = req.body;

  const sets: string[] = [];
  const vals: (string | number | null)[] = [];

  if (department_id !== undefined) {
    sets.push("department_id = ?");
    vals.push(department_id);
  }
  if (name !== undefined) {
    sets.push("name = ?");
    vals.push(name);
  }
  if (sprite_number !== undefined) {
    sets.push("sprite_number = ?");
    vals.push(sprite_number);
  }
  if (avatar_emoji !== undefined) {
    sets.push("avatar_emoji = ?");
    vals.push(avatar_emoji);
  }

  if (sets.length === 0) return res.json({ ok: true });

  vals.push(req.params.id);
  db.prepare(
    `UPDATE dispatched_sessions SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...vals);

  const updated = db
    .prepare(
      `SELECT ds.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
       FROM dispatched_sessions ds
       LEFT JOIN departments d ON ds.department_id = d.id
       WHERE ds.id = ?`,
    )
    .get(req.params.id);
  appendAuditLog({
    actor: getAuditActor(req),
    action: "update",
    entityType: "dispatched_session",
    entityId: req.params.id,
    summary: `Dispatched session updated: ${req.params.id}`,
    metadata: { fields: Object.keys(req.body) },
  });
  broadcast("dispatched_session_update", updated);
  res.json(updated);
});

// Dismiss (remove disconnected sessions)
router.delete("/api/dispatched-sessions/cleanup", (_req, res) => {
  const db = getDb();
  db.prepare(
    "DELETE FROM dispatched_sessions WHERE status = 'disconnected'",
  ).run();
  res.json({ ok: true });
});

export default router;
