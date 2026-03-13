import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { broadcast } from "./ws.js";
import { createDispatchForKanbanCard, emitKanbanCard, getRawKanbanCardById, rewardKanbanCompletion, closeGitHubIssueOnDone } from "./kanban-cards.js";
import { onCardTerminal } from "./auto-queue.js";

// ── Types ──

export interface PipelineStage {
  id: string;
  repo: string;
  stage_name: string;
  stage_order: number;
  entry_skill: string | null;
  provider: string | null;
  agent_override_id: string | null;
  timeout_minutes: number;
  on_failure: "fail" | "retry" | "previous" | "goto";
  on_failure_target: string | null;
  max_retries: number;
  skip_condition: string | null;
  parallel_with: string | null;
  created_at: number;
}

export interface PipelineHistoryEntry {
  id: string;
  card_id: string;
  stage_id: string;
  stage_name: string;
  status: "active" | "completed" | "failed" | "skipped" | "retrying";
  attempt: number;
  dispatch_id: string | null;
  failure_reason: string | null;
  started_at: number;
  completed_at: number | null;
}

// ── Stage CRUD ──

export function listPipelineStages(db: DatabaseSync, repo: string): PipelineStage[] {
  return db.prepare(
    `SELECT * FROM pipeline_stages WHERE repo = ? ORDER BY stage_order`,
  ).all(repo) as unknown as PipelineStage[];
}

export function getPipelineStage(db: DatabaseSync, id: string): PipelineStage | undefined {
  return db.prepare(
    `SELECT * FROM pipeline_stages WHERE id = ? LIMIT 1`,
  ).get(id) as PipelineStage | undefined;
}

export function upsertPipelineStages(
  db: DatabaseSync,
  repo: string,
  stages: Array<Omit<PipelineStage, "id" | "repo" | "created_at">>,
): PipelineStage[] {
  const now = Date.now();

  // Delete existing stages for this repo
  db.prepare(`DELETE FROM pipeline_stages WHERE repo = ?`).run(repo);

  const result: PipelineStage[] = [];
  for (const [idx, stage] of stages.entries()) {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO pipeline_stages (id, repo, stage_name, stage_order, entry_skill, provider,
        agent_override_id, timeout_minutes, on_failure, on_failure_target, max_retries,
        skip_condition, parallel_with, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, repo, stage.stage_name, idx,
      stage.entry_skill ?? null, stage.provider ?? null,
      stage.agent_override_id ?? null, stage.timeout_minutes ?? 60,
      stage.on_failure ?? "fail", stage.on_failure_target ?? null,
      stage.max_retries ?? 3, stage.skip_condition ?? null,
      stage.parallel_with ?? null, now,
    );
    result.push({
      id, repo, stage_name: stage.stage_name, stage_order: idx,
      entry_skill: stage.entry_skill ?? null, provider: stage.provider ?? null,
      agent_override_id: stage.agent_override_id ?? null,
      timeout_minutes: stage.timeout_minutes ?? 60,
      on_failure: stage.on_failure ?? "fail",
      on_failure_target: stage.on_failure_target ?? null,
      max_retries: stage.max_retries ?? 3,
      skip_condition: stage.skip_condition ?? null,
      parallel_with: stage.parallel_with ?? null,
      created_at: now,
    });
  }

  broadcast("pipeline_stages_updated", { repo, stages: result });
  return result;
}

export function deletePipelineStages(db: DatabaseSync, repo: string): void {
  db.prepare(`DELETE FROM pipeline_stages WHERE repo = ?`).run(repo);
  broadcast("pipeline_stages_updated", { repo, stages: [] });
}

// ── Pipeline History ──

export function getPipelineHistory(db: DatabaseSync, cardId: string): PipelineHistoryEntry[] {
  return db.prepare(
    `SELECT * FROM pipeline_history WHERE card_id = ? ORDER BY started_at`,
  ).all(cardId) as unknown as PipelineHistoryEntry[];
}

