import { Router } from "express";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";

const router = Router();

// List all offices
router.get("/api/offices", (_req, res) => {
  const db = getDb();
  const offices = db
    .prepare(
      `SELECT o.*,
        (SELECT COUNT(*) FROM office_agents oa WHERE oa.office_id = o.id) as agent_count,
        (SELECT COUNT(*) FROM departments d WHERE d.office_id = o.id) as department_count
       FROM offices o ORDER BY o.sort_order`,
    )
    .all();
  res.json({ offices });
});

// Get single office with its agents and departments
router.get("/api/offices/:id", (req, res) => {
  const db = getDb();
  const office = db
    .prepare("SELECT * FROM offices WHERE id = ?")
    .get(req.params.id);
  if (!office) return res.status(404).json({ error: "not_found" });

  const agents = db
    .prepare(
      `SELECT a.*, oa.department_id as office_department_id, oa.joined_at,
              d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
       FROM office_agents oa
       JOIN agents a ON a.id = oa.agent_id
       LEFT JOIN departments d ON d.id = oa.department_id
       WHERE oa.office_id = ?
       ORDER BY a.name`,
    )
    .all(req.params.id);

  const departments = db
    .prepare(
      "SELECT * FROM departments WHERE office_id = ? ORDER BY sort_order",
    )
    .all(req.params.id);

  res.json({ ...(office as object), agents, departments });
});

// Create office
router.post("/api/offices", (req, res) => {
  const db = getDb();
  const b = req.body;
  const id =
    b.id ||
    (b.name || "office")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") ||
    `office-${Date.now()}`;

  // Ensure unique id
  const existing = db.prepare("SELECT id FROM offices WHERE id = ?").get(id);
  const finalId = existing ? `${id}-${Date.now()}` : id;

  db.prepare(
    `INSERT INTO offices (id, name, name_ko, icon, color, description, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    finalId,
    b.name ?? "",
    b.name_ko ?? "",
    b.icon ?? "🏢",
    b.color ?? "#6366f1",
    b.description ?? null,
    b.sort_order ?? 0,
  );

  const office = db.prepare("SELECT * FROM offices WHERE id = ?").get(finalId);
  broadcast("offices_changed", {});
  res.status(201).json(office);
});

// Update office
router.patch("/api/offices/:id", (req, res) => {
  const db = getDb();
  const fields = ["name", "name_ko", "icon", "color", "description", "sort_order"];
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const f of fields) {
    if (f in req.body) {
      sets.push(`${f} = ?`);
      vals.push(req.body[f]);
    }
  }
  if (sets.length === 0) return res.json({ ok: true });

  vals.push(req.params.id);
  db.prepare(`UPDATE offices SET ${sets.join(", ")} WHERE id = ?`).run(
    ...vals,
  );
  broadcast("offices_changed", {});
  const office = db.prepare("SELECT * FROM offices WHERE id = ?").get(req.params.id);
  res.json(office);
});

// Delete office
router.delete("/api/offices/:id", (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM offices WHERE id = ?").run(req.params.id);
  broadcast("offices_changed", {});
  res.json({ ok: true });
});

// ── Agent assignment ──

// Add agent to office
router.post("/api/offices/:id/agents", (req, res) => {
  const db = getDb();
  const { agent_id, department_id } = req.body;
  if (!agent_id) return res.status(400).json({ error: "agent_id required" });

  db.prepare(
    "INSERT OR REPLACE INTO office_agents (office_id, agent_id, department_id) VALUES (?, ?, ?)",
  ).run(req.params.id, agent_id, department_id ?? null);

  broadcast("offices_changed", {});
  res.json({ ok: true });
});

// Batch add agents to office
router.post("/api/offices/:id/agents/batch", (req, res) => {
  const db = getDb();
  const { agent_ids } = req.body;
  if (!Array.isArray(agent_ids))
    return res.status(400).json({ error: "agent_ids required" });

  const stmt = db.prepare(
    "INSERT OR IGNORE INTO office_agents (office_id, agent_id) VALUES (?, ?)",
  );
  for (const agentId of agent_ids) {
    stmt.run(req.params.id, agentId);
  }
  broadcast("offices_changed", {});
  res.json({ ok: true });
});

// Remove agent from office
router.delete("/api/offices/:id/agents/:agentId", (req, res) => {
  const db = getDb();
  db.prepare(
    "DELETE FROM office_agents WHERE office_id = ? AND agent_id = ?",
  ).run(req.params.id, req.params.agentId);
  broadcast("offices_changed", {});
  res.json({ ok: true });
});

// Update agent's department within office
router.patch("/api/offices/:id/agents/:agentId", (req, res) => {
  const db = getDb();
  const { department_id } = req.body;
  db.prepare(
    "UPDATE office_agents SET department_id = ? WHERE office_id = ? AND agent_id = ?",
  ).run(department_id ?? null, req.params.id, req.params.agentId);
  broadcast("offices_changed", {});
  res.json({ ok: true });
});

export default router;
