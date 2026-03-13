import { Router } from "express";
import crypto from "node:crypto";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";
import { reconcileAgentStatusOnce, syncAgentsOnce } from "../agent-sync.js";
import { emitKanbanCard, commentBlockedOnGitHub, updateGitHubChecklistOnReview, triggerCounterModelReview } from "../kanban-cards.js";
import { sendDiscordMessage } from "../discord-announce.js";
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
    .prepare("SELECT id FROM agents WHERE role_id = ? LIMIT 1")
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
  const activitySource = remoteCcWorking > 0 ? "remotecc" : "idle";
  const effectiveStatus = remoteCcWorking > 0 ? "working" : baseStatus;

  // If agent has no session_info, inherit from the most recent working linked session
  let sessionInfo = row.session_info as string | null;
  if (!sessionInfo && remoteCcWorking > 0) {
    const linked = db
      .prepare(
        `SELECT session_info, name FROM dispatched_sessions
         WHERE linked_agent_id = ? AND status = 'working'
         ORDER BY last_seen_at DESC LIMIT 1`,
      )
      .get(agentId) as { session_info: string | null; name: string | null } | undefined;
    sessionInfo = linked?.session_info || linked?.name || null;
  }

  broadcast("agent_status", {
    ...row,
    status: effectiveStatus,
    activity_source: activitySource,
    remotecc_working_count: remoteCcWorking,
    session_info: sessionInfo ?? row.session_info,
  });
}

/**
 * Dispatch-aware kanban promotion.
 * Only promotes when the session explicitly carries a dispatch_id matching a kanban card.
 *
 * working:          card requested  → in_progress
 * completed (idle): card in_progress → review  (agent finished work, then session ended)
 * disconnect:       card stays in_progress      (abnormal termination — not auto-promoted)
 */
