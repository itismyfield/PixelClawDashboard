import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb } from "./db/runtime.js";
import { broadcast } from "./ws.js";

const CRON_DIR = path.join(os.homedir(), ".openclaw", "cron");
const JOBS_PATH = path.join(CRON_DIR, "jobs.json");
const RUNS_DIR = path.join(CRON_DIR, "runs");

/** 1000 tokens = 1 XP */
const TOKENS_PER_XP = 1000;

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CronJobEntry {
  id: string;
  agentId?: string;
}

interface RunRecord {
  action?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

function buildAgentTokenMap(): Map<string, number> {
  const agentTokens = new Map<string, number>();

  if (!fs.existsSync(JOBS_PATH) || !fs.existsSync(RUNS_DIR)) return agentTokens;

  // Map jobId → agentId
  const jobsData = JSON.parse(fs.readFileSync(JOBS_PATH, "utf-8"));
  const jobAgent = new Map<string, string>();
  for (const job of (jobsData.jobs || []) as CronJobEntry[]) {
    if (job.agentId) jobAgent.set(job.id, job.agentId);
  }

  // Read all JSONL run files
  for (const file of fs.readdirSync(RUNS_DIR)) {
    if (!file.endsWith(".jsonl")) continue;
    const jobId = file.replace(".jsonl", "");
    const agentId = jobAgent.get(jobId);
    if (!agentId) continue;

    const content = fs.readFileSync(path.join(RUNS_DIR, file), "utf-8");
    let total = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as RunRecord;
        if (rec.action === "finished" && rec.usage?.total_tokens) {
          total += rec.usage.total_tokens;
        }
      } catch {
        // skip malformed lines
      }
    }

    agentTokens.set(agentId, (agentTokens.get(agentId) || 0) + total);
  }

  return agentTokens;
}

export function syncXp(): void {
  try {
    const agentTokens = buildAgentTokenMap();
    if (agentTokens.size === 0) return;

    const db = getDb();
    const update = db.prepare("UPDATE agents SET stats_xp = ? WHERE openclaw_id = ?");
    let changed = 0;

    for (const [openclawId, tokens] of agentTokens) {
      const xp = Math.floor(tokens / TOKENS_PER_XP);
      const agent = db
        .prepare("SELECT id, stats_xp FROM agents WHERE openclaw_id = ?")
        .get(openclawId) as { id: string; stats_xp: number } | undefined;
      if (!agent || agent.stats_xp === xp) continue;

      update.run(xp, openclawId);
      changed++;
    }

    if (changed > 0) {
      console.log(`[PCD] XP sync: updated ${changed} agent(s)`);
      broadcast("xp_sync", { updated: changed });
    }
  } catch (e) {
    console.error("[PCD] XP sync error:", e);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startXpSync(): void {
  syncXp();
  timer = setInterval(syncXp, SYNC_INTERVAL_MS);
  console.log(`[PCD] XP sync started (every ${SYNC_INTERVAL_MS / 1000}s)`);
}

export function stopXpSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