function getActiveHistoryEntry(db: DatabaseSync, cardId: string): PipelineHistoryEntry | undefined {
  return db.prepare(
    `SELECT * FROM pipeline_history WHERE card_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
  ).get(cardId) as PipelineHistoryEntry | undefined;
}

// ── Check skip condition ──

function shouldSkipStage(
  db: DatabaseSync,
  stage: PipelineStage,
  card: { github_repo: string | null; github_issue_number: number | null; metadata_json: string | null },
): boolean {
  if (!stage.skip_condition) return false;

  // Parse skip_condition: "label:hotfix" or "label:docs-only"
  const conditions = stage.skip_condition.split(",").map((s) => s.trim());
  for (const cond of conditions) {
    if (cond.startsWith("label:")) {
      const labelName = cond.slice("label:".length).trim();
      if (!labelName || !card.github_repo || !card.github_issue_number) continue;

      // Check issue labels from metadata
      try {
        const meta = card.metadata_json ? JSON.parse(card.metadata_json) : {};
        const labels = Array.isArray(meta.github_labels) ? meta.github_labels as string[] : [];
        if (labels.includes(labelName)) return true;
      } catch {
        // skip
      }
    }
  }
  return false;
}

// ── Get next stage(s) ──

function getNextStages(stages: PipelineStage[], currentOrder: number): PipelineStage[] {
  const next = stages.filter((s) => s.stage_order === currentOrder + 1);
  if (next.length === 0) return [];

  // Include parallel stages
  const result = [...next];
  for (const stage of next) {
    if (stage.parallel_with) {
      const parallelName = stage.parallel_with;
      const parallel = stages.find((s) => s.stage_name === parallelName && !result.includes(s));
      if (parallel) result.push(parallel);
    }
  }
  return result;
}

// ── Pipeline Engine ──

/**
 * Check if a repo has a pipeline configured.
 */
export function hasPipeline(db: DatabaseSync, repo: string): boolean {
  const count = db.prepare(
    `SELECT COUNT(*) as cnt FROM pipeline_stages WHERE repo = ?`,
  ).get(repo) as { cnt: number };
  return count.cnt > 0;
}

/**
 * Start pipeline for a card: enter the first stage.
 * Called when a card enters 'ready' status and has a pipeline.
 */
export function startPipeline(db: DatabaseSync, cardId: string): boolean {
  const card = getRawKanbanCardById(db, cardId);
  if (!card || !card.github_repo) return false;

  const stages = listPipelineStages(db, card.github_repo);
  if (stages.length === 0) return false;

  enterStage(db, cardId, stages[0], stages);
  return true;
}

/**
 * Enter a specific pipeline stage for a card.
 */
function enterStage(
  db: DatabaseSync,
  cardId: string,
  stage: PipelineStage,
  allStages: PipelineStage[],
): void {
  const card = getRawKanbanCardById(db, cardId);
  if (!card) return;

  const now = Date.now();

  // Check skip condition
  if (shouldSkipStage(db, stage, card)) {
    const histId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO pipeline_history (id, card_id, stage_id, stage_name, status, attempt, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'skipped', 1, ?, ?)`,
    ).run(histId, cardId, stage.id, stage.stage_name, now, now);

    broadcast("pipeline_stage_skipped", { card_id: cardId, stage_id: stage.id, stage_name: stage.stage_name });

    // Move to next stage
    const next = getNextStages(allStages, stage.stage_order);
    if (next.length > 0) {
      for (const nextStage of next) {
        enterStage(db, cardId, nextStage, allStages);
      }
    } else {
      completePipeline(db, cardId);
    }
    return;
  }

  // Create history entry
  const histId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO pipeline_history (id, card_id, stage_id, stage_name, status, attempt, started_at)
     VALUES (?, ?, ?, ?, 'active', 1, ?)`,
  ).run(histId, cardId, stage.id, stage.stage_name, now);

  // Update card's pipeline_stage_id
  db.prepare(
    `UPDATE kanban_cards SET pipeline_stage_id = ?, updated_at = ? WHERE id = ?`,
  ).run(stage.id, now, cardId);

  // If stage has entry_skill, dispatch the card
  if (stage.entry_skill) {
    // Override agent if specified
    if (stage.agent_override_id) {
      db.prepare(
        `UPDATE kanban_cards SET assignee_agent_id = ?, updated_at = ? WHERE id = ?`,
      ).run(stage.agent_override_id, now, cardId);
    }

    try {
      const dispatched = createDispatchForKanbanCard(db, cardId);
      // Link dispatch to history
      db.prepare(
        `UPDATE pipeline_history SET dispatch_id = ? WHERE id = ?`,
      ).run(dispatched.latest_dispatch_id, histId);
    } catch (e) {
      console.error(`[pipeline] Failed to dispatch card ${cardId} for stage ${stage.stage_name}:`, (e as Error).message);
      handleStageFailure(db, cardId, stage, allStages, (e as Error).message);
    }
  }

  broadcast("pipeline_stage_entered", {
    card_id: cardId,
    stage_id: stage.id,
    stage_name: stage.stage_name,
    entry_skill: stage.entry_skill,
  });
  emitKanbanCard(db, cardId, "kanban_card_updated");
}

/**
 * Called when a card's dispatch completes (card enters 'review' status).
 * Advances to next pipeline stage.
 */
export function onPipelineStageComplete(db: DatabaseSync, cardId: string): void {
  const card = getRawKanbanCardById(db, cardId);
  if (!card || !card.pipeline_stage_id || !card.github_repo) return;

  const stage = getPipelineStage(db, card.pipeline_stage_id);
  if (!stage) return;

  const allStages = listPipelineStages(db, card.github_repo);
  const now = Date.now();

  // Complete active history entry
  const activeHist = getActiveHistoryEntry(db, cardId);
  if (activeHist) {
    db.prepare(
      `UPDATE pipeline_history SET status = 'completed', completed_at = ? WHERE id = ?`,
    ).run(now, activeHist.id);
  }

  broadcast("pipeline_stage_completed", { card_id: cardId, stage_id: stage.id, stage_name: stage.stage_name });

  // Check for parallel stages that need to complete
  if (stage.parallel_with) {
    const parallelStage = allStages.find((s) => s.stage_name === stage.parallel_with);
    if (parallelStage) {
      const parallelHist = db.prepare(
        `SELECT status FROM pipeline_history
         WHERE card_id = ? AND stage_id = ? AND status = 'active'
         LIMIT 1`,
      ).get(cardId, parallelStage.id) as { status: string } | undefined;

      if (parallelHist) {
        // Parallel stage not done yet, wait
        // Reset card status to in_progress while waiting
        db.prepare(
          `UPDATE kanban_cards SET status = 'in_progress', updated_at = ? WHERE id = ?`,
        ).run(now, cardId);
        emitKanbanCard(db, cardId, "kanban_card_updated");
        return;
      }
    }
  }

  // Also check if this stage IS a parallel target
  const parentStage = allStages.find((s) => s.parallel_with === stage.stage_name);
  if (parentStage) {
    const parentHist = db.prepare(
      `SELECT status FROM pipeline_history
       WHERE card_id = ? AND stage_id = ? AND status = 'active'
       LIMIT 1`,
    ).get(cardId, parentStage.id) as { status: string } | undefined;

    if (parentHist) {
      db.prepare(
        `UPDATE kanban_cards SET status = 'in_progress', updated_at = ? WHERE id = ?`,
      ).run(now, cardId);
      emitKanbanCard(db, cardId, "kanban_card_updated");
      return;
    }
  }

  // Advance to next stage
  const nextStages = getNextStages(allStages, stage.stage_order);
  if (nextStages.length > 0) {
    // Reset card status for next stage dispatch
    db.prepare(
      `UPDATE kanban_cards SET status = 'ready', requested_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(now, cardId);

    for (const nextStage of nextStages) {
      enterStage(db, cardId, nextStage, allStages);
    }
  } else {
    completePipeline(db, cardId);
  }
}