function promoteKanbanForDispatch(
  dispatchId: string,
  signal: "working" | "completed" | "blocked",
  blockedReason?: string,
): void {
  const db = getDb();

  const card = db.prepare(
    `SELECT kc.id, kc.status, kc.title, kc.github_repo, kc.github_issue_number, kc.assignee_agent_id, kc.metadata_json
     FROM kanban_cards kc WHERE kc.latest_dispatch_id = ? LIMIT 1`,
  ).get(dispatchId) as {
    id: string; status: string; title: string;
    github_repo: string | null; github_issue_number: number | null;
    assignee_agent_id: string | null; metadata_json: string | null;
  } | undefined;
  if (!card) return;

  const now = Date.now();

  if (signal === "working" && card.status === "requested") {
    db.prepare(
      `UPDATE kanban_cards SET status = 'in_progress', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
    ).run(now, now, card.id);
    db.prepare(
      `UPDATE task_dispatches SET status = 'in_progress' WHERE id = ? AND status IN ('pending', 'dispatched')`,
    ).run(dispatchId);
    emitKanbanCard(db, card.id, "kanban_card_updated");
    console.log(`[PCD] kanban dispatch-promote: ${card.id} → in_progress (dispatch ${dispatchId})`);
  } else if (signal === "blocked" && card.status === "in_progress") {
    const reason = blockedReason || "Agent reported blocked (no reason given)";
    db.prepare(
      `UPDATE kanban_cards SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?`,
    ).run(reason, now, card.id);
    emitKanbanCard(db, card.id, "kanban_card_updated");
    console.log(`[PCD] kanban dispatch-promote: ${card.id} → blocked (dispatch ${dispatchId}): ${reason}`);

    // GitHub issue comment (fire-and-forget)
    if (card.github_repo && card.github_issue_number) {
      const agentName = card.assignee_agent_id
        ? (db.prepare("SELECT name FROM agents WHERE id = ? LIMIT 1").get(card.assignee_agent_id) as { name: string } | undefined)?.name ?? card.assignee_agent_id
        : "unknown";
      commentBlockedOnGitHub(card.github_repo, card.github_issue_number, reason, agentName, card.id);
    }

    // CEO/PMD alert via internal message + Discord
    const alertText = `🔴 **[BLOCKED]** "${card.title}" — ${reason}`;
    db.prepare(
      `INSERT INTO messages (sender_type, sender_id, receiver_type, receiver_id, content, message_type)
       VALUES ('system', 'dispatch-watcher', 'agent', NULL, ?, 'status_update')`,
    ).run(alertText);
    broadcast("new_message", { content: alertText, sender_type: "system" });
    // Send to PMD channel (fire-and-forget)
    const PMD_CHANNEL_ID = "1478652416533463101";
    sendDiscordMessage(PMD_CHANNEL_ID, alertText).catch(() => {});
  } else if (signal === "completed" && card.status === "in_progress") {
    // Only promote if no other working sessions reference this dispatch
    const otherWorking = db.prepare(
      `SELECT COUNT(*) as cnt FROM dispatched_sessions
       WHERE active_dispatch_id = ? AND status = 'working'`,
    ).get(dispatchId) as { cnt: number };
    if (otherWorking.cnt > 0) return;

    db.prepare(
      `UPDATE kanban_cards SET status = 'review', updated_at = ? WHERE id = ?`,
    ).run(now, card.id);
    db.prepare(
      `UPDATE task_dispatches SET status = 'completed', result_summary = COALESCE(result_summary, 'Session completed'), completed_at = COALESCE(completed_at, ?) WHERE id = ? AND status IN ('pending', 'dispatched', 'in_progress')`,
    ).run(now, dispatchId);
    emitKanbanCard(db, card.id, "kanban_card_updated");
    console.log(`[PCD] kanban dispatch-promote: ${card.id} → review (dispatch ${dispatchId} completed)`);
    // Update GitHub issue DoD checklist + add review-pending comment
    updateGitHubChecklistOnReview(card);
    // Trigger counter-model review if DoD all done and counter channel exists
    try {
      triggerCounterModelReview(getDb(), card.id);
    } catch (e) {
      console.error(`[PCD] counter-model review trigger failed for card ${card.id}:`, (e as Error).message);
    }
  }
}

// Sync agent list into PCD (upsert missing agents from role-map)
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
  const { session_key, name, model, status, session_info, tokens, cwd, dispatch_id, blocked_reason } = req.body;
  if (!session_key)
    return res.status(400).json({ error: "session_key required" });
  const provider = inferRemoteCcProvider(session_key, name ?? null, req.body.provider ?? null);
  const activeDispatchId = typeof dispatch_id === "string" && dispatch_id.trim() ? dispatch_id.trim() : null;

  // Raw token delta for accumulation
  const tokenDelta = typeof tokens === "number" && tokens > 0 ? tokens : 0;

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
    if (cwd !== undefined) {
      sets.push("cwd = ?");
      vals.push(cwd);
    }
    if (model) {
      sets.push("model = ?");
      vals.push(model);
    }
    if (provider) {
      sets.push("provider = ?");
      vals.push(provider);
    }
    if (activeDispatchId && existing.active_dispatch_id !== activeDispatchId) {
      sets.push("active_dispatch_id = ?");
      vals.push(activeDispatchId);
    }
    if (tokenDelta > 0) {
      sets.push("tokens = tokens + ?");
      vals.push(tokenDelta);
      if (!linkedAgentId) {
        sets.push("stats_xp = stats_xp + ?");
        vals.push(Math.floor(tokenDelta / 1000));
      }
    }
    vals.push(existing.id as string);
    db.prepare(
      `UPDATE dispatched_sessions SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...vals);

    // If this session is linked to an agent, accumulate tokens there too.
    if (linkedAgentId && tokenDelta > 0) {
      db.prepare(
        "UPDATE agents SET stats_tokens = stats_tokens + ?, stats_xp = (stats_tokens + ?) / 1000 WHERE id = ?",
      ).run(tokenDelta, tokenDelta, linkedAgentId);
    }

    const updated = db
      .prepare("SELECT * FROM dispatched_sessions WHERE id = ?")
      .get(existing.id as string) as Record<string, unknown>;

    // Backfill previously accumulated dispatched tokens into linked agent once.
    if (linkedAgentId && !hadLinkedAgent) {
      const carryTokens = Number(existing.tokens || 0);
      if (carryTokens > 0) {
        db.prepare(
          "UPDATE agents SET stats_tokens = stats_tokens + ?, stats_xp = (stats_tokens + ?) / 1000 WHERE id = ?",
        ).run(carryTokens, carryTokens, linkedAgentId);
        db.prepare("UPDATE dispatched_sessions SET stats_xp = 0, tokens = 0 WHERE id = ?").run(existing.id as string);
        updated.stats_xp = 0;
        updated.tokens = 0;
      }
    }

    broadcast("dispatched_session_update", updated);
    if (linkedAgentId) {
      emitLinkedAgentStatus(linkedAgentId);
    }
    // Dispatch-aware kanban promotion: only when dispatch_id is present
    const effectiveDispatchId = activeDispatchId ?? (existing.active_dispatch_id as string | null);
    if (effectiveDispatchId) {
      const blockedText = typeof blocked_reason === "string" && blocked_reason.trim() ? blocked_reason.trim() : null;
      if (blockedText) {
        // Agent explicitly reported BLOCKED with a reason
        promoteKanbanForDispatch(effectiveDispatchId, "blocked", blockedText);
      } else if (status === "working" && existing.status !== "working") {
        promoteKanbanForDispatch(effectiveDispatchId, "working");
      } else if (status === "idle" && existing.status === "working") {
        // Agent finished work normally (working → idle) → promote to review
        promoteKanbanForDispatch(effectiveDispatchId, "completed");
      }
    }
    return res.json(updated);
  }

  // New session
  const id = crypto.randomUUID();
  const linkedAgentId = resolveLinkedAgentId(session_key, name ?? null);
  db.prepare(
    `INSERT INTO dispatched_sessions (id, session_key, name, provider, model, status, session_info, cwd, linked_agent_id, active_dispatch_id, stats_xp, tokens, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    session_key,
    name ?? `Session ${session_key.slice(0, 8)}`,
    provider,
    model ?? null,
    status ?? "working",
    session_info ?? null,
    cwd ?? null,
    linkedAgentId,
    activeDispatchId,
    0,
    tokenDelta,
    Date.now(),
  );

  if (linkedAgentId && tokenDelta > 0) {
    db.prepare(
      "UPDATE agents SET stats_tokens = stats_tokens + ?, stats_xp = (stats_tokens + ?) / 1000 WHERE id = ?",
    ).run(tokenDelta, tokenDelta, linkedAgentId);
  } else if (tokenDelta > 0) {
    db.prepare("UPDATE dispatched_sessions SET stats_xp = ? WHERE id = ?").run(Math.floor(tokenDelta / 1000), id);
  }

  const session = db
    .prepare("SELECT * FROM dispatched_sessions WHERE id = ?")
    .get(id) as Record<string, unknown>;
  broadcast("dispatched_session_new", session);
  if (linkedAgentId) {
    emitLinkedAgentStatus(linkedAgentId);
  }
  // Dispatch-aware kanban promotion for new session
  if (activeDispatchId) {
    const blockedText = typeof blocked_reason === "string" && blocked_reason.trim() ? blocked_reason.trim() : null;
    if (blockedText) {
      promoteKanbanForDispatch(activeDispatchId, "blocked", blockedText);
    } else if ((status ?? "working") === "working") {
      promoteKanbanForDispatch(activeDispatchId, "working");
    }
  }
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
  // Abnormal disconnect: kanban card stays in_progress (not auto-promoted to review).
  // Only normal completion (working → idle heartbeat) promotes to review.
  res.json({ ok: true });
});

router.post("/api/hook/skill-usage", (req, res) => {
  const db = getDb();
  const {
    event_key,
    skill_name,
    session_key,
    agent_role_id,
    agent_id,
    agent_name,
    used_at,
  } = req.body ?? {};

  if (!skill_name || typeof skill_name !== "string") {
    return res.status(400).json({ error: "skill_name required" });
  }

  let resolvedAgentRoleId: string | null = typeof agent_role_id === "string"
    ? agent_role_id
    : null;

  if (!resolvedAgentRoleId && typeof agent_id === "string") {
    const row = db
      .prepare("SELECT role_id, name FROM agents WHERE id = ? LIMIT 1")
      .get(agent_id) as { role_id: string | null; name: string | null } | undefined;
    resolvedAgentRoleId = row?.role_id ?? null;
  }

  const eventKey = typeof event_key === "string" && event_key.trim()
    ? event_key.trim()
    : `${session_key ?? agent_id ?? resolvedAgentRoleId ?? "manual"}:${skill_name}:${used_at ?? Date.now()}`;

  const inserted = recordSkillUsageEvent({
    eventKey,
    skillName: skill_name,
    sessionKey: typeof session_key === "string" ? session_key : null,
    agentRoleId: resolvedAgentRoleId,
    agentName: typeof agent_name === "string" ? agent_name : null,
    usedAt: typeof used_at === "number" ? used_at : Date.now(),
  });

  return res.status(inserted ? 201 : 200).json({ ok: true, inserted });
});

export default router;
