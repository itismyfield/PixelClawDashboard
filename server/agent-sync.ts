import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "./db/runtime.js";
import { broadcast } from "./ws.js";
import { listRoleBindings } from "./role-map.js";

import { getRuntimeConfig } from "./runtime-config.js";
// Intervals read from runtime config at start time
const AGENT_SYNC_SAFETY_MS = 10 * 60 * 1000; // 10 min safety fallback (fs.watch is primary)
const ROLE_MAP_PATH = path.join(os.homedir(), ".remotecc", "role_map.json");

interface ConfiguredAgent {
  id: string;
  name: string;
  emoji: string;
}

interface RoleBindingLike {
  roleId?: string | null;
}

interface WorkingStatusRow {
  id: string;
  status: string;
  remotecc_working_count: number;
}

export function inferDisplayName(roleId: string): string {
  if (roleId.startsWith("ch-")) return roleId.slice(3).toUpperCase();
  if (roleId.endsWith("-agent")) return roleId.replace(/-agent$/, "");
  return roleId;
}

export function inferDisplayEmoji(roleId: string): string {
  const normalized = roleId.trim().toLowerCase();
  if (!normalized) return "🙂";

  const directMap: Record<string, string> = {
    "ch-pmd": "📋",
    "ch-pd": "🎬",
    "ch-dd": "🎮",
    "ch-td": "⚙️",
    "ch-ad": "🎨",
    "ch-tad": "🔧",
    "ch-qad": "🔍",
    "family-routine": "⏰",
    "family-counsel": "💚",
    "project-pixelclawdashboard": "🐾",
    "project-remotecc": "📡",
    "project-agentfactory": "🏭",
    "project-scheduler": "🗓️",
  };

  return directMap[normalized] ?? "🙂";
}

export function collectConfiguredAgents(bindings: RoleBindingLike[]): ConfiguredAgent[] {
  const out = new Map<string, ConfiguredAgent>();
  for (const binding of bindings) {
    if (!binding.roleId || out.has(binding.roleId)) continue;
    out.set(binding.roleId, {
      id: binding.roleId,
      name: inferDisplayName(binding.roleId),
      emoji: inferDisplayEmoji(binding.roleId),
    });
  }
  return [...out.values()];
}

export function getIdleAgentIdsFromWorkingRows(rows: WorkingStatusRow[]): string[] {
  return rows
    .filter((row) => Number(row.remotecc_working_count || 0) === 0)
    .map((row) => row.id);
}

function getConfiguredAgents(): ConfiguredAgent[] {
  return collectConfiguredAgents(listRoleBindings());
}

export function syncAgentsOnce(): number {
  const srcAgents = getConfiguredAgents();
  if (srcAgents.length === 0) return 0;

  const db = getDb();
  const hasMainOffice = Boolean(
    db.prepare("SELECT 1 FROM offices WHERE id = 'main' LIMIT 1").get(),
  );

  const findByOc = db.prepare("SELECT id FROM agents WHERE role_id = ?");
  const insertAgent = db.prepare(
    `INSERT INTO agents (id, role_id, name, name_ko, role, avatar_emoji, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const linkOffice = db.prepare(
    "INSERT OR IGNORE INTO office_agents (office_id, agent_id, department_id) VALUES ('main', ?, NULL)",
  );

  let created = 0;
  for (const a of srcAgents) {
    const exists = findByOc.get(a.id) as { id: string } | undefined;
    if (exists) continue;

    const id = crypto.randomUUID();

    insertAgent.run(id, a.id, a.name, a.name, "senior", a.emoji, "idle");
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
  const db = getDb();

  const workingNow = db
    .prepare(
      `SELECT a.id, a.status, COALESCE(ds.remotecc_working_count, 0) AS remotecc_working_count
       FROM agents a
       LEFT JOIN (
         SELECT linked_agent_id AS aid,
                SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) AS remotecc_working_count
         FROM dispatched_sessions
         WHERE linked_agent_id IS NOT NULL AND status != 'disconnected'
         GROUP BY linked_agent_id
       ) ds ON ds.aid = a.id
       WHERE a.status = 'working'`,
    )
    .all() as unknown as WorkingStatusRow[];

  const toIdle = getIdleAgentIdsFromWorkingRows(workingNow);

  const setStatus = db.prepare("UPDATE agents SET status = ? WHERE id = ?");
  for (const id of toIdle) setStatus.run("idle", id);

  const changed = toIdle.length;
  if (changed > 0) {
    for (const id of toIdle) {
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
let roleMapWatcher: fs.FSWatcher | null = null;
let syncDebounce: ReturnType<typeof setTimeout> | null = null;

function debouncedSync(): void {
  if (syncDebounce) return;
  syncDebounce = setTimeout(() => {
    syncDebounce = null;
    syncAgentsOnce();
  }, 500);
}

export function startAgentSync(): void {
  syncAgentsOnce();
  reconcileAgentStatusOnce();

  // Primary: fs.watch on role_map.json for instant agent sync
  try {
    if (fs.existsSync(ROLE_MAP_PATH)) {
      roleMapWatcher = fs.watch(ROLE_MAP_PATH, () => debouncedSync());
      roleMapWatcher.on("error", () => {});
    }
  } catch {
    // fs.watch unavailable — safety interval handles it
  }

  // Safety fallback: sync every 10min in case fs.watch misses
  syncTimer = setInterval(() => {
    syncAgentsOnce();
  }, AGENT_SYNC_SAFETY_MS);

  // Reconcile: safety sweep (hook.ts drives real-time updates)
  const reconcileMs = getRuntimeConfig().agentSyncSec * 1000;
  reconcileTimer = setInterval(() => {
    reconcileAgentStatusOnce();
  }, reconcileMs);

  console.log(
    `[PCD] agent-sync started (source=role_map, sync=fs.watch+${AGENT_SYNC_SAFETY_MS / 1000 / 60}min-fallback, reconcile=${reconcileMs / 1000}s-safety)`,
  );
}

export function stopAgentSync(): void {
  if (roleMapWatcher) {
    roleMapWatcher.close();
    roleMapWatcher = null;
  }
  if (syncDebounce) {
    clearTimeout(syncDebounce);
    syncDebounce = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}
