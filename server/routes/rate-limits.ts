import { Router } from "express";
import { execFile, execFileSync } from "node:child_process";
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

const STALE_MS = 5 * 60 * 1000; // 5 min
const CLAUDE_POLL_INTERVAL = 5 * 60 * 1000; // 5 min
const CACHE_DIR = path.join(os.homedir(), ".local", "state", "pixel-claw-dashboard");
const RATE_LIMIT_CACHE_FILE = path.join(CACHE_DIR, "rate-limit-cache.json");

function classifyLevel(util: number): "normal" | "warning" | "danger" {
  if (util >= 90) return "danger";
  if (util >= 80) return "warning";
  return "normal";
}

// ── Persistent cache helpers ──

interface PersistedCache {
  claude?: ClaudeCacheData;
  codex?: CodexCacheEntry;
}

function persistCache(): void {
  try {
    const data: PersistedCache = {};
    if (claudeCache) data.claude = claudeCache;
    if (codexCache) data.codex = codexCache;
    fs.writeFileSync(RATE_LIMIT_CACHE_FILE, JSON.stringify(data), "utf-8");
  } catch { /* best effort */ }
}

function loadPersistedCache(): void {
  try {
    const raw = fs.readFileSync(RATE_LIMIT_CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as PersistedCache;
    if (data.claude && !claudeCache) claudeCache = data.claude;
    if (data.codex && !codexCache) codexCache = data.codex;
  } catch { /* no cache file yet */ }
}

// ── Claude: direct Anthropic API polling ──

let claudeCache: ClaudeCacheData | null = null;
let claudePollTimer: ReturnType<typeof setInterval> | null = null;

function getClaudeOAuthToken(): string | null {
  try {
    const result = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const creds = JSON.parse(result) as { claudeAiOauth?: { accessToken?: string } };
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    // Fallback to credentials file
    try {
      const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
      const raw = fs.readFileSync(credPath, "utf-8");
      const creds = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      return creds?.claudeAiOauth?.accessToken ?? null;
    } catch {
      return null;
    }
  }
}

async function pollClaudeUsage(): Promise<void> {
  try {
    const token = getClaudeOAuthToken();
    if (!token) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/1.0.0",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      if (response.status === 429) {
        // Keep stale cache visible instead of hiding Claude entirely
        if (claudeCache) claudeCache.timestamp = claudeCache.timestamp;
        console.warn("[rate-limits] Claude usage API 429 — keeping stale cache");
      } else {
        console.error(`[rate-limits] Claude usage API ${response.status}`);
      }
      return;
    }

    const data = (await response.json()) as Record<string, RateLimitBucket | undefined>;
    claudeCache = {
      data: {
        five_hour: data.five_hour,
        seven_day: data.seven_day,
        seven_day_sonnet: data.seven_day_sonnet,
      },
      timestamp: Date.now(),
    };
    persistCache();
  } catch (e) {
    console.error("[rate-limits] Claude usage poll error:", (e as Error).message);
  }
}

function readClaudeCache(): ClaudeCacheData | null {
  return claudeCache;
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

const CODEX_FETCH_SCRIPT = `
import json, os, urllib.request, sys
auth = json.load(open(os.path.expanduser("~/.codex/auth.json")))
token = auth.get("tokens", {}).get("access_token", "")
if not token:
    sys.exit(1)
req = urllib.request.Request(
    "https://chatgpt.com/backend-api/codex/usage",
    headers={
        "Authorization": f"Bearer {token}",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "application/json",
    },
)
with urllib.request.urlopen(req, timeout=15) as resp:
    sys.stdout.write(resp.read().decode())
`;

async function pollCodexUsage(): Promise<void> {
  return new Promise<void>((resolve) => {
    execFile("python3", ["-c", CODEX_FETCH_SCRIPT], { timeout: 20_000 }, (err, stdout) => {
      if (err) {
        console.error("[rate-limits] Codex usage poll error:", err.message);
        return resolve();
      }
      try {
        const data = JSON.parse(stdout) as CodexUsageResponse;
        codexCache = { data, timestamp: Date.now() };
        persistCache();
      } catch (e) {
        console.error("[rate-limits] Codex usage parse error:", e);
      }
      resolve();
    });
  });
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

export function startRateLimitPolling(): void {
  loadPersistedCache();
  pollClaudeUsage();
  claudePollTimer = setInterval(pollClaudeUsage, CLAUDE_POLL_INTERVAL);
  pollCodexUsage();
  codexPollTimer = setInterval(pollCodexUsage, CODEX_POLL_INTERVAL);
}

export function stopRateLimitPolling(): void {
  if (claudePollTimer) {
    clearInterval(claudePollTimer);
    claudePollTimer = null;
  }
  if (codexPollTimer) {
    clearInterval(codexPollTimer);
    codexPollTimer = null;
  }
}

/** @deprecated Use startRateLimitPolling instead */
export function startCodexPoll(): void {
  startRateLimitPolling();
}

/** @deprecated Use stopRateLimitPolling instead */
export function stopCodexPoll(): void {
  stopRateLimitPolling();
}

export default router;
