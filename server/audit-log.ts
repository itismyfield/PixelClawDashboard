import crypto from "node:crypto";
import type { Request } from "express";
import { getDb } from "./db/runtime.js";

interface AppendAuditLogInput {
  actor?: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  metadata?: Record<string, unknown> | null;
}

export function getAuditActor(req: Request): string {
  const headerActor = req.headers["x-pcd-actor"];
  if (typeof headerActor === "string" && headerActor.trim()) {
    return headerActor.trim().slice(0, 80);
  }
  return "dashboard-session";
}

export function appendAuditLog({
  actor = "dashboard-session",
  action,
  entityType,
  entityId,
  summary,
  metadata = null,
}: AppendAuditLogInput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, summary, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    actor,
    action,
    entityType,
    entityId,
    summary,
    metadata ? JSON.stringify(metadata) : null,
    Date.now(),
  );
}

export function listAuditLogs(params?: {
  limit?: number;
  entityType?: string;
  entityId?: string;
}): Array<{
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  metadata_json: string | null;
  created_at: number;
}> {
  const db = getDb();
  const requestedLimit = Number.isFinite(params?.limit) ? (params?.limit as number) : 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 200);
  const conditions: string[] = [];
  const values: Array<string | number> = [];

  if (params?.entityType) {
    conditions.push("entity_type = ?");
    values.push(params.entityType);
  }
  if (params?.entityId) {
    conditions.push("entity_id = ?");
    values.push(params.entityId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT id, actor, action, entity_type, entity_id, summary, metadata_json, created_at
       FROM audit_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...values, limit) as Array<{
    id: string;
    actor: string;
    action: string;
    entity_type: string;
    entity_id: string;
    summary: string;
    metadata_json: string | null;
    created_at: number;
  }>;
}
