import { Router } from "express";
import { appendAuditLog, getAuditActor } from "../audit-log.js";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";

const router = Router();

router.get("/api/departments", (req, res) => {
  const db = getDb();
  const officeId = req.query.officeId as string | undefined;

  let rows;
  if (officeId) {
    rows = db
      .prepare(
        "SELECT * FROM departments WHERE office_id = ? ORDER BY sort_order",
      )
      .all(officeId);
  } else {
    rows = db
      .prepare("SELECT * FROM departments ORDER BY sort_order")
      .all();
  }

  // Agent counts — scoped to office if provided
  let counts: Array<{ department_id: string; cnt: number }>;
  if (officeId) {
    counts = db
      .prepare(
        `SELECT department_id, COUNT(*) as cnt FROM office_agents
         WHERE office_id = ? AND department_id IS NOT NULL
         GROUP BY department_id`,
      )
      .all(officeId) as Array<{ department_id: string; cnt: number }>;
  } else {
    counts = db
      .prepare(
        "SELECT department_id, COUNT(*) as cnt FROM agents WHERE department_id IS NOT NULL GROUP BY department_id",
      )
      .all() as Array<{ department_id: string; cnt: number }>;
  }
  const countMap = new Map(counts.map((c) => [c.department_id, c.cnt]));

  const departments = (rows as Array<Record<string, unknown>>).map((d) => ({
    ...d,
    agent_count: countMap.get(d.id as string) ?? 0,
  }));

  res.json({ departments });
});

router.get("/api/departments/:id", (req, res) => {
  const db = getDb();
  const dept = db
    .prepare("SELECT * FROM departments WHERE id = ?")
    .get(req.params.id);
  if (!dept) return res.status(404).json({ error: "not_found" });
  const agents = db
    .prepare("SELECT * FROM agents WHERE department_id = ?")
    .all(req.params.id);
  res.json({ ...(dept as object), agents });
});

router.post("/api/departments", (req, res) => {
  const db = getDb();
  const b = req.body;
  const id =
    b.id ||
    (b.name || "dept")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  db.prepare(
    `INSERT INTO departments (id, name, name_ko, name_ja, name_zh, icon, color, description, office_id, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    b.name ?? "",
    b.name_ko ?? "",
    b.name_ja ?? "",
    b.name_zh ?? "",
    b.icon ?? "",
    b.color ?? "#3b82f6",
    b.description ?? null,
    b.office_id ?? null,
    b.sort_order ?? 0,
  );

  const dept = db
    .prepare("SELECT * FROM departments WHERE id = ?")
    .get(id);
  appendAuditLog({
    actor: getAuditActor(req),
    action: "create",
    entityType: "department",
    entityId: id,
    summary: `Department created: ${String(b.name_ko || b.name || id)}`,
  });
  broadcast("departments_changed", {});
  res.status(201).json(dept);
});

router.patch("/api/departments/:id", (req, res) => {
  const db = getDb();
  const fields = [
    "name",
    "name_ko",
    "name_ja",
    "name_zh",
    "icon",
    "color",
    "description",
    "office_id",
    "sort_order",
  ];
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
  db.prepare(`UPDATE departments SET ${sets.join(", ")} WHERE id = ?`).run(
    ...vals,
  );
  broadcast("departments_changed", {});
  const dept = db
    .prepare("SELECT * FROM departments WHERE id = ?")
    .get(req.params.id);
  appendAuditLog({
    actor: getAuditActor(req),
    action: "update",
    entityType: "department",
    entityId: req.params.id,
    summary: `Department updated: ${String((dept as { name_ko?: string; name?: string } | undefined)?.name_ko || (dept as { name?: string } | undefined)?.name || req.params.id)}`,
    metadata: { fields: fields.filter((field) => field in req.body) },
  });
  res.json(dept);
});

router.patch("/api/departments/reorder", (req, res) => {
  const db = getDb();
  const order = req.body.order as Array<{ id: string; sort_order: number }>;
  if (!Array.isArray(order))
    return res.status(400).json({ error: "order required" });

  const stmt = db.prepare(
    "UPDATE departments SET sort_order = ? WHERE id = ?",
  );
  for (const item of order) {
    stmt.run(item.sort_order, item.id);
  }
  broadcast("departments_changed", {});
  res.json({ ok: true });
});

router.delete("/api/departments/:id", (req, res) => {
  const db = getDb();
  const dept = db
    .prepare("SELECT id, name, name_ko FROM departments WHERE id = ?")
    .get(req.params.id) as { id: string; name: string; name_ko: string } | undefined;
  // Check agent count via both agents.department_id and office_agents.department_id
  const agentCount = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM agents WHERE department_id = ?",
      )
      .get(req.params.id) as { cnt: number }
  ).cnt;
  const officeAgentCount = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM office_agents WHERE department_id = ?",
      )
      .get(req.params.id) as { cnt: number }
  ).cnt;
  if (agentCount > 0 || officeAgentCount > 0)
    return res.status(409).json({ error: "department_has_agents" });

  db.prepare("DELETE FROM departments WHERE id = ?").run(req.params.id);
  appendAuditLog({
    actor: getAuditActor(req),
    action: "delete",
    entityType: "department",
    entityId: req.params.id,
    summary: `Department deleted: ${dept?.name_ko || dept?.name || req.params.id}`,
  });
  broadcast("departments_changed", {});
  res.json({ ok: true });
});

export default router;
