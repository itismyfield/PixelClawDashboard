import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "./db/runtime.js";
import { enforceKanbanTimeouts, syncGitHubIssueStates, syncKanbanCardWithDispatch, processReviewVerdict } from "./kanban-cards.js";
import type { ReviewVerdict } from "./kanban-cards.js";
import { broadcast } from "./ws.js";
import { resolveAgent } from "./dispatch-routing.js";
import { sendDiscordMessage, sendToAgentChannel } from "./discord-announce.js";
import { PCD_HANDOFF_ARCHIVE_DIR, PCD_HANDOFF_DIR, ensurePcdRuntimeDirs } from "./runtime-paths.js";
import { getRuntimeConfig } from "./runtime-config.js";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let staleTimer: ReturnType<typeof setInterval> | null = null;
let ghSyncTimer: ReturnType<typeof setInterval> | null = null;
let watcher: fs.FSWatcher | null = null;
let pollDebounce: ReturnType<typeof setTimeout> | null = null;

function debouncedPoll(): void {
  if (pollDebounce) return;
  pollDebounce = setTimeout(() => {
    pollDebounce = null;
    pollOnce();
  }, 100);
}

// ── Handoff JSON types ──

interface HandoffFile {
  dispatch_id: string;
  from: string;
  to?: string | null;
  type: string;
  title: string;
  parent_dispatch_id?: string | null;
  context?: {
    summary?: string;
    changed_files?: string[];
    branch?: string;
    repo_path?: string;
    test_hints?: string[];
  };
  instructions?: string;
  /** Structured dispatch input (separated from UI description) */
  structured_input?: {
    intent: string;
    checklist: Array<{ text: string; done: boolean; verify: "auto" | "manual" | "semi" }>;
    issue_url: string | null;
    truncated: boolean;
    fallback_reason: string | null;
  };
  /** Force delivery to a specific Discord channel (bypasses agent channel resolution) */
  delivery_channel_id?: string | null;
  /** Review-specific context (present when type = "review") */
  review_context?: {
    original_dispatch_id: string;
    original_agent_id: string;
    original_provider: string;
    review_round: number;
    max_rounds: number;
    dod_items: Array<{ text: string; checked: boolean }>;
  };
}

interface ResultFile {
  dispatch_id: string;
  from: string;
  to: string;
  status: "pass" | "partial_fail" | "fail";
  summary: string;
  results?: Array<{ test: string; status: string; detail?: string | null }>;
  follow_up_request?: {
    type: string;
    detail: string;
    to?: string | null;
  } | null;
  /** Review verdict (present when the dispatch was type = "review") */
  review_verdict?: ReviewVerdict;
}

// ── Helpers ──

function ensureDirs(): void {
  ensurePcdRuntimeDirs();
}

function getArchiveDestination(filePath: string): string {
  const parsed = path.parse(filePath);
  let dest = path.join(PCD_HANDOFF_ARCHIVE_DIR, path.basename(filePath));
  let suffix = 1;

  while (fs.existsSync(dest)) {
    dest = path.join(PCD_HANDOFF_ARCHIVE_DIR, `${parsed.name}.${suffix}${parsed.ext}`);
    suffix += 1;
  }

  return dest;
}

function archiveFile(filePath: string): string {
  const dest = getArchiveDestination(filePath);
  try {
    fs.renameSync(filePath, dest);
  } catch {
    // If rename fails (cross-device), copy + delete
    fs.copyFileSync(filePath, dest);
    fs.unlinkSync(filePath);
  }
  return dest;
}

async function sendAgentMessage(agentId: string, message: string): Promise<boolean> {
  const maxRetries = getRuntimeConfig().maxRetries;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ok = await sendToAgentChannel(agentId, message);
    if (ok) {
      console.log(`[PCD-dispatch] Delivered to ${agentId}: ${message.slice(0, 80)}`);
      return true;
    }
    console.error(
      `[PCD-dispatch] Delivery attempt ${attempt}/${maxRetries} to ${agentId} failed`,
    );
  }
  return false;
}

