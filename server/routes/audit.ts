import { Router } from "express";
import { listAuditLogs } from "../audit-log.js";

const router = Router();

router.get("/api/audit-logs", (req, res) => {
  const rows = listAuditLogs({
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    entityType: typeof req.query.entityType === "string" ? req.query.entityType : undefined,
    entityId: typeof req.query.entityId === "string" ? req.query.entityId : undefined,
  });

  res.json({
    logs: rows.map((row) => ({
      ...row,
      metadata: (() => {
        if (!row.metadata_json) return null;
        try {
          return JSON.parse(row.metadata_json) as Record<string, unknown>;
        } catch {
          return null;
        }
      })(),
    })),
  });
});

export default router;
