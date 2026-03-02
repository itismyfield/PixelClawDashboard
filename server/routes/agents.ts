import { Router } from "express";
import crypto from "node:crypto";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";

const router = Router();

router.get("/api/agents", (req, res) => {
  const db = getDb();
  const officeId = req.query.officeId as string | undefined;

  let rows;
  if (officeId) {
    // Return agents in a specific office, with their office-specific department
    rows = db
      .prepare(
        `SELECT a.*, oa.department_id as office_department_id,
                d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
         FROM office_agents oa
         JOIN agents a ON a.id = oa.agent_id
         LEFT JOIN departments d ON d.id = oa.department_id
         WHERE oa.office_id = ?
         ORDER BY a.created_at`,
      )
      .all(officeId);
  } else {
    rows = db
      .prepare(
        `SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
         FROM agents a LEFT JOIN departments d ON a.department_id = d.id
         ORDER BY a.created_at`,
      )
      .all();
  }
  res.json({ agents: rows });
});

router.get("/api/agents/:id", (req, res) => {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
       FROM agents a LEFT JOIN departments d ON a.department_id = d.id
       WHERE a.id = ?`,
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(row);
});

router.post("/api/agents", (req, res) => {
  const db = getDb();
  const id = crypto.randomUUID();
  const b = req.body;
  db.prepare(
    `INSERT INTO agents (id, openclaw_id, name, name_ko, name_ja, name_zh,
      department_id, role, avatar_emoji, sprite_number, personality, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    b.openclaw_id ?? null,
    b.name ?? "",
    b.name_ko ?? "",
    b.name_ja ?? "",
    b.name_zh ?? "",
    b.department_id ?? null,
    b.role ?? "senior",
    b.avatar_emoji ?? "🙂",
    b.sprite_number ?? null,
    b.personality ?? null,
    b.status ?? "idle",
  );

  // If office_id provided, also assign to that office
  if (b.office_id) {
    db.prepare(
      "INSERT OR IGNORE INTO office_agents (office_id, agent_id, department_id) VALUES (?, ?, ?)",
    ).run(b.office_id, id, b.department_id ?? null);
  }

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  broadcast("agent_created", agent);
  res.status(201).json(agent);
});

router.patch("/api/agents/:id", (req, res) => {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM agents WHERE id = ?")
    .get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not_found" });

  const fields = [
    "name",
    "name_ko",
    "name_ja",
    "name_zh",
    "department_id",
    "role",
    "avatar_emoji",
    "sprite_number",
    "personality",
    "status",
    "session_info",
    "stats_tasks_done",
    "stats_xp",
    "openclaw_id",
  ];
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const f of fields) {
    if (f in req.body) {
      sets.push(`${f} = ?`);
      vals.push(req.body[f]);
    }
  }
  if (sets.length === 0) return res.json(existing);

  vals.push(req.params.id);
  db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(
    ...vals,
  );

  const updated = db
    .prepare(
      `SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
       FROM agents a LEFT JOIN departments d ON a.department_id = d.id
       WHERE a.id = ?`,
    )
    .get(req.params.id);
  broadcast("agent_status", updated);
  res.json(updated);
});

router.delete("/api/agents/:id", (req, res) => {
  const db = getDb();
  // office_agents cascade-deletes automatically
  db.prepare("DELETE FROM agents WHERE id = ?").run(req.params.id);
  broadcast("agent_deleted", { id: req.params.id });
  res.json({ ok: true });
});

export default router;