function sendCeoAlert(text: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO messages (sender_type, sender_id, receiver_type, receiver_id, content, message_type)
     VALUES ('system', 'dispatch-watcher', 'agent', NULL, ?, 'status_update')`,
  ).run(`⚠️ [Dispatch] ${text}`);
  broadcast("new_message", { content: text, sender_type: "system" });
  console.log(`[PCD-dispatch] CEO alert: ${text}`);
}

function getDispatchRow(dispatchId: string): Record<string, unknown> | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM task_dispatches WHERE id = ? LIMIT 1")
    .get(dispatchId) as Record<string, unknown> | undefined;
}

function emitDispatchCreated(dispatchId: string): void {
  const row = getDispatchRow(dispatchId);
  if (!row) return;
  broadcast("task_dispatch_created", row);
  try {
    syncKanbanCardWithDispatch(getDb(), dispatchId);
  } catch (error) {
    console.error(`[PCD-dispatch] Failed kanban sync for dispatch ${dispatchId}`, error);
  }
}

function emitDispatchUpdated(dispatchId: string): void {
  const row = getDispatchRow(dispatchId);
  if (!row) return;
  broadcast("task_dispatch_updated", row);
  try {
    syncKanbanCardWithDispatch(getDb(), dispatchId);
  } catch (error) {
    console.error(`[PCD-dispatch] Failed kanban sync for dispatch ${dispatchId}`, error);
  }
}

// ── Handoff file processing ──

function processHandoffFile(filePath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return; // file may have been moved already
  }

  let handoff: HandoffFile;
  try {
    handoff = JSON.parse(raw);
  } catch {
    console.error(`[PCD-dispatch] Invalid JSON in ${filePath}`);
    archiveFile(filePath);
    return;
  }

  if (!handoff.dispatch_id || !handoff.from || !handoff.type || !handoff.title) {
    console.error(`[PCD-dispatch] Missing required fields in ${filePath}`);
    archiveFile(filePath);
    return;
  }

  const db = getDb();

  // Check if already processed (dispatched/completed/failed/cancelled = skip)
  const existing = db
    .prepare("SELECT id, status FROM task_dispatches WHERE id = ?")
    .get(handoff.dispatch_id) as { id: string; status: string } | undefined;
  if (existing && existing.status !== "pending") {
    archiveFile(filePath);
    return;
  }

  // Resolve target agent
  const toAgent = handoff.to || resolveAgent(handoff.type, handoff.from);
  if (!toAgent) {
    sendCeoAlert(
      `Dispatch ${handoff.dispatch_id} (${handoff.title}) has no target agent and type "${handoff.type}" has no default routing.`,
    );
    archiveFile(filePath);
    return;
  }

  // Calculate chain depth
  let chainDepth = 0;
  if (handoff.parent_dispatch_id) {
    const parent = db
      .prepare("SELECT chain_depth FROM task_dispatches WHERE id = ?")
      .get(handoff.parent_dispatch_id) as { chain_depth: number } | undefined;
    chainDepth = (parent?.chain_depth ?? 0) + 1;
  }

  // Chain depth hard limit
  const { maxChainDepth: MAX_CHAIN_DEPTH, ceoWarnDepth: CEO_WARN_DEPTH, maxRetries: MAX_RETRIES } = getRuntimeConfig();
  if (chainDepth >= MAX_CHAIN_DEPTH) {
    const archivedPath = archiveFile(filePath);
    sendCeoAlert(
      `Dispatch chain depth ${chainDepth} reached limit for "${handoff.title}" (from: ${handoff.from}). Auto-cancelled.`,
    );
    if (existing) {
      db.prepare(
        "UPDATE task_dispatches SET status = 'cancelled', context_file = ?, dispatched_at = ? WHERE id = ?",
      ).run(archivedPath, Date.now(), handoff.dispatch_id);
    } else {
      db.prepare(
        `INSERT INTO task_dispatches (id, from_agent_id, to_agent_id, dispatch_type, status, title, context_file, parent_dispatch_id, chain_depth, created_at, dispatched_at)
         VALUES (?, ?, ?, ?, 'cancelled', ?, ?, ?, ?, ?, ?)`,
      ).run(
        handoff.dispatch_id, handoff.from, toAgent, handoff.type,
        handoff.title, archivedPath, handoff.parent_dispatch_id ?? null,
        chainDepth, Date.now(), Date.now(),
      );
    }
    emitDispatchCreated(handoff.dispatch_id);
    return;
  }

  const now = Date.now();

  // DB first, then archive — if the process dies between these two steps,
  // recovery will find a dispatched row with no context_file and re-send,
  // rather than an archived file with a pending row that never gets updated.
  if (existing) {
    db.prepare(
      `UPDATE task_dispatches
       SET status = 'dispatched', dispatched_at = ?
       WHERE id = ?`,
    ).run(now, handoff.dispatch_id);
  } else {
    db.prepare(
      `INSERT INTO task_dispatches (id, from_agent_id, to_agent_id, dispatch_type, status, title, context_file, parent_dispatch_id, chain_depth, created_at, dispatched_at)
       VALUES (?, ?, ?, ?, 'dispatched', ?, NULL, ?, ?, ?, ?)`,
    ).run(
      handoff.dispatch_id, handoff.from, toAgent, handoff.type,
      handoff.title, handoff.parent_dispatch_id ?? null,
      chainDepth, now, now,
    );
  }

  // Archive after DB commit — safe to lose this step on crash
  const archivedPath = archiveFile(filePath);
  db.prepare("UPDATE task_dispatches SET context_file = ? WHERE id = ?")
    .run(archivedPath, handoff.dispatch_id);

  // Deliver message to target agent (fire-and-forget, non-blocking)
  const msg = `DISPATCH:${handoff.dispatch_id} - ${handoff.title}`;
  const deliveryPromise = handoff.delivery_channel_id
    ? sendToAgentChannel(toAgent, msg, handoff.delivery_channel_id)
    : sendAgentMessage(toAgent, msg);
  deliveryPromise.then((delivered) => {
    if (!delivered) {
      db.prepare("UPDATE task_dispatches SET status = 'failed' WHERE id = ?").run(
        handoff.dispatch_id,
      );
      sendCeoAlert(
        `Failed to deliver dispatch "${handoff.title}" to ${toAgent} after ${MAX_RETRIES} retries.`,
      );
      emitDispatchUpdated(handoff.dispatch_id);
    }
  });

  emitDispatchCreated(handoff.dispatch_id);

  // CEO warning for deep chains
  if (chainDepth >= CEO_WARN_DEPTH) {
    sendCeoAlert(
      `Dispatch chain depth ${chainDepth} for "${handoff.title}" (${handoff.from} → ${toAgent}). Consider manual review.`,
    );
  }

  console.log(
    `[PCD-dispatch] Processed handoff: ${handoff.dispatch_id} (${handoff.from} → ${toAgent}, depth=${chainDepth})`,
  );
}

// ── Result file processing ──

function processResultFile(filePath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  let result: ResultFile;
  try {
    result = JSON.parse(raw);
  } catch {
    console.error(`[PCD-dispatch] Invalid result JSON in ${filePath}`);
    archiveFile(filePath);
    return;
  }

  if (!result.dispatch_id || !result.from || !result.status) {
    console.error(`[PCD-dispatch] Missing required fields in result ${filePath}`);
    archiveFile(filePath);
    return;
  }

  const db = getDb();

  // Find original dispatch
  const dispatch = db
    .prepare("SELECT * FROM task_dispatches WHERE id = ?")
    .get(result.dispatch_id) as {
      id: string;
      from_agent_id: string;
      to_agent_id: string;
      chain_depth: number;
      status: string;
      dispatch_type: string;
    } | undefined;

  if (!dispatch) {
    console.error(`[PCD-dispatch] No dispatch found for result ${result.dispatch_id}`);
    archiveFile(filePath);
    return;
  }

  // Map result status to dispatch status
  const dispatchStatus = result.status === "fail" ? "failed" : "completed";
  const now = Date.now();
  const archivedPath = archiveFile(filePath);

  db.prepare(
    `UPDATE task_dispatches SET status = ?, result_file = ?, result_summary = ?, completed_at = ? WHERE id = ?`,
  ).run(dispatchStatus, archivedPath, result.summary, now, result.dispatch_id);

  // Handle review verdict if present
  if (result.review_verdict && dispatch.dispatch_type === "review") {
    try {
      processReviewVerdict(db, result.dispatch_id, result.review_verdict);
    } catch (err) {
      console.error(`[PCD-dispatch] Review verdict processing failed for ${result.dispatch_id}:`, err);
    }
  }

  // Handle follow_up_request → create new handoff file (auto-chain)
  if (result.follow_up_request) {
    const followUp = result.follow_up_request;
    const newId = randomUUID();
    const newHandoff: HandoffFile = {
      dispatch_id: newId,
      from: result.from,
      to: followUp.to ?? null,
      type: followUp.type,
      title: `[Follow-up] ${followUp.detail.slice(0, 60)}`,
      parent_dispatch_id: result.dispatch_id,
      context: { summary: followUp.detail },
      instructions: followUp.detail,
    };
    const newPath = path.join(PCD_HANDOFF_DIR, `${newId}.json`);
    fs.writeFileSync(newPath, JSON.stringify(newHandoff, null, 2));
    console.log(
      `[PCD-dispatch] Created follow-up handoff: ${newId} (parent: ${result.dispatch_id})`,
    );
    // Will be picked up on next poll cycle
  }

  // Notify original requester (fire-and-forget)
  const notifyMsg = `DISPATCH_RESULT:${result.dispatch_id} - ${result.summary}`;
  sendAgentMessage(dispatch.from_agent_id, notifyMsg).catch(() => {});

  emitDispatchUpdated(result.dispatch_id);

  // CEO warning for deep chains
  if (dispatch.chain_depth >= getRuntimeConfig().ceoWarnDepth) {
    sendCeoAlert(
      `Dispatch chain result at depth ${dispatch.chain_depth}: "${result.summary}" (${result.status})`,
    );
  }

  console.log(
    `[PCD-dispatch] Processed result: ${result.dispatch_id} (${result.status}: ${result.summary?.slice(0, 60)})`,
  );
}

// ── Polling ──

function pollOnce(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(PCD_HANDOFF_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (entry.name === "." || entry.name === "..") continue;

    const filePath = path.join(PCD_HANDOFF_DIR, entry.name);

    if (entry.name.endsWith(".result.json")) {
      processResultFile(filePath);
    } else {
      processHandoffFile(filePath);
    }
  }
}

// ── Stale dispatch cleanup ──

function cleanupStaleDispatches(): void {
  const db = getDb();
  const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours (not configurable)
  const cutoff = Date.now() - STALE_THRESHOLD_MS;

  const stale = db
    .prepare(
      `SELECT id, title, to_agent_id FROM task_dispatches
       WHERE status = 'dispatched' AND dispatched_at < ?`,
    )
    .all(cutoff) as Array<{ id: string; title: string; to_agent_id: string }>;

  if (stale.length > 0) {
    const now = Date.now();
    const update = db.prepare(
      "UPDATE task_dispatches SET status = 'failed', completed_at = ? WHERE id = ?",
    );

    for (const s of stale) {
      update.run(now, s.id);
      emitDispatchUpdated(s.id);
    }

    sendCeoAlert(
      `${stale.length} stale dispatch(es) auto-failed after 24h: ${stale.map((s) => s.title).join(", ").slice(0, 200)}`,
    );
    console.log(`[PCD-dispatch] Cleaned up ${stale.length} stale dispatch(es)`);
  }

  const { timedOutRequested, stalledInProgress } = enforceKanbanTimeouts(db);
  if (timedOutRequested.length > 0) {
    sendCeoAlert(
      `${timedOutRequested.length} requested kanban card(s) timed out awaiting acceptance.`,
    );
    console.log(`[PCD-dispatch] Timed out ${timedOutRequested.length} requested kanban card(s)`);
  }
  if (stalledInProgress.length > 0) {
    sendCeoAlert(
      `${stalledInProgress.length} in-progress kanban card(s) auto-blocked due to stale activity.`,
    );
    console.log(`[PCD-dispatch] Blocked ${stalledInProgress.length} stale in-progress kanban card(s)`);
  }

}

// ── GitHub issue sync (independent timer) ──

function runGitHubIssueSync(): void {
  try {
    const db = getDb();
    const ghClosed = syncGitHubIssueStates(db);
    if (ghClosed.length > 0) {
      console.log(`[PCD-dispatch] GitHub sync: ${ghClosed.length} card(s) closed via issue state`);
    }
  } catch (error) {
    console.error("[PCD-dispatch] GitHub issue sync error:", error);
  }
}

// ── Recover pending dispatches that were archived but never completed ──
// This handles the race condition where the process is killed between
// archiving the handoff file and updating the DB / sending the message.

function recoverPendingDispatches(): void {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT id, to_agent_id, title
       FROM task_dispatches
       WHERE status = 'pending' AND dispatched_at IS NULL`,
    )
    .all() as Array<{ id: string; to_agent_id: string | null; title: string }>;

  if (pending.length === 0) return;

  for (const row of pending) {
    // Look for archived handoff file matching this dispatch id
    let archivedPath: string | null = null;
    try {
      const archiveEntries = fs.readdirSync(PCD_HANDOFF_ARCHIVE_DIR);
      const match = archiveEntries.find((name) => name.includes(row.id));
      if (match) {
        archivedPath = path.join(PCD_HANDOFF_ARCHIVE_DIR, match);
      }
    } catch {
      // archive dir may not exist yet
    }

    // Also check if the handoff file is still in the handoff dir (not yet picked up)
    // — if so, pollOnce() will handle it normally, skip recovery
    try {
      const handoffEntries = fs.readdirSync(PCD_HANDOFF_DIR);
      const stillPending = handoffEntries.find(
        (name) => name.endsWith(".json") && name.includes(row.id),
      );
      if (stillPending) continue;
    } catch {
      // ignore
    }

    if (!archivedPath) {
      // No handoff file found anywhere — mark as failed
      console.log(`[PCD-dispatch] Recovery: no handoff file for pending dispatch ${row.id}, marking failed`);
      db.prepare("UPDATE task_dispatches SET status = 'failed', completed_at = ? WHERE id = ?")
        .run(Date.now(), row.id);
      emitDispatchUpdated(row.id);
      continue;
    }

    // Read the archived handoff to get target agent
    let toAgent = row.to_agent_id;
    if (!toAgent) {
      try {
        const raw = fs.readFileSync(archivedPath, "utf-8");
        const handoff = JSON.parse(raw) as HandoffFile;
        toAgent = handoff.to || resolveAgent(handoff.type, handoff.from);
      } catch {
        // ignore parse errors
      }
    }

    if (!toAgent) {
      console.log(`[PCD-dispatch] Recovery: no target agent for dispatch ${row.id}, marking failed`);
      db.prepare("UPDATE task_dispatches SET status = 'failed', completed_at = ? WHERE id = ?")
        .run(Date.now(), row.id);
      emitDispatchUpdated(row.id);
      continue;
    }

    // Update DB to dispatched
    const now = Date.now();
    db.prepare(
      `UPDATE task_dispatches SET status = 'dispatched', context_file = ?, dispatched_at = ? WHERE id = ?`,
    ).run(archivedPath, now, row.id);

    // Re-send the dispatch message
    const msg = `DISPATCH:${row.id} - ${row.title}`;
    sendAgentMessage(toAgent, msg).then((delivered) => {
      if (!delivered) {
        db.prepare("UPDATE task_dispatches SET status = 'failed' WHERE id = ?").run(row.id);
        sendCeoAlert(
          `Recovery: failed to deliver dispatch "${row.title}" to ${toAgent} after ${getRuntimeConfig().maxRetries} retries.`,
        );
        emitDispatchUpdated(row.id);
      }
    });

    emitDispatchUpdated(row.id);
    console.log(`[PCD-dispatch] Recovered pending dispatch: ${row.id} → ${toAgent} ("${row.title}")`);
  }
}