/**
 * Called when a card's dispatch fails.
 * Handles on_failure routing.
 */
export function onPipelineStageFailure(db: DatabaseSync, cardId: string, reason?: string): void {
  const card = getRawKanbanCardById(db, cardId);
  if (!card || !card.pipeline_stage_id || !card.github_repo) return;

  const stage = getPipelineStage(db, card.pipeline_stage_id);
  if (!stage) return;

  const allStages = listPipelineStages(db, card.github_repo);
  handleStageFailure(db, cardId, stage, allStages, reason ?? "Stage failed");
}

function handleStageFailure(
  db: DatabaseSync,
  cardId: string,
  stage: PipelineStage,
  allStages: PipelineStage[],
  reason: string,
): void {
  const now = Date.now();
  const activeHist = getActiveHistoryEntry(db, cardId);
  const attempt = activeHist?.attempt ?? 1;

  if (activeHist) {
    db.prepare(
      `UPDATE pipeline_history SET status = 'failed', failure_reason = ?, completed_at = ? WHERE id = ?`,
    ).run(reason, now, activeHist.id);
  }

  broadcast("pipeline_stage_failed", { card_id: cardId, stage_id: stage.id, stage_name: stage.stage_name, reason });

  switch (stage.on_failure) {
    case "retry": {
      if (attempt < stage.max_retries) {
        // Retry same stage
        const histId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO pipeline_history (id, card_id, stage_id, stage_name, status, attempt, started_at)
           VALUES (?, ?, ?, ?, 'retrying', ?, ?)`,
        ).run(histId, cardId, stage.id, stage.stage_name, attempt + 1, now);

        // Reset and re-enter
        db.prepare(
          `UPDATE kanban_cards SET status = 'ready', requested_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(now, cardId);

        db.prepare(
          `UPDATE pipeline_history SET status = 'active' WHERE id = ?`,
        ).run(histId);

        enterStage(db, cardId, stage, allStages);
        return;
      }
      // Max retries exhausted → fall through to fail
      break;
    }
    case "previous": {
      if (attempt < stage.max_retries) {
        const prevStage = allStages.find((s) => s.stage_order === stage.stage_order - 1);
        if (prevStage) {
          db.prepare(
            `UPDATE kanban_cards SET status = 'ready', requested_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`,
          ).run(now, cardId);
          enterStage(db, cardId, prevStage, allStages);
          return;
        }
      }
      break;
    }
    case "goto": {
      if (attempt < stage.max_retries && stage.on_failure_target) {
        const targetStage = allStages.find((s) => s.stage_name === stage.on_failure_target);
        if (targetStage) {
          db.prepare(
            `UPDATE kanban_cards SET status = 'ready', requested_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`,
          ).run(now, cardId);
          enterStage(db, cardId, targetStage, allStages);
          return;
        }
      }
      break;
    }
    default:
      // "fail" — do nothing, card stays failed
      break;
  }

  // Terminal failure
  db.prepare(
    `UPDATE kanban_cards SET status = 'failed', pipeline_stage_id = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(stage.id, now, now, cardId);
  emitKanbanCard(db, cardId, "kanban_card_updated");
}

/**
 * Complete the pipeline: mark card as done.
 */
function completePipeline(db: DatabaseSync, cardId: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE kanban_cards SET status = 'done', pipeline_stage_id = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, now, cardId);

  const card = emitKanbanCard(db, cardId, "kanban_card_updated");
  if (card) {
    rewardKanbanCompletion(db, cardId);
    closeGitHubIssueOnDone(card);
    try {
      onCardTerminal(db, cardId, "done");
    } catch (e) {
      console.error("[pipeline] auto-queue onCardTerminal error:", (e as Error).message);
    }
  }

  broadcast("pipeline_completed", { card_id: cardId });
  console.log(`[pipeline] Pipeline completed for card ${cardId}`);
}

/**
 * Get current pipeline status for a card.
 */
export function getCardPipelineStatus(
  db: DatabaseSync,
  cardId: string,
): {
  stages: PipelineStage[];
  history: PipelineHistoryEntry[];
  current_stage: PipelineStage | null;
} | null {
  const card = getRawKanbanCardById(db, cardId);
  if (!card || !card.github_repo) return null;

  const stages = listPipelineStages(db, card.github_repo);
  if (stages.length === 0) return null;

  const history = getPipelineHistory(db, cardId);
  const currentStage = card.pipeline_stage_id
    ? stages.find((s) => s.id === card.pipeline_stage_id) ?? null
    : null;

  return { stages, history, current_stage: currentStage };
}
