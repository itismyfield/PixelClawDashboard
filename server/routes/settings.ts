import { Router } from "express";
import { getDb } from "../db/runtime.js";

const router = Router();

router.get("/api/settings", (_req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  const settings: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      settings[r.key] = JSON.parse(r.value);
    } catch {
      settings[r.key] = r.value;
    }
  }
  res.json(settings);
});

router.put("/api/settings", (req, res) => {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  );
  for (const [key, value] of Object.entries(req.body)) {
    const v = typeof value === "string" ? value : JSON.stringify(value);
    stmt.run(key, v);
  }
  res.json({ ok: true });
});

router.get("/api/stats", (_req, res) => {
  const db = getDb();

  const agentRows = db
    .prepare("SELECT status, COUNT(*) as cnt FROM agents GROUP BY status")
    .all() as Array<{ status: string; cnt: number }>;
  const agentStats: Record<string, number> = {
    total: 0,
    working: 0,
    idle: 0,
    break: 0,
    offline: 0,
  };
  for (const r of agentRows) {
    agentStats[r.status] = r.cnt;
    agentStats.total += r.cnt;
  }

  const topAgents = db
    .prepare(
      `SELECT id, name, name_ko, avatar_emoji, stats_tasks_done, stats_xp
       FROM agents ORDER BY stats_xp DESC LIMIT 10`,
    )
    .all();

  const deptStats = db
    .prepare(
      `SELECT d.id, d.name, d.name_ko, d.icon, d.color,
              COUNT(a.id) as total_agents,
              SUM(CASE WHEN a.status = 'working' THEN 1 ELSE 0 END) as working_agents
       FROM departments d
       LEFT JOIN agents a ON a.department_id = d.id
       GROUP BY d.id
       ORDER BY d.sort_order`,
    )
    .all();

  const dispatchedCount = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM dispatched_sessions WHERE status != 'disconnected'",
      )
      .get() as { cnt: number }
  ).cnt;

  res.json({
    agents: agentStats,
    top_agents: topAgents,
    departments: deptStats,
    dispatched_count: dispatchedCount,
  });
});

export default router;