// ── Public API ──

export function startDispatchWatcher(): void {
  ensureDirs();
  // Recover any dispatches left in pending state from a previous crash
  recoverPendingDispatches();
  // Process any existing files on startup
  pollOnce();

  // Primary: fs.watch for instant file detection
  try {
    watcher = fs.watch(PCD_HANDOFF_DIR, (_eventType, filename) => {
      if (filename?.endsWith(".json")) debouncedPoll();
    });
    watcher.on("error", (err) => {
      console.error("[PCD] dispatch-watcher fs.watch error:", err);
    });
  } catch {
    console.warn("[PCD] dispatch-watcher: fs.watch unavailable, using polling only");
  }

  // Safety fallback: poll in case fs.watch misses events
  const cfg = getRuntimeConfig();
  const pollMs = cfg.dispatchPollSec * 1000;
  const STALE_CHECK_MS = 60 * 60 * 1000; // 1 hour (fixed)
  const ghSyncMs = cfg.githubIssueSyncSec * 1000;
  pollTimer = setInterval(pollOnce, pollMs);
  staleTimer = setInterval(cleanupStaleDispatches, STALE_CHECK_MS);

  // GitHub issue sync: independent timer + immediate first run
  runGitHubIssueSync();
  ghSyncTimer = setInterval(runGitHubIssueSync, ghSyncMs);

  console.log(
    `[PCD] dispatch-watcher started (mode=fs.watch+${cfg.dispatchPollSec}s-fallback, stale-check=60min)`,
  );
  console.log(
    `[PCD] GitHub issue sync started (interval=${Math.round(cfg.githubIssueSyncSec / 60)}min)`,
  );
}

export function stopDispatchWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (pollDebounce) {
    clearTimeout(pollDebounce);
    pollDebounce = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (staleTimer) {
    clearInterval(staleTimer);
    staleTimer = null;
  }
  if (ghSyncTimer) {
    clearInterval(ghSyncTimer);
    ghSyncTimer = null;
  }
}
