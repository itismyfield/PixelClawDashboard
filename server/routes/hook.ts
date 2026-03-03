import { Router } from "express";
import crypto from "node:crypto";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";
import { reconcileAgentStatusOnce, syncAgentsOnce } from "../agent-sync.js";

const router = Router();

// OpenClaw hook: agent status update
router.patch("/api/hook/agent-status", (req, res) => {
  const db = getDb();
  const { openclaw_id, status, session_info } = req.body;
  if (!openclaw_id)
    return res.status(400).json({ error: "openclaw_id required" });

  const agent = db
    .prepare("SELECT * FROM agents WHERE openclaw_id = ?")
    .get(openclaw_id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: "agent_not_found" });

  const sets = ["status = ?"];
  const vals: (string | number | null)[] = [status ?? "idle"];
  if (session_info !== undefined) {
    sets.push("session_info = ?");
    vals.push(session_info);
  }
  vals.push(agent.id as string);
  db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(
    ...vals,
  );

  const updated = db
    .prepare(
      `SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
       FROM agents a LEFT JOIN departments d ON a.department_id = d.id
       WHERE a.id = ?`,
    )
    .get(agent.id as string);
  broadcast("agent_status", updated);
  res.json({ ok: true });
});

// Force sync OpenClaw agent list into PCD (upsert missing agents)
router.post("/api/hook/sync-agents", (_req, res) => {
  const created = syncAgentsOnce();
  const reconciled = reconcileAgentStatusOnce();
  res.json({ ok: true, created, reconciled });
});

// Reset all working agents to idle (called by gateway on startup)
router.post("/api/hook/reset-status", (_req, res) => {
  const db = getDb();
  const count = (
    db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE status = 'working'").get() as { cnt: number }
  ).cnt;
  if (count > 0) {
    db.exec("UPDATE agents SET status = 'idle' WHERE status = 'working'");
    broadcast("agent_status", { _reset: true });
    console.log(`[PCD] Hook reset: ${count} agent(s) → idle`);
  }
  res.json({ ok: true, reset: count });
});

// Dispatched session: register / heartbeat
router.post("/api/hook/session", (req, res) => {
  const db = getDb();
  const { session_key, name, model, status, session_info } = req.body;
  if (!session_key)
    return res.status(400).json({ error: "session_key required" });

  const existing = db
    .prepare("SELECT * FROM dispatched_sessions WHERE session_key = ?")
    .get(session_key) as Record<string, unknown> | undefined;

  if (existing) {
    // Heartbeat / update
    const sets = ["last_seen_at = ?"];
    const vals: (string | number | null)[] = [Date.now()];
    if (status) {
      sets.push("status = ?");
      vals.push(status);
    }
    if (session_info !== undefined) {
      sets.push("session_info = ?");
      vals.push(session_info);
    }
    if (model) {
      sets.push("model = ?");
      vals.push(model);
    }
    vals.push(existing.id as string);
    db.prepare(
      `UPDATE dispatched_sessions SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...vals);
    const updated = db
      .prepare("SELECT * FROM dispatched_sessions WHERE id = ?")
      .get(existing.id as string);
    broadcast("dispatched_session_update", updated);
    return res.json(updated);
  }

  // New session
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dispatched_sessions (id, session_key, name, model, status, session_info, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    session_key,
    name ?? `Session ${session_key.slice(0, 8)}`,
    model ?? null,
    status ?? "working",
    session_info ?? null,
    Date.now(),
  );
  const session = db
    .prepare("SELECT * FROM dispatched_sessions WHERE id = ?")
    .get(id);
  broadcast("dispatched_session_new", session);
  res.status(201).json(session);
});

// Dispatched session: disconnect
router.delete("/api/hook/session/:sessionKey", (req, res) => {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM dispatched_sessions WHERE session_key = ?")
    .get(req.params.sessionKey) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });

  db.prepare(
    "UPDATE dispatched_sessions SET status = 'disconnected', last_seen_at = ? WHERE id = ?",
  ).run(Date.now(), row.id as string);
  broadcast("dispatched_session_disconnect", { id: row.id });
  res.json({ ok: true });
});

export default router;
