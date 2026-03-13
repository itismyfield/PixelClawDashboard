import { Router } from "express";
import { getDb } from "../db/runtime.js";
import {
  generateQueue,
  activateQueue,
  getQueueStatus,
  onCardTerminal,
} from "../auto-queue.js";

const router = Router();

// Generate a new auto-queue run (AI prioritization)
router.post("/api/auto-queue/generate", async (req, res) => {
  const db = getDb();
  const repo = typeof req.body?.repo === "string" ? req.body.repo : null;

  try {
    const result = await generateQueue(db, repo);
    res.json(result);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "no_ready_cards") {
      res.status(400).json({ error: "no_ready_cards", message: "No ready cards to queue" });
    } else if (msg === "no_assigned_ready_cards") {
      res.status(400).json({ error: "no_assigned_ready_cards", message: "No assigned ready cards to queue" });
    } else if (msg === "no_claude_token") {
      res.status(500).json({ error: "no_claude_token", message: "Claude API token not available" });
    } else {
      res.status(500).json({ error: "auto_queue_generate_failed", message: msg });
    }
  }
});

// Activate queue: dispatch first pending per agent
router.post("/api/auto-queue/activate", (_req, res) => {
  const db = getDb();
  try {
    const dispatched = activateQueue(db);
    res.json({ dispatched, count: dispatched.length });
  } catch (e) {
    res.status(500).json({ error: "auto_queue_activate_failed", message: (e as Error).message });
  }
});

// Get current queue status (optionally filtered by repo)
router.get("/api/auto-queue/status", (req, res) => {
  const db = getDb();
  const repo = typeof req.query.repo === "string" ? req.query.repo : null;
  try {
    const status = getQueueStatus(db, repo);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: "auto_queue_status_failed", message: (e as Error).message });
  }
});

// Skip a specific queue entry
router.patch("/api/auto-queue/entries/:id/skip", (req, res) => {
  const db = getDb();
  const now = Date.now();

  const entry = db.prepare(
    `SELECT id, status FROM dispatch_queue WHERE id = ? LIMIT 1`,
  ).get(req.params.id) as { id: string; status: string } | undefined;

  if (!entry) {
    res.status(404).json({ error: "entry_not_found" });
    return;
  }

  if (entry.status !== "pending") {
    res.status(400).json({ error: "entry_not_pending", message: `Entry status is '${entry.status}', can only skip pending entries` });
    return;
  }

  db.prepare(
    `UPDATE dispatch_queue SET status = 'skipped', completed_at = ? WHERE id = ?`,
  ).run(now, req.params.id);

  res.json({ ok: true, id: req.params.id });
});

// Pause/resume active run
router.patch("/api/auto-queue/runs/:id", (req, res) => {
  const db = getDb();
  const status = typeof req.body?.status === "string" ? req.body.status : null;

  if (!status || !["paused", "active", "completed"].includes(status)) {
    res.status(400).json({ error: "invalid_status", message: "Status must be 'paused', 'active', or 'completed'" });
    return;
  }

  const run = db.prepare(
    `SELECT id, status FROM auto_queue_runs WHERE id = ? LIMIT 1`,
  ).get(req.params.id) as { id: string; status: string } | undefined;

  if (!run) {
    res.status(404).json({ error: "run_not_found" });
    return;
  }

  const now = Date.now();
  db.prepare(
    `UPDATE auto_queue_runs SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END WHERE id = ?`,
  ).run(status, status, now, req.params.id);

  res.json({ ok: true, id: req.params.id, status });
});

// Reorder pending queue entries
router.patch("/api/auto-queue/reorder", (req, res) => {
  const db = getDb();
  const orderedIds = req.body?.orderedIds as string[] | undefined;
  const agentId = typeof req.body?.agentId === "string" ? req.body.agentId : null;

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    res.status(400).json({ error: "invalid_input", message: "orderedIds must be a non-empty array" });
    return;
  }

  // Verify all entries exist and are pending
  for (const id of orderedIds) {
    const entry = db.prepare(
      `SELECT id, status, agent_id FROM dispatch_queue WHERE id = ? LIMIT 1`,
    ).get(id) as { id: string; status: string; agent_id: string } | undefined;

    if (!entry) {
      res.status(404).json({ error: "entry_not_found", message: `Entry ${id} not found` });
      return;
    }
    if (entry.status !== "pending") {
      res.status(400).json({ error: "entry_not_pending", message: `Entry ${id} is '${entry.status}', only pending entries can be reordered` });
      return;
    }
    if (agentId && entry.agent_id !== agentId) {
      res.status(400).json({ error: "agent_mismatch", message: `Entry ${id} belongs to a different agent` });
      return;
    }
  }

  // Update priority_rank to match new order (1-based)
  const stmt = db.prepare(
    `UPDATE dispatch_queue SET priority_rank = ? WHERE id = ?`,
  );
  for (let i = 0; i < orderedIds.length; i++) {
    stmt.run(i + 1, orderedIds[i]);
  }

  res.json({ ok: true, reordered: orderedIds.length });
});

export default router;
