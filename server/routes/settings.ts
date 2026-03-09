import { Router } from "express";
import { appendAuditLog, getAuditActor } from "../audit-log.js";
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
  appendAuditLog({
    actor: getAuditActor(req),
    action: "update",
    entityType: "settings",
    entityId: "global",
    summary: `Settings updated (${Object.keys(req.body).length})`,
    metadata: { keys: Object.keys(req.body) },
  });
  res.json({ ok: true });
});

export default router;
