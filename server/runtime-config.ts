/**
 * Runtime Config — DB-backed runtime settings with defaults.
 *
 * Each module reads from getRuntimeConfig() instead of hardcoded constants.
 * Values are stored in the existing `settings` table under the key "runtimeConfig".
 */

import { getDb } from "./db/runtime.js";

export interface RuntimeConfig {
  // Polling & Timers (in seconds for UI, converted to ms internally)
  dispatchPollSec: number;
  agentSyncSec: number;
  githubIssueSyncSec: number;
  claudeRateLimitPollSec: number;
  codexRateLimitPollSec: number;
  issueTriagePollSec: number;

  // Kanban Timeouts (minutes)
  requestedAckTimeoutMin: number;
  inProgressStaleMin: number;

  // Dispatch Limits
  maxChainDepth: number;
  ceoWarnDepth: number;
  maxRetries: number;

  // Rate Limit Thresholds (percent)
  rateLimitWarningPct: number;
  rateLimitDangerPct: number;

  // Cache TTL (seconds)
  githubRepoCacheSec: number;
  rateLimitStaleSec: number;
}

export const RUNTIME_CONFIG_DEFAULTS: RuntimeConfig = {
  dispatchPollSec: 30,
  agentSyncSec: 300,          // 5 min
  githubIssueSyncSec: 600,    // 10 min
  claudeRateLimitPollSec: 300, // 5 min
  codexRateLimitPollSec: 120,  // 2 min
  issueTriagePollSec: 300,     // 5 min

  requestedAckTimeoutMin: 45,
  inProgressStaleMin: 60,

  maxChainDepth: 5,
  ceoWarnDepth: 3,
  maxRetries: 3,

  rateLimitWarningPct: 80,
  rateLimitDangerPct: 90,

  githubRepoCacheSec: 300,     // 5 min
  rateLimitStaleSec: 300,      // 5 min
};

const DB_KEY = "runtimeConfig";

let cached: RuntimeConfig | null = null;
let cacheTs = 0;
const CACHE_TTL = 5_000; // re-read from DB at most every 5s

export function getRuntimeConfig(): RuntimeConfig {
  const now = Date.now();
  if (cached && now - cacheTs < CACHE_TTL) return cached;

  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(DB_KEY) as
      | { value: string }
      | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<RuntimeConfig>;
      cached = { ...RUNTIME_CONFIG_DEFAULTS, ...parsed };
    } else {
      cached = { ...RUNTIME_CONFIG_DEFAULTS };
    }
  } catch {
    cached = { ...RUNTIME_CONFIG_DEFAULTS };
  }
  cacheTs = now;
  return cached;
}

/** Invalidate in-memory cache so next call re-reads from DB */
export function invalidateRuntimeConfigCache(): void {
  cached = null;
  cacheTs = 0;
}
