import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { getDb } from "./db/runtime.js";
import { broadcast } from "./ws.js";

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const AGENT_SYNC_INTERVAL_MS = 3 * 60 * 1000; // 3 min
const STATUS_RECONCILE_INTERVAL_MS = 45 * 1000; // 45 sec

interface OpenClawAgent {
  id: string;
  name?: string;
  identity?: {
    name?: string;
    emoji?: string;
  };
}

function getOpenClawAgents(): OpenClawAgent[] {
  if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) return [];
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const list = parsed?.agents?.list;
    if (!Array.isArray(list)) return [];
    return list.filter((a) => typeof a?.id === "string");
  } catch (e) {
    console.error("[PCD] agent-sync: failed to parse openclaw.json", e);
    return [];
  }
}

function getActiveAgentIds(): Set<string> {
  const out = new Set<string>();
  try {
    const text = execSync("openclaw sessions --active 5 --json 2>/dev/null", {
      timeout: 5000,
      encoding: "utf-8",
    });
    const sessions = JSON.parse(text);
    if (!Array.isArray(sessions)) return out;

    for (const s of sessions) {
      const key = String(s?.sessionKey ?? s?.key ?? "");
      const m = key.match(/agent:([^:]+):/);
      if (m?.[1]) out.add(m[1]);
    }
  } catch {
    // ignore: openclaw CLI might be unavailable temporarily
  }
  return out;
}

export function syncAgentsOnce(): number {
  const srcAgents = getOpenClawAgents();
  if (srcAgents.length === 0) return 0;

  const db = getDb();
  const hasMainOffice = Boolean(
    db.prepare("SELECT 1 FROM offices WHERE id = 'main' LIMIT 1").get(),
  );

  const findByOc = db.prepare("SELECT id FROM agents WHERE openclaw_id = ?");
  const insertAgent = db.prepare(
    `INSERT INTO agents (id, openclaw_id, name, name_ko, role, avatar_emoji, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const linkOffice = db.prepare(
    "INSERT OR IGNORE INTO office_agents (office_id, agent_id, department_id) VALUES ('main', ?, NULL)",
  );

  let created = 0;
  for (const a of srcAgents) {
    const exists = findByOc.get(a.id) as { id: string } | undefined;
    if (exists) continue;

    const displayName = a.identity?.name || a.name || a.id;
    const emoji = a.identity?.emoji || "🙂";
    const id = crypto.randomUUID();

    insertAgent.run(id, a.id, displayName, displayName, "senior", emoji, "idle");
    if (hasMainOffice) linkOffice.run(id);

    const createdRow = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    broadcast("agent_created", createdRow);
    created++;
  }

  if (created > 0) {
    console.log(`[PCD] agent-sync: created ${created} agent(s)`);
  }
  return created;
}

export function reconcileAgentStatusOnce(): number {
  const active = getActiveAgentIds();
  const db = getDb();

  const workingNow = db
    .prepare("SELECT id, openclaw_id, status FROM agents WHERE openclaw_id IS NOT NULL")
    .all() as Array<{ id: string; openclaw_id: string; status: string }>;

  const toWorking: string[] = [];
  const toIdle: string[] = [];

  for (const a of workingNow) {
    if (active.has(a.openclaw_id)) {
      if (a.status !== "working") toWorking.push(a.id);
    } else if (a.status === "working") {
      toIdle.push(a.id);
    }
  }

  const setStatus = db.prepare("UPDATE agents SET status = ? WHERE id = ?");
  for (const id of toWorking) setStatus.run("working", id);
  for (const id of toIdle) setStatus.run("idle", id);

  const changed = toWorking.length + toIdle.length;
  if (changed > 0) {
    for (const id of [...toWorking, ...toIdle]) {
      const row = db
        .prepare(
          `SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color
           FROM agents a LEFT JOIN departments d ON a.department_id = d.id
           WHERE a.id = ?`,
        )
        .get(id);
      broadcast("agent_status", row);
    }
    console.log(`[PCD] status-reconcile: updated ${changed} agent(s)`);
  }

  return changed;
}

let syncTimer: ReturnType<typeof setInterval> | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

export function startAgentSync(): void {
  syncAgentsOnce();
  reconcileAgentStatusOnce();

  syncTimer = setInterval(() => {
    syncAgentsOnce();
  }, AGENT_SYNC_INTERVAL_MS);

  reconcileTimer = setInterval(() => {
    reconcileAgentStatusOnce();
  }, STATUS_RECONCILE_INTERVAL_MS);

  console.log(
    `[PCD] agent-sync started (sync=${AGENT_SYNC_INTERVAL_MS / 1000}s, reconcile=${STATUS_RECONCILE_INTERVAL_MS / 1000}s)`,
  );
}

export function stopAgentSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}
