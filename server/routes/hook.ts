import { Router } from "express";
import crypto from "node:crypto";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";
import { reconcileAgentStatusOnce, syncAgentsOnce } from "../agent-sync.js";
import { inferRemoteCcProvider, parseRemoteCcSessionKey } from "../remotecc-session.js";
import { resolveRoleIdByChannelName } from "../role-map.js";
import { recordSkillUsageEvent } from "../skill-sync.js";

const router = Router();

function resolveLinkedAgentId(sessionKey: string, name?: string | null): string | null {
  const channelName = parseRemoteCcSessionKey(sessionKey, name).channelName;
  if (!channelName) return null;

  const roleId = resolveRoleIdByChannelName(channelName);
  if (!roleId) return null;

  const db = getDb();
  const row = db
    .prepare("SELECT id FROM agents WHERE openclaw_id = ? LIMIT 1")
    .get(roleId) as { id: string } | undefined;

  return row?.id ?? null;
}

function emitLinkedAgentStatus(agentId: string): void {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color,
              COALESCE(ds.remotecc_working_count, 0) AS remotecc_working_count
       FROM agents a
       LEFT JOIN departments d ON a.department_id = d.id
       LEFT JOIN (
         SELECT linked_agent_id as aid,
                SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) as remotecc_working_count
         FROM dispatched_sessions
         WHERE linked_agent_id IS NOT NULL AND status != 'disconnected'
         GROUP BY linked_agent_id
       ) ds ON ds.aid = a.id
       WHERE a.id = ?`,
    )
    .get(agentId) as Record<string, unknown> | undefined;

  if (!row) return;

  const remoteCcWorking = Number(row.remotecc_working_count || 0);
  const baseStatus = String(row.status || "idle");
  const activitySource =
    baseStatus === "working" && remoteCcWorking > 0
      ? "both"
      : remoteCcWorking > 0
        ? "remotecc"
        : baseStatus === "working"
          ? "openclaw"
          : "idle";
  const effectiveStatus = remoteCcWorking > 0 ? "working" : baseStatus;

  broadcast("agent_status", {
    ...row,
    status: effectiveStatus,
    activity_source: activitySource,
    remotecc_working_count: remoteCcWorking,
  });
}

// OpenClaw hook: agent status update
router.patch("/api/hook/agent-status", (req, res) => {
  const db = getDb();
  const { openclaw_id, status, session_info } = req.body;
  if (!openclaw_id)
    return res.status(400).json({ error: "openclaw_id required" });

  const agent = db
    .prepare("SELECT * FROM agents WHERE openclaw_id = ?")
    .get(openclaw_id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: "agent_not_found" });

  const sets = ["status = ?"];
  const vals: (string | number | null)[] = [status ?? "idle"];
  if (session_info !== undefined) {
    sets.push("session_info = ?");
    vals.push(session_info);
  }
  vals.push(agent.id as string);
  db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(
    ...vals,
  );

  emitLinkedAgentStatus(agent.id as string);
  res.json({ ok: true });
});

// Force sync OpenClaw agent list into PCD (upsert missing agents)
router.post("/api/hook/sync-agents", (_req, res) => {
  const created = syncAgentsOnce();
  const reconciled = reconcileAgentStatusOnce();
  res.json({ ok: true, created, reconciled });
});

// Reset all working agents to idle (called by gateway on startup)
router.post("/api/hook/reset-status", (_req, res) => {
  const db = getDb();
  const count = (
    db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE status = 'working'").get() as { cnt: number }
  ).cnt;
  if (count > 0) {
    db.exec("UPDATE agents SET status = 'idle' WHERE status = 'working'");
    broadcast("agent_status", { _reset: true });
    console.log(`[PCD] Hook reset: ${count} agent(s) → idle`);
  }
  res.json({ ok: true, reset: count });
});

// Dispatched session: register / heartbeat
router.post("/api/hook/session", (req, res) => {
  const db = getDb();
  const { session_key, name, model, status, session_info, tokens } = req.body;
  if (!session_key)
    return res.status(400).json({ error: "session_key required" });
  const provider = inferRemoteCcProvider(session_key, name ?? null, req.body.provider ?? null);

  // Convert tokens → XP (1000 tokens = 1 XP, matching agent XP formula)
  const xpDelta = typeof tokens === "number" && tokens > 0 ? Math.floor(tokens / 1000) : 0;

  const existing = db
    .prepare("SELECT * FROM dispatched_sessions WHERE session_key = ?")
    .get(session_key) as Record<string, unknown> | undefined;

  if (existing) {
    // Heartbeat / update
    const sets = ["last_seen_at = ?"];
    const vals: (string | number | null)[] = [Date.now()];

    const hadLinkedAgent = Boolean(existing.linked_agent_id);
    let linkedAgentId = (existing.linked_agent_id as string | null) ?? null;
    if (!linkedAgentId) {
      linkedAgentId = resolveLinkedAgentId(session_key, name ?? null);
      if (linkedAgentId) {
        sets.push("linked_agent_id = ?");
        vals.push(linkedAgentId);
      }
    }

    if (status) {
      sets.push("status = ?");
      vals.push(status);
    }
    if (name !== undefined) {
      sets.push("name = ?");
      vals.push(name);
    }
    if (session_info !== undefined) {
      sets.push("session_info = ?");
      vals.push(session_info);
    }
    if (model) {
      sets.push("model = ?");
      vals.push(model);
    }
    if (provider) {
      sets.push("provider = ?");
      vals.push(provider);
    }
    if (xpDelta > 0 && !linkedAgentId) {
      sets.push("stats_xp = stats_xp + ?");
      vals.push(xpDelta);
    }
    vals.push(existing.id as string);
    db.prepare(
      `UPDATE dispatched_sessions SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...vals);

    // If this session is linked to an existing OpenClaw agent, merge XP there too.
    if (linkedAgentId && xpDelta > 0) {
      db.prepare("UPDATE agents SET stats_xp = stats_xp + ? WHERE id = ?").run(
        xpDelta,
        linkedAgentId,
      );
    }

    const updated = db
      .prepare("SELECT * FROM dispatched_sessions WHERE id = ?")
      .get(existing.id as string) as Record<string, unknown>;

    // Backfill previously accumulated dispatched XP into linked agent once.
    if (linkedAgentId && !hadLinkedAgent) {
      const carry = Number(existing.stats_xp || 0);
      if (carry > 0) {
        db.prepare("UPDATE agents SET stats_xp = stats_xp + ? WHERE id = ?").run(carry, linkedAgentId);
        db.prepare("UPDATE dispatched_sessions SET stats_xp = 0 WHERE id = ?").run(existing.id as string);
        updated.stats_xp = 0;
      }
    }

    broadcast("dispatched_session_update", updated);
    if (linkedAgentId) emitLinkedAgentStatus(linkedAgentId);
    return res.json(updated);
  }

  // New session
  const id = crypto.randomUUID();
  const linkedAgentId = resolveLinkedAgentId(session_key, name ?? null);
  db.prepare(
    `INSERT INTO dispatched_sessions (id, session_key, name, provider, model, status, session_info, linked_agent_id, stats_xp, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    session_key,
    name ?? `Session ${session_key.slice(0, 8)}`,
    provider,
    model ?? null,
    status ?? "working",
    session_info ?? null,
    linkedAgentId,
    0,
    Date.now(),
  );

  if (linkedAgentId && xpDelta > 0) {
    db.prepare("UPDATE agents SET stats_xp = stats_xp + ? WHERE id = ?").run(xpDelta, linkedAgentId);
  } else if (xpDelta > 0) {
    db.prepare("UPDATE dispatched_sessions SET stats_xp = stats_xp + ? WHERE id = ?").run(xpDelta, id);
  }

  const session = db
    .prepare("SELECT * FROM dispatched_sessions WHERE id = ?")
    .get(id) as Record<string, unknown>;
  broadcast("dispatched_session_new", session);
  if (linkedAgentId) emitLinkedAgentStatus(linkedAgentId);
  res.status(201).json(session);
});

// Dispatched session: disconnect
router.delete("/api/hook/session/:sessionKey", (req, res) => {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM dispatched_sessions WHERE session_key = ?")
    .get(req.params.sessionKey) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });

  db.prepare(
    "UPDATE dispatched_sessions SET status = 'disconnected', last_seen_at = ? WHERE id = ?",
  ).run(Date.now(), row.id as string);
  broadcast("dispatched_session_disconnect", { id: row.id });
  if (row.linked_agent_id) {
    emitLinkedAgentStatus(String(row.linked_agent_id));
  }
  res.json({ ok: true });
});

router.post("/api/hook/skill-usage", (req, res) => {
  const db = getDb();
  const {
    event_key,
    skill_name,
    session_key,
    agent_openclaw_id,
    agent_id,
    agent_name,
    used_at,
  } = req.body ?? {};

  if (!skill_name || typeof skill_name !== "string") {
    return res.status(400).json({ error: "skill_name required" });
  }

  let resolvedAgentOpenclawId: string | null = typeof agent_openclaw_id === "string"
    ? agent_openclaw_id
    : null;

  if (!resolvedAgentOpenclawId && typeof agent_id === "string") {
    const row = db
      .prepare("SELECT openclaw_id, name FROM agents WHERE id = ? LIMIT 1")
      .get(agent_id) as { openclaw_id: string | null; name: string | null } | undefined;
    resolvedAgentOpenclawId = row?.openclaw_id ?? null;
  }

  const eventKey = typeof event_key === "string" && event_key.trim()
    ? event_key.trim()
    : `${session_key ?? agent_id ?? resolvedAgentOpenclawId ?? "manual"}:${skill_name}:${used_at ?? Date.now()}`;

  const inserted = recordSkillUsageEvent({
    eventKey,
    skillName: skill_name,
    sessionKey: typeof session_key === "string" ? session_key : null,
    agentOpenclawId: resolvedAgentOpenclawId,
    agentName: typeof agent_name === "string" ? agent_name : null,
    usedAt: typeof used_at === "number" ? used_at : Date.now(),
  });

  return res.status(inserted ? 201 : 200).json({ ok: true, inserted });
});

export default router;
