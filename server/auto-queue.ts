import { execFile } from "node:child_process";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db/runtime.js";
import { broadcast } from "./ws.js";
import {
  createDispatchForKanbanCard,
  triggerCounterModelReview,
  type KanbanCardRow,
} from "./kanban-cards.js";

interface ReadyCardRow {
  id: string;
  title: string;
  description: string | null;
  priority: string | null;
  github_repo: string | null;
  github_issue_number: number | null;
  assignee_agent_id: string | null;
  created_at: number;
  sort_order: number;
}

// ── Types ──

export interface DispatchQueueEntry {
  id: string;
  agent_id: string;
  card_id: string;
  priority_rank: number;
  reason: string | null;
  status: "pending" | "dispatched" | "done" | "skipped";
  created_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
}

export interface AutoQueueRun {
  id: string;
  repo: string | null;
  status: "active" | "paused" | "completed";
  ai_model: string | null;
  ai_rationale: string | null;
  timeout_minutes: number;
  created_at: number;
  completed_at: number | null;
}

interface AIPriorityResult {
  card_id: string;
  rank: number;
  reason: string;
}

// ── Constants ──

const AUTO_QUEUE_TIMEOUT_MS = 100 * 60 * 1000; // 100 minutes
const AUTO_QUEUE_CHECK_MS = 60 * 1000; // check every 1 minute
const DOD_AWAIT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — bypass DoD gate if agent didn't check
let checkTimer: ReturnType<typeof setInterval> | null = null;

// ── Claude CLI for prioritization ──

const CLAUDE_BIN = "/Users/itismyfield/bin/claude";

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_BIN,
      ["-p", "--model", "haiku", "--max-turns", "1"],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`claude -p failed: ${stderr || err.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export async function prioritizeCards(
  cards: Array<{ id: string; title: string; description: string | null; priority: string | null; github_repo: string | null; github_issue_number: number | null; created_at: number }>,
): Promise<AIPriorityResult[]> {
  const cardList = cards
    .map(
      (c, i) =>
        `${i + 1}. [${c.id}] ${c.priority ?? "medium"} | ${c.github_repo ?? ""}#${c.github_issue_number ?? ""} | ${c.title}${c.description ? ` - ${c.description.slice(0, 120)}` : ""}`,
    )
    .join("\n");

  const prompt = `You are a project manager prioritizing kanban cards for dispatch.

Given these ready cards, rank them by priority considering:
- Explicit priority field (urgent > high > medium > low)
- Dependencies (blocking issues first)
- Bug fixes before features
- Smaller scope items first when priority is equal

Cards:
${cardList}

Respond ONLY with a JSON array, no other text:
[{"card_id": "...", "rank": 1, "reason": "one-line reason"}, ...]

Rank 1 = highest priority (dispatch first).`;

  try {
    const text = await runClaude(prompt);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return cards.map((c, i) => ({ card_id: c.id, rank: i + 1, reason: "default order" }));

    return JSON.parse(jsonMatch[0]) as AIPriorityResult[];
  } catch (e) {
    console.error("[auto-queue] AI prioritization failed:", (e as Error).message);
    // Fallback: priority field order
    const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    return cards
      .map((c) => ({ card_id: c.id, score: priorityOrder[c.priority ?? "medium"] ?? 2 }))
      .sort((a, b) => a.score - b.score)
      .map((c, i) => ({ card_id: c.card_id, rank: i + 1, reason: "fallback: priority field" }));
  }
}

// ── Shared prioritization logic ──

export interface DryRunEntry {
  card_id: string;
  card_title: string;
  agent_id: string;
  agent_name: string | null;
  rank: number;
  reason: string;
  github_issue_number: number | null;
  github_repo: string | null;
}

