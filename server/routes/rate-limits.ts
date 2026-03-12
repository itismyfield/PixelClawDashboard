import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const router = Router();

interface RateLimitBucket {
  utilization: number;
  resets_at: string;
}

interface CacheData {
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

const CACHE_DIR = path.join(os.homedir(), ".cache", "claude-dashboard");
const STALE_MS = 5 * 60 * 1000; // 5 min

function classifyLevel(util: number): "normal" | "warning" | "danger" {
  if (util >= 90) return "danger";
  if (util >= 80) return "warning";
  return "normal";
}

function readClaudeCache(): CacheData | null {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith("cache-") && f.endsWith(".json"));
    if (files.length === 0) return null;

    // Pick the most recently modified cache file
    let latest = files[0];
    let latestMtime = 0;
    for (const f of files) {
      const st = fs.statSync(path.join(CACHE_DIR, f));
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latest = f;
      }
    }

    const raw = fs.readFileSync(path.join(CACHE_DIR, latest), "utf-8");
    return JSON.parse(raw) as CacheData;
  } catch {
    return null;
  }
}

router.get("/api/rate-limits", (_req, res) => {
  const results: RateLimitResponse[] = [];

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

    results.push({
      provider: "Claude",
      buckets,
      fetched_at: claude.timestamp,
      stale,
    });
  }

  res.json({ providers: results });
});

export default router;
