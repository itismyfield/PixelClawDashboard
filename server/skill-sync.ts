import { getDb } from "./db/runtime.js";
import { broadcast } from "./ws.js";

interface SkillUsageEventInput {
  eventKey: string;
  skillName: string;
  sessionKey?: string | null;
  agentOpenclawId?: string | null;
  agentName?: string | null;
  usedAt?: number;
}

function updateDailySkillCalls(agentOpenclawId: string | null | undefined, usedAt: number): void {
  if (!agentOpenclawId) return;
  const db = getDb();
  const day = new Date(usedAt).toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO daily_activity (agent_id, date, skill_calls)
     VALUES (?, ?, 1)
     ON CONFLICT(agent_id, date) DO UPDATE SET skill_calls = skill_calls + 1`,
  ).run(agentOpenclawId, day);
}

export function recordSkillUsageEvent(input: SkillUsageEventInput): boolean {
  const db = getDb();
  const hasEvent = db.prepare("SELECT 1 FROM skill_usage_events WHERE event_key = ? LIMIT 1");
  const insertEvent = db.prepare(
    `INSERT INTO skill_usage_events (
      event_key, skill_name, session_key, agent_openclaw_id, agent_name, used_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const eventKey = input.eventKey.trim();
  const skillName = input.skillName.trim().toLowerCase();
  if (!eventKey || !skillName) return false;
  if (hasEvent.get(eventKey)) return false;

  const usedAt = input.usedAt ?? Date.now();
  insertEvent.run(
    eventKey,
    skillName,
    input.sessionKey ?? null,
    input.agentOpenclawId ?? null,
    input.agentName ?? null,
    usedAt,
  );
  updateDailySkillCalls(input.agentOpenclawId, usedAt);
  broadcast("skill_usage_update", { inserted: 1 });
  return true;
}

export function syncSkillUsageOnce(): number {
  return 0;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSkillSync(): void {
  console.log("[PCD] skill-sync started (hook mode)");
}

export function stopSkillSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