async function buildPrioritizedQueue(
  db: DatabaseSync,
  repo: string | null,
): Promise<{ cards: ReadyCardRow[]; ranked: AIPriorityResult[]; byAgent: Map<string, AIPriorityResult[]> }> {
  const readyCards = (
    repo
      ? db.prepare(
          `SELECT * FROM kanban_cards WHERE status = 'ready' AND github_repo = ? ORDER BY sort_order, created_at`,
        ).all(repo)
      : db.prepare(
          `SELECT * FROM kanban_cards WHERE status = 'ready' ORDER BY sort_order, created_at`,
        ).all()
  ) as unknown as ReadyCardRow[];

  if (readyCards.length === 0) throw new Error("no_ready_cards");

  const assignedCards = readyCards.filter((c) => c.assignee_agent_id);
  if (assignedCards.length === 0) throw new Error("no_assigned_ready_cards");

  const ranked = await prioritizeCards(
    assignedCards.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      priority: c.priority,
      github_repo: c.github_repo,
      github_issue_number: c.github_issue_number,
      created_at: c.created_at,
    })),
  );

  const byAgent = new Map<string, AIPriorityResult[]>();
  for (const item of ranked) {
    const card = assignedCards.find((c) => c.id === item.card_id);
    if (!card?.assignee_agent_id) continue;
    const list = byAgent.get(card.assignee_agent_id) ?? [];
    list.push(item);
    byAgent.set(card.assignee_agent_id, list);
  }
  for (const [, agentList] of byAgent) {
    agentList.sort((a, b) => a.rank - b.rank);
    agentList.forEach((item, idx) => { item.rank = idx + 1; });
  }

  return { cards: assignedCards, ranked: Array.from(byAgent.values()).flat(), byAgent };
}

// ── Dry run (preview without side effects) ──

export async function dryRunQueue(
  db: DatabaseSync,
  repo: string | null,
): Promise<DryRunEntry[]> {
  const { cards, ranked } = await buildPrioritizedQueue(db, repo);

  return ranked.map((item) => {
    const card = cards.find((c) => c.id === item.card_id);
    const agent = card?.assignee_agent_id
      ? (db.prepare("SELECT name FROM agents WHERE id = ?").get(card.assignee_agent_id) as { name: string } | undefined)
      : null;
    return {
      card_id: item.card_id,
      card_title: card?.title ?? "",
      agent_id: card?.assignee_agent_id ?? "",
      agent_name: agent?.name ?? null,
      rank: item.rank,
      reason: item.reason,
      github_issue_number: card?.github_issue_number ?? null,
      github_repo: card?.github_repo ?? null,
    };
  });
}

// ── Queue generation ──

