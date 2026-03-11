import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "./db/runtime.js";
import { enforceKanbanTimeouts, syncKanbanCardWithDispatch } from "./kanban-cards.js";
import { broadcast } from "./ws.js";
import { resolveAgent } from "./dispatch-routing.js";
import { sendToAgentChannel } from "./discord-announce.js";
import { PCD_HANDOFF_ARCHIVE_DIR, PCD_HANDOFF_DIR, ensurePcdRuntimeDirs } from "./runtime-paths.js";

const POLL_MS = 2000;
const STALE_CHECK_MS = 60 * 60 * 1000; // 1 hour
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CHAIN_DEPTH = 5;
const CEO_WARN_DEPTH = 3;
const MAX_RETRIES = 3;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let staleTimer: ReturnType<typeof setInterval> | null = null;

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
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ok = await sendToAgentChannel(agentId, message);
    if (ok) {
      console.log(`[PCD-dispatch] Delivered to ${agentId}: ${message.slice(0, 80)}`);
      return true;
    }
    console.error(
      `[PCD-dispatch] Delivery attempt ${attempt}/${MAX_RETRIES} to ${agentId} failed`,
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

  // Check if already processed
  const existing = db
    .prepare("SELECT id FROM task_dispatches WHERE id = ?")
    .get(handoff.dispatch_id) as { id: string } | undefined;
  if (existing) {
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
  if (chainDepth >= MAX_CHAIN_DEPTH) {
    const archivedPath = archiveFile(filePath);
    sendCeoAlert(
      `Dispatch chain depth ${chainDepth} reached limit for "${handoff.title}" (from: ${handoff.from}). Auto-cancelled.`,
    );
    db.prepare(
      `INSERT INTO task_dispatches (id, from_agent_id, to_agent_id, dispatch_type, status, title, context_file, parent_dispatch_id, chain_depth, created_at, dispatched_at)
       VALUES (?, ?, ?, ?, 'cancelled', ?, ?, ?, ?, ?, ?)`,
    ).run(
      handoff.dispatch_id, handoff.from, toAgent, handoff.type,
      handoff.title, archivedPath, handoff.parent_dispatch_id ?? null,
      chainDepth, Date.now(), Date.now(),
    );
    emitDispatchCreated(handoff.dispatch_id);
    return;
  }

  const now = Date.now();
  const archivedPath = archiveFile(filePath);

  // Insert into DB
  db.prepare(
    `INSERT INTO task_dispatches (id, from_agent_id, to_agent_id, dispatch_type, status, title, context_file, parent_dispatch_id, chain_depth, created_at, dispatched_at)
     VALUES (?, ?, ?, ?, 'dispatched', ?, ?, ?, ?, ?, ?)`,
  ).run(
    handoff.dispatch_id, handoff.from, toAgent, handoff.type,
    handoff.title, archivedPath, handoff.parent_dispatch_id ?? null,
    chainDepth, now, now,
  );

  // Deliver message to target agent (fire-and-forget, non-blocking)
  const msg = `DISPATCH:${handoff.dispatch_id} - ${handoff.title}`;
  sendAgentMessage(toAgent, msg).then((delivered) => {
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
  if (dispatch.chain_depth >= CEO_WARN_DEPTH) {
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

// ── Public API ──

export function startDispatchWatcher(): void {
  ensureDirs();
  // Process any existing files on startup
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
  staleTimer = setInterval(cleanupStaleDispatches, STALE_CHECK_MS);
  console.log(
    `[PCD] dispatch-watcher started (poll=${POLL_MS / 1000}s, stale-check=${STALE_CHECK_MS / 1000 / 60}min)`,
  );
}

export function stopDispatchWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (staleTimer) {
    clearInterval(staleTimer);
    staleTimer = null;
  }
}
