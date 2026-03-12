import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const router = Router();

interface RateLimitBucket {
  utilization: number;
  resets_at: string;
}

interface ClaudeCacheData {
  data: {
    five_hour?: RateLimitBucket;
    seven_day?: RateLimitBucket;
    seven_day_sonnet?: RateLimitBucket;
  };
  timestamp: number;
}

interface RateLimitResponse {
  provider: string;
  buckets: Array<{
    id: string;
    label: string;
    utilization: number;
    resets_at: string | null;
    level: "normal" | "warning" | "danger";
  }>;
  fetched_at: number;
  stale: boolean;
}

const CLAUDE_CACHE_DIR = path.join(os.homedir(), ".cache", "claude-dashboard");
const STALE_MS = 5 * 60 * 1000; // 5 min

function classifyLevel(util: number): "normal" | "warning" | "danger" {
  if (util >= 90) return "danger";
  if (util >= 80) return "warning";
  return "normal";
}

// ── Claude: read local plugin cache ──

function readClaudeCache(): ClaudeCacheData | null {
  try {
    const files = fs.readdirSync(CLAUDE_CACHE_DIR).filter((f) => f.startsWith("cache-") && f.endsWith(".json"));
    if (files.length === 0) return null;

    let latest = files[0];
    let latestMtime = 0;
    for (const f of files) {
      const st = fs.statSync(path.join(CLAUDE_CACHE_DIR, f));
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latest = f;
      }
    }

    const raw = fs.readFileSync(path.join(CLAUDE_CACHE_DIR, latest), "utf-8");
    return JSON.parse(raw) as ClaudeCacheData;
  } catch {
    return null;
  }
}

// ── Codex: poll chatgpt.com backend API ──

interface CodexWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

interface CodexUsageResponse {
  rate_limit?: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window?: CodexWindow;
    secondary_window?: CodexWindow;
  };
}

interface CodexCacheEntry {
  data: CodexUsageResponse;
  timestamp: number;
}

const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const CODEX_POLL_INTERVAL = 2 * 60 * 1000; // 2 min
let codexCache: CodexCacheEntry | null = null;
let codexPollTimer: ReturnType<typeof setInterval> | null = null;

function loadCodexAccessToken(): string | null {
  try {
    const raw = fs.readFileSync(CODEX_AUTH_PATH, "utf-8");
    const auth = JSON.parse(raw) as { tokens?: { access_token?: string } };
    return auth.tokens?.access_token || null;
  } catch {
    return null;
  }
}

async function pollCodexUsage(): Promise<void> {
  const token = loadCodexAccessToken();
  if (!token) return;

  try {
    const resp = await fetch("https://chatgpt.com/backend-api/codex/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "codex-cli/0.114.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.error(`[rate-limits] Codex usage fetch failed: ${resp.status}`);
      return;
    }
    const data = (await resp.json()) as CodexUsageResponse;
    codexCache = { data, timestamp: Date.now() };
  } catch (err) {
    console.error("[rate-limits] Codex usage poll error:", err);
  }
}

function windowToResetIso(w: CodexWindow): string {
  return new Date(w.reset_at * 1000).toISOString();
}

function windowLabel(seconds: number): string {
  if (seconds <= 18000) return "5h";
  if (seconds <= 86400) return "1d";
  return "7d";
}

// ── API route ──

router.get("/api/rate-limits", (_req, res) => {
  const results: RateLimitResponse[] = [];

  // Claude
  const claude = readClaudeCache();
  if (claude?.data) {
    const stale = Date.now() - claude.timestamp > STALE_MS;
    const buckets: RateLimitResponse["buckets"] = [];

    if (claude.data.five_hour) {
      buckets.push({
        id: "5h",
        label: "5h",
        utilization: claude.data.five_hour.utilization,
        resets_at: claude.data.five_hour.resets_at,
        level: classifyLevel(claude.data.five_hour.utilization),
      });
    }
    if (claude.data.seven_day) {
      buckets.push({
        id: "7d",
        label: "7d",
        utilization: claude.data.seven_day.utilization,
        resets_at: claude.data.seven_day.resets_at,
        level: classifyLevel(claude.data.seven_day.utilization),
      });
    }
    if (claude.data.seven_day_sonnet) {
      buckets.push({
        id: "7d_sonnet",
        label: "7d Sonnet",
        utilization: claude.data.seven_day_sonnet.utilization,
        resets_at: claude.data.seven_day_sonnet.resets_at,
        level: classifyLevel(claude.data.seven_day_sonnet.utilization),
      });
    }

    results.push({ provider: "Claude", buckets, fetched_at: claude.timestamp, stale });
  }

  // Codex
  if (codexCache?.data.rate_limit) {
    const rl = codexCache.data.rate_limit;
    const stale = Date.now() - codexCache.timestamp > STALE_MS;
    const buckets: RateLimitResponse["buckets"] = [];

    if (rl.primary_window) {
      buckets.push({
        id: "primary",
        label: windowLabel(rl.primary_window.limit_window_seconds),
        utilization: rl.primary_window.used_percent,
        resets_at: windowToResetIso(rl.primary_window),
        level: classifyLevel(rl.primary_window.used_percent),
      });
    }
    if (rl.secondary_window) {
      buckets.push({
        id: "secondary",
        label: windowLabel(rl.secondary_window.limit_window_seconds),
        utilization: rl.secondary_window.used_percent,
        resets_at: windowToResetIso(rl.secondary_window),
        level: classifyLevel(rl.secondary_window.used_percent),
      });
    }

    results.push({ provider: "Codex", buckets, fetched_at: codexCache.timestamp, stale });
  }

  res.json({ providers: results });
});

// ── Lifecycle ──

export function startCodexPoll(): void {
  pollCodexUsage();
  codexPollTimer = setInterval(pollCodexUsage, CODEX_POLL_INTERVAL);
}

export function stopCodexPoll(): void {
  if (codexPollTimer) {
    clearInterval(codexPollTimer);
    codexPollTimer = null;
  }
}

export default router;