export async function generateQueue(
  db: DatabaseSync,
  repo: string | null,
): Promise<{ run: AutoQueueRun; entries: DispatchQueueEntry[] }> {
  const { cards: assignedCards, ranked: allRanked } = await buildPrioritizedQueue(db, repo);

  // Create run
  const runId = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO auto_queue_runs (id, repo, status, ai_model, ai_rationale, timeout_minutes, created_at)
     VALUES (?, ?, 'active', 'claude-sonnet-4', ?, 100, ?)`,
  ).run(runId, repo, JSON.stringify(allRanked.map((r) => ({ card_id: r.card_id, reason: r.reason }))), now);

  // Deactivate any previous active runs for this repo
  db.prepare(
    `UPDATE auto_queue_runs SET status = 'completed', completed_at = ? WHERE repo IS ? AND status = 'active' AND id != ?`,
  ).run(now, repo, runId);

  // Clear previous pending entries for same agent+repo
  db.prepare(
    `UPDATE dispatch_queue SET status = 'skipped', completed_at = ?
     WHERE status = 'pending'
       AND card_id IN (SELECT id FROM kanban_cards WHERE github_repo IS ?)`,
  ).run(now, repo);

  // Insert queue entries grouped by agent, ordered by per-agent rank
  const entries: DispatchQueueEntry[] = [];
  for (const item of allRanked) {
    const card = assignedCards.find((c) => c.id === item.card_id);
    if (!card || !card.assignee_agent_id) continue;

    const entryId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dispatch_queue (id, agent_id, card_id, priority_rank, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(entryId, card.assignee_agent_id, card.id, item.rank, item.reason, now);

    entries.push({
      id: entryId,
      agent_id: card.assignee_agent_id,
      card_id: card.id,
      priority_rank: item.rank,
      reason: item.reason,
      status: "pending",
      created_at: now,
      dispatched_at: null,
      completed_at: null,
    });
  }

  const run: AutoQueueRun = {
    id: runId,
    repo,
    status: "active",
    ai_model: "claude-sonnet-4",
    ai_rationale: null,
    timeout_minutes: 100,
    created_at: now,
    completed_at: null,
  };

  broadcast("auto_queue_generated", { run, entries });
  return { run, entries };
}

// ── Activate: dispatch first pending per agent ──

export function activateQueue(db: DatabaseSync): KanbanCardRow[] {
  const dispatched: KanbanCardRow[] = [];

  // Find agents with pending queue entries but no active (requested/in_progress) cards
  const agentsWithPending = db.prepare(
    `SELECT DISTINCT dq.agent_id
     FROM dispatch_queue dq
     WHERE dq.status = 'pending'`,
  ).all() as unknown as Array<{ agent_id: string }>;

  for (const { agent_id } of agentsWithPending) {
    const card = dispatchNextForAgent(db, agent_id);
    if (card) dispatched.push(card);
  }

  return dispatched;
}

// ── Dispatch next pending card for a specific agent ──

export function dispatchNextForAgent(db: DatabaseSync, agentId: string): KanbanCardRow | null {
  // Check if agent already has an active card
  const activeCard = db.prepare(
    `SELECT id FROM kanban_cards
     WHERE assignee_agent_id = ?
       AND status IN ('requested', 'in_progress')
     LIMIT 1`,
  ).get(agentId) as { id: string } | undefined;

  if (activeCard) return null; // Agent is busy

  // Get next pending queue entry for this agent
  const nextEntry = db.prepare(
    `SELECT dq.id, dq.card_id
     FROM dispatch_queue dq
     JOIN kanban_cards kc ON kc.id = dq.card_id
     WHERE dq.agent_id = ?
       AND dq.status = 'pending'
       AND kc.status = 'ready'
     ORDER BY dq.priority_rank ASC
     LIMIT 1`,
  ).get(agentId) as { id: string; card_id: string } | undefined;

  if (!nextEntry) return null;

  try {
    const card = createDispatchForKanbanCard(db, nextEntry.card_id);
    const now = Date.now();
    db.prepare(
      `UPDATE dispatch_queue SET status = 'dispatched', dispatched_at = ? WHERE id = ?`,
    ).run(now, nextEntry.id);

    broadcast("auto_queue_dispatched", { entry_id: nextEntry.id, card_id: nextEntry.card_id, agent_id: agentId });
    console.log(`[auto-queue] Dispatched card ${nextEntry.card_id} to agent ${agentId}`);
    return card;
  } catch (e) {
    console.error(`[auto-queue] Failed to dispatch card ${nextEntry.card_id}:`, (e as Error).message);
    // Skip this entry
    db.prepare(
      `UPDATE dispatch_queue SET status = 'skipped', completed_at = ? WHERE id = ?`,
    ).run(Date.now(), nextEntry.id);
    // Try next entry recursively
    return dispatchNextForAgent(db, agentId);
  }
}

// ── Card terminal hook: mark queue entry done + dispatch next ──

export function onCardTerminal(
  db: DatabaseSync,
  cardId: string,
  _terminalStatus: string,
): KanbanCardRow | null {
  const now = Date.now();

  // Find and complete queue entry for this card
  const entry = db.prepare(
    `SELECT id, agent_id FROM dispatch_queue WHERE card_id = ? AND status = 'dispatched' LIMIT 1`,
  ).get(cardId) as { id: string; agent_id: string } | undefined;

  if (!entry) return null;

  db.prepare(
    `UPDATE dispatch_queue SET status = 'done', completed_at = ? WHERE id = ?`,
  ).run(now, entry.id);

  // Check if there's an active run
  const activeRun = db.prepare(
    `SELECT id FROM auto_queue_runs WHERE status = 'active' LIMIT 1`,
  ).get() as { id: string } | undefined;

  if (!activeRun) return null;

  // Dispatch next for this agent
  return dispatchNextForAgent(db, entry.agent_id);
}

// ── Queue status ──

export function getQueueStatus(db: DatabaseSync, repo?: string | null): {
  run: AutoQueueRun | null;
  entries: DispatchQueueEntry[];
  agents: Record<string, { pending: number; dispatched: number; done: number; skipped: number }>;
} {
  const run = (
    repo
      ? db.prepare(
          `SELECT * FROM auto_queue_runs WHERE status = 'active' AND repo = ? ORDER BY created_at DESC LIMIT 1`,
        ).get(repo)
      : db.prepare(
          `SELECT * FROM auto_queue_runs WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`,
        ).get()
  ) as unknown as AutoQueueRun | undefined;

  const entries = run
    ? (repo
        ? db.prepare(
            `SELECT dq.*, kc.title as card_title, kc.github_issue_number, kc.github_repo
             FROM dispatch_queue dq
             JOIN kanban_cards kc ON kc.id = dq.card_id
             WHERE dq.created_at >= ? AND kc.github_repo = ?
             ORDER BY dq.agent_id, dq.priority_rank`,
          ).all(run.created_at, repo)
        : db.prepare(
            `SELECT dq.*, kc.title as card_title, kc.github_issue_number, kc.github_repo
             FROM dispatch_queue dq
             JOIN kanban_cards kc ON kc.id = dq.card_id
             WHERE dq.created_at >= ?
             ORDER BY dq.agent_id, dq.priority_rank`,
          ).all(run.created_at)
      ) as unknown as (DispatchQueueEntry & { card_title: string; github_issue_number: number | null; github_repo: string | null })[]
    : [];

  const agents: Record<string, { pending: number; dispatched: number; done: number; skipped: number }> = {};
  for (const e of entries) {
    if (!agents[e.agent_id]) agents[e.agent_id] = { pending: 0, dispatched: 0, done: 0, skipped: 0 };
    agents[e.agent_id][e.status]++;
  }

  return { run: run ?? null, entries, agents };
}

// ── Timeout check ──

function checkAutoQueueTimeouts(): void {
  const db = getDb();
  const now = Date.now();

  // Bypass DoD gate for cards stuck in review/awaiting_dod too long
  // Uses dispatch completed_at as anchor (not updated_at which gets reset by DoD mirror syncs)
  const stuckAwaitingDod = db.prepare(
    `SELECT kc.id, td.completed_at as dispatch_completed_at
     FROM kanban_cards kc
     JOIN task_dispatches td ON td.id = kc.latest_dispatch_id
     WHERE kc.status = 'review' AND kc.review_status = 'awaiting_dod'
       AND td.completed_at IS NOT NULL
       AND td.completed_at < ?`,
  ).all(now - DOD_AWAIT_TIMEOUT_MS) as unknown as Array<{ id: string; dispatch_completed_at: number }>;

  for (const card of stuckAwaitingDod) {
    console.log(`[auto-queue] DoD timeout for card ${card.id} (${Math.round((now - card.dispatch_completed_at) / 60000)}min since dispatch completed), bypassing DoD gate`);
    try {
      triggerCounterModelReview(db, card.id, { bypassDod: true });
    } catch (e) {
      console.error(`[auto-queue] DoD bypass review trigger failed for card ${card.id}:`, (e as Error).message);
    }
  }

  // Find dispatched entries that have timed out
  const timedOut = db.prepare(
    `SELECT dq.id, dq.agent_id, dq.card_id
     FROM dispatch_queue dq
     JOIN auto_queue_runs aqr ON aqr.status = 'active'
     WHERE dq.status = 'dispatched'
       AND dq.dispatched_at IS NOT NULL
       AND dq.dispatched_at < ?`,
  ).all(now - AUTO_QUEUE_TIMEOUT_MS) as unknown as Array<{ id: string; agent_id: string; card_id: string }>;

  for (const entry of timedOut) {
    db.prepare(
      `UPDATE dispatch_queue SET status = 'skipped', completed_at = ? WHERE id = ?`,
    ).run(now, entry.id);
    console.log(`[auto-queue] Timed out entry ${entry.id} for card ${entry.card_id}`);
    broadcast("auto_queue_timeout", { entry_id: entry.id, card_id: entry.card_id, agent_id: entry.agent_id });

    // Try dispatching next for this agent
    dispatchNextForAgent(db, entry.agent_id);
  }

  // Advance dispatched entries whose cards left requested/in_progress (e.g. moved to review)
  // Without this, queue entries stay 'dispatched' until 100-min timeout even though the agent is free
  const staleDispatched = db.prepare(
    `SELECT dq.id, dq.agent_id, dq.card_id, kc.status as card_status
     FROM dispatch_queue dq
     JOIN kanban_cards kc ON kc.id = dq.card_id
     WHERE dq.status = 'dispatched'
       AND kc.status NOT IN ('requested', 'in_progress')`,
  ).all() as unknown as Array<{ id: string; agent_id: string; card_id: string; card_status: string }>;

  for (const entry of staleDispatched) {
    db.prepare(
      `UPDATE dispatch_queue SET status = 'done', completed_at = ? WHERE id = ?`,
    ).run(now, entry.id);
    console.log(`[auto-queue] Advanced stale entry ${entry.id} (card ${entry.card_id} is ${entry.card_status})`);

    // Try dispatching next for this agent
    dispatchNextForAgent(db, entry.agent_id);
  }

  // Detect idle agents with pending entries that weren't dispatched
  // This covers the gap where onCardTerminal can't find the queue entry
  // because stale-check already marked it done before the card reached terminal
  const idleAgentsWithPending = db.prepare(
    `SELECT DISTINCT dq.agent_id
     FROM dispatch_queue dq
     WHERE dq.status = 'pending'
       AND NOT EXISTS (
         SELECT 1 FROM kanban_cards kc
         WHERE kc.assignee_agent_id = dq.agent_id
           AND kc.status IN ('requested', 'in_progress')
       )
       AND NOT EXISTS (
         SELECT 1 FROM dispatch_queue dq2
         WHERE dq2.agent_id = dq.agent_id
           AND dq2.status = 'dispatched'
       )`,
  ).all() as unknown as Array<{ agent_id: string }>;

  for (const { agent_id } of idleAgentsWithPending) {
    const dispatched = dispatchNextForAgent(db, agent_id);
    if (dispatched) {
      console.log(`[auto-queue] Resumed idle agent ${agent_id} with pending entries`);
    }
  }

  // Check if all entries are done/skipped → complete the run
  const activeRun = db.prepare(
    `SELECT id FROM auto_queue_runs WHERE status = 'active' LIMIT 1`,
  ).get() as { id: string } | undefined;

  if (activeRun) {
    const remaining = db.prepare(
      `SELECT COUNT(*) as cnt FROM dispatch_queue
       WHERE status IN ('pending', 'dispatched')
         AND created_at >= (SELECT created_at FROM auto_queue_runs WHERE id = ?)`,
    ).get(activeRun.id) as { cnt: number };

    if (remaining.cnt === 0) {
      db.prepare(
        `UPDATE auto_queue_runs SET status = 'completed', completed_at = ? WHERE id = ?`,
      ).run(now, activeRun.id);
      broadcast("auto_queue_completed", { run_id: activeRun.id });
      console.log(`[auto-queue] Run ${activeRun.id} completed`);
    }
  }
}

// ── Lifecycle ──

export function startAutoQueueCheck(): void {
  checkTimer = setInterval(() => {
    try {
      checkAutoQueueTimeouts();
    } catch (e) {
      console.error("[auto-queue] check error:", (e as Error).message);
    }
  }, AUTO_QUEUE_CHECK_MS);
  console.log("[auto-queue] timeout checker started (interval=1min, timeout=100min)");
}

export function stopAutoQueueCheck(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
