import { Router } from "express";
import { appendAuditLog, getAuditActor } from "../audit-log.js";
import { getDb } from "../db/runtime.js";
import {
  getRuntimeConfig,
  invalidateRuntimeConfigCache,
  RUNTIME_CONFIG_DEFAULTS,
  type RuntimeConfig,
} from "../runtime-config.js";

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
  // If runtimeConfig was updated, invalidate the in-memory cache
  if ("runtimeConfig" in req.body) {
    invalidateRuntimeConfigCache();
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

// ── Runtime Config API ──

router.get("/api/settings/runtime-config", (_req, res) => {
  res.json({
    current: getRuntimeConfig(),
    defaults: RUNTIME_CONFIG_DEFAULTS,
  });
});

router.put("/api/settings/runtime-config", (req, res) => {
  const patch = req.body as Partial<RuntimeConfig>;

  // Validate numeric fields
  for (const [key, val] of Object.entries(patch)) {
    if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
      res.status(400).json({ error: `Invalid value for ${key}: must be a non-negative number` });
      return;
    }
  }

  // Merge with current config
  const current = getRuntimeConfig();
  const merged = { ...current, ...patch };

  // Save to DB
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    "runtimeConfig",
    JSON.stringify(merged),
  );
  invalidateRuntimeConfigCache();

  appendAuditLog({
    actor: getAuditActor(req),
    action: "update",
    entityType: "settings",
    entityId: "runtimeConfig",
    summary: `Runtime config updated: ${Object.keys(patch).join(", ")}`,
    metadata: { changed: patch },
  });

  res.json({ ok: true, config: merged });
});

export default router;
