import { Router } from "express";
import { getDb } from "../db/runtime.js";
import {
  listPipelineStages,
  upsertPipelineStages,
  deletePipelineStages,
  getCardPipelineStatus,
  getPipelineHistory,
} from "../pipeline.js";

const router = Router();

// List pipeline stages for a repo
router.get("/api/pipeline/stages", (req, res) => {
  const db = getDb();
  const repo = typeof req.query.repo === "string" ? req.query.repo : null;
  if (!repo) {
    res.status(400).json({ error: "repo query parameter required" });
    return;
  }
  const stages = listPipelineStages(db, repo);
  res.json({ stages });
});

// Upsert pipeline stages for a repo (replace all)
router.put("/api/pipeline/stages", (req, res) => {
  const db = getDb();
  const { repo, stages } = req.body ?? {};
  if (!repo || typeof repo !== "string") {
    res.status(400).json({ error: "repo is required" });
    return;
  }
  if (!Array.isArray(stages)) {
    res.status(400).json({ error: "stages must be an array" });
    return;
  }

  // Validate stages
  for (const [idx, stage] of stages.entries()) {
    if (!stage.stage_name || typeof stage.stage_name !== "string") {
      res.status(400).json({ error: `stages[${idx}].stage_name is required` });
      return;
    }
    if (stage.on_failure && !["fail", "retry", "previous", "goto"].includes(stage.on_failure)) {
      res.status(400).json({ error: `stages[${idx}].on_failure must be fail/retry/previous/goto` });
      return;
    }
  }

  const result = upsertPipelineStages(db, repo, stages);
  res.json({ stages: result });
});

// Delete pipeline stages for a repo
router.delete("/api/pipeline/stages", (req, res) => {
  const db = getDb();
  const repo = typeof req.query.repo === "string" ? req.query.repo : null;
  if (!repo) {
    res.status(400).json({ error: "repo query parameter required" });
    return;
  }
  deletePipelineStages(db, repo);
  res.json({ ok: true });
});

// Get pipeline status for a card
router.get("/api/pipeline/cards/:cardId", (req, res) => {
  const db = getDb();
  const status = getCardPipelineStatus(db, req.params.cardId);
  if (!status) {
    res.json({ stages: [], history: [], current_stage: null });
    return;
  }
  res.json(status);
});

// Get pipeline history for a card
router.get("/api/pipeline/cards/:cardId/history", (req, res) => {
  const db = getDb();
  const history = getPipelineHistory(db, req.params.cardId);
  res.json({ history });
});

export default router;
