import { execSync } from "node:child_process";
import { getDb } from "./db/runtime.js";
import { broadcast } from "./ws.js";

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min without heartbeat → check tmux
const CHECK_INTERVAL_MS = 60 * 1000; // check every 60 sec

let timer: ReturnType<typeof setInterval> | null = null;

/** Get live tmux session names */
function getLiveTmuxSessions(): Set<string> {
  const out = new Set<string>();
  try {
    const text = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
      timeout: 3000,
      encoding: "utf-8",
    });
    for (const line of text.split("\n")) {
      const name = line.trim();
      if (name) out.add(name);
    }
  } catch {
    // tmux not running or no sessions
  }
  return out;
}

/** Extract tmux session name from session_key (e.g. "host:remoteCC-foo" → "remoteCC-foo") */
function extractTmuxName(sessionKey: string): string | null {
  const idx = sessionKey.indexOf(":remoteCC-");
  if (idx < 0) return null;
  return sessionKey.slice(idx + 1);
}

export function reconcileDispatchedOnce(): number {
  const db = getDb();
  const cutoff = Date.now() - STALE_THRESHOLD_MS;

  const stale = db
    .prepare(
      `SELECT id, session_key FROM dispatched_sessions
       WHERE status != 'disconnected' AND last_seen_at < ?`,
    )
    .all(cutoff) as Array<{ id: string; session_key: string }>;

  if (stale.length === 0) return 0;

  const liveTmux = getLiveTmuxSessions();
  const now = Date.now();
  const update = db.prepare(
    "UPDATE dispatched_sessions SET status = ?, last_seen_at = ? WHERE id = ?",
  );

  let disconnected = 0;
  for (const s of stale) {
    const tmuxName = extractTmuxName(s.session_key);
    if (tmuxName && liveTmux.has(tmuxName)) {
      // tmux session alive → keep as idle, refresh timestamp
      update.run("idle", now, s.id);
      const row = db
        .prepare("SELECT * FROM dispatched_sessions WHERE id = ?")
        .get(s.id);
      broadcast("dispatched_session_update", row);
    } else {
      // tmux session gone → disconnect
      update.run("disconnected", now, s.id);
      broadcast("dispatched_session_disconnect", { id: s.id });
      disconnected++;
    }
  }

  if (disconnected > 0) {
    console.log(
      `[PCD] dispatched-sync: disconnected ${disconnected} dead session(s)`,
    );
  }
  return disconnected;
}

export function startDispatchedSync(): void {
  reconcileDispatchedOnce();
  timer = setInterval(reconcileDispatchedOnce, CHECK_INTERVAL_MS);
  console.log(
    `[PCD] dispatched-sync started (stale=${STALE_THRESHOLD_MS / 1000}s, check=${CHECK_INTERVAL_MS / 1000}s)`,
  );
}

export function stopDispatchedSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
