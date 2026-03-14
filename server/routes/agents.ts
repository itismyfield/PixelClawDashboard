import { Router } from "express";
import crypto from "node:crypto";
import { appendAuditLog, getAuditActor } from "../audit-log.js";
import { getDb } from "../db/runtime.js";
import { resolveDiscordChannelName } from "../discord-announce.js";
import { broadcast } from "../ws.js";
import { listLaunchdJobs } from "../launchd-jobs.js";
import { listRoleBindings } from "../role-map.js";
import { listCentralSkills } from "../skills-catalog.js";

const router = Router();

function hydrateActivitySource<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    const remoteCcWorking = Number(row.remotecc_working_count || 0);
    const baseStatus = String(row.status || "idle");

    const activitySource = remoteCcWorking > 0 ? "remotecc" : "idle";

    const effectiveStatus = remoteCcWorking > 0 ? "working" : baseStatus;

    // If agent has no session_info, inherit from the most recent working linked session
    const sessionInfo = row.session_info || row.linked_session_info || null;

    // Compute XP from tokens at response time
    const statsTokens = Number(row.stats_tokens || 0);
    return {
      ...row,
      status: effectiveStatus,
      activity_source: activitySource,
      remotecc_working_count: remoteCcWorking,
      session_info: sessionInfo,
      stats_xp: Math.floor(statsTokens / 1000),
    } as T;
  });
}

router.get("/api/agents", (req, res) => {
  const db = getDb();
  const officeId = req.query.officeId as string | undefined;

  const remoteCcJoin = `
    LEFT JOIN (
      SELECT linked_agent_id as aid,
             SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) as remotecc_working_count
      FROM dispatched_sessions
      WHERE linked_agent_id IS NOT NULL AND status != 'disconnected'
      GROUP BY linked_agent_id
    ) ds ON ds.aid = a.id
  `;
  const linkedSessionInfoExpr = `(SELECT COALESCE(ds2.session_info, ds2.name)
     FROM dispatched_sessions ds2
     WHERE ds2.linked_agent_id = a.id AND ds2.status = 'working'
     ORDER BY ds2.last_seen_at DESC LIMIT 1) AS linked_session_info`;

  let rows;
  if (officeId) {
    // Return agents in a specific office, with their office-specific department
    rows = db
      .prepare(
        `SELECT a.*, oa.department_id as office_department_id,
                d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color,
                COALESCE(ds.remotecc_working_count, 0) AS remotecc_working_count,
                ${linkedSessionInfoExpr}
         FROM office_agents oa
         JOIN agents a ON a.id = oa.agent_id
         LEFT JOIN departments d ON d.id = oa.department_id
         ${remoteCcJoin}
         WHERE oa.office_id = ?
         ORDER BY a.created_at`,
      )
      .all(officeId) as Array<Record<string, unknown>>;
  } else {
    rows = db
      .prepare(
        `SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color,
                COALESCE(ds.remotecc_working_count, 0) AS remotecc_working_count,
                ${linkedSessionInfoExpr}
         FROM agents a LEFT JOIN departments d ON a.department_id = d.id
         ${remoteCcJoin}
         ORDER BY a.created_at`,
      )
      .all() as Array<Record<string, unknown>>;
  }
  res.json({ agents: hydrateActivitySource(rows) });
});

router.get("/api/agents/:id", (req, res) => {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color,
              COALESCE(ds.remotecc_working_count, 0) AS remotecc_working_count,
              (SELECT COALESCE(ds2.session_info, ds2.name)
               FROM dispatched_sessions ds2
               WHERE ds2.linked_agent_id = a.id AND ds2.status = 'working'
               ORDER BY ds2.last_seen_at DESC LIMIT 1) AS linked_session_info
       FROM agents a LEFT JOIN departments d ON a.department_id = d.id
       LEFT JOIN (
         SELECT linked_agent_id as aid,
                SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) as remotecc_working_count
         FROM dispatched_sessions
         WHERE linked_agent_id IS NOT NULL AND status != 'disconnected'
         GROUP BY linked_agent_id
       ) ds ON ds.aid = a.id
       WHERE a.id = ?`,
    )
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(hydrateActivitySource([row])[0]);
});

router.get("/api/agents/:id/offices", (req, res) => {
  const db = getDb();
  const offices = db
    .prepare(
      `SELECT o.*,
              oa.department_id as office_department_id,
              oa.joined_at,
              CASE WHEN oa.agent_id IS NOT NULL THEN 1 ELSE 0 END AS assigned
       FROM offices o
       LEFT JOIN office_agents oa
         ON oa.office_id = o.id
        AND oa.agent_id = ?
       ORDER BY o.sort_order`,
    )
    .all(req.params.id) as Array<Record<string, unknown>>;

  res.json({
    offices: offices.map((office) => ({
      ...office,
      assigned: Boolean(office.assigned),
    })),
  });
});

router.post("/api/agents", (req, res) => {
  const db = getDb();
  const id = crypto.randomUUID();
  const b = req.body;
  db.prepare(
    `INSERT INTO agents (id, role_id, name, name_ko, name_ja, name_zh,
      department_id, avatar_emoji, sprite_number, personality, cli_provider, status, alias, discord_channel_id_codex)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    b.role_id ?? null,
    b.name ?? "",
    b.name_ko ?? "",
    b.name_ja ?? "",
    b.name_zh ?? "",
    b.department_id ?? null,
    b.avatar_emoji ?? "🙂",
    b.sprite_number ?? null,
    b.personality ?? null,
    b.cli_provider ?? "claude",
    b.status ?? "idle",
    b.alias ?? null,
    b.discord_channel_id_codex ?? null,
  );

  // If office_id provided, also assign to that office
  if (b.office_id) {
    db.prepare(
      "INSERT OR IGNORE INTO office_agents (office_id, agent_id, department_id) VALUES (?, ?, ?)",
    ).run(b.office_id, id, b.department_id ?? null);
  }

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  appendAuditLog({
    actor: getAuditActor(req),
    action: "create",
    entityType: "agent",
    entityId: id,
    summary: `Agent created: ${String(b.name_ko || b.name || id)}`,
    metadata: { role_id: b.role_id ?? null },
  });
  broadcast("agent_created", agent);
  res.status(201).json(agent);
});

router.patch("/api/agents/:id", (req, res) => {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM agents WHERE id = ?")
    .get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not_found" });

  const fields = [
    "name",
    "name_ko",
    "name_ja",
    "name_zh",
    "department_id",
    "avatar_emoji",
    "sprite_number",
    "personality",
    "status",
    "session_info",
    "stats_tasks_done",
    "stats_xp",
    "role_id",
    "alias",
    "cli_provider",
    "discord_channel_id",
    "discord_channel_id_alt",
    "discord_channel_id_codex",
    "discord_prefer_alt",
  ];
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const changedFields: string[] = [];
  for (const f of fields) {
    if (f in req.body) {
      sets.push(`${f} = ?`);
      vals.push(req.body[f]);
      if ((existing as Record<string, unknown>)[f] !== req.body[f]) {
        changedFields.push(f);
      }
    }
  }
  if (sets.length === 0) return res.json(existing);

  vals.push(req.params.id);
  db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(
    ...vals,
  );

  const updated = db
    .prepare(
      `SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color,
              COALESCE(ds.remotecc_working_count, 0) AS remotecc_working_count,
              (SELECT COALESCE(ds2.session_info, ds2.name)
               FROM dispatched_sessions ds2
               WHERE ds2.linked_agent_id = a.id AND ds2.status = 'working'
               ORDER BY ds2.last_seen_at DESC LIMIT 1) AS linked_session_info
       FROM agents a LEFT JOIN departments d ON a.department_id = d.id
       LEFT JOIN (
         SELECT linked_agent_id as aid,
                SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) as remotecc_working_count
         FROM dispatched_sessions
         WHERE linked_agent_id IS NOT NULL AND status != 'disconnected'
         GROUP BY linked_agent_id
       ) ds ON ds.aid = a.id
       WHERE a.id = ?`,
    )
    .get(req.params.id) as Record<string, unknown>;
  const hydrated = hydrateActivitySource([updated])[0];
  appendAuditLog({
    actor: getAuditActor(req),
    action: "update",
    entityType: "agent",
    entityId: req.params.id,
    summary: `Agent updated: ${String((hydrated.name_ko as string) || (hydrated.name as string) || req.params.id)}`,
    metadata: { fields: changedFields },
  });
  broadcast("agent_status", hydrated);
  res.json(hydrated);
});

router.delete("/api/agents/:id", (req, res) => {
  const db = getDb();
  const existing = db
    .prepare("SELECT id, name, name_ko FROM agents WHERE id = ?")
    .get(req.params.id) as { id: string; name: string; name_ko: string } | undefined;
  // office_agents cascade-deletes automatically
  db.prepare("DELETE FROM agents WHERE id = ?").run(req.params.id);
  appendAuditLog({
    actor: getAuditActor(req),
    action: "delete",
    entityType: "agent",
    entityId: req.params.id,
    summary: `Agent deleted: ${existing?.name_ko || existing?.name || req.params.id}`,
  });
  broadcast("agent_deleted", { id: req.params.id });
  res.json({ ok: true });
});

// ── Cron jobs for an agent ──
router.get("/api/agents/:id/cron", (req, res) => {
  const db = getDb();
  const agent = db
    .prepare("SELECT * FROM agents WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: "not_found" });

  const roleId = agent.role_id as string | null;
  if (!roleId) return res.json({ jobs: [] });
  const jobs = listLaunchdJobs()
    .filter((job) => job.agentId === roleId)
    .map((job) => ({
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      schedule: job.schedule,
      state: job.state,
      description_ko: job.description_ko,
    }));
  res.json({ jobs });
});

// ── Skills for an agent ──
router.get("/api/agents/:id/dispatched-sessions", (req, res) => {
  const db = getDb();
  const agent = db
    .prepare("SELECT * FROM agents WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: "not_found" });

  const sessions = db
    .prepare(
      `SELECT * FROM dispatched_sessions
       WHERE linked_agent_id = ? AND status != 'disconnected'
       ORDER BY last_seen_at DESC, connected_at DESC`,
    )
    .all(req.params.id);
  res.json({ sessions });
});

router.get("/api/agents/:id/skills", (req, res) => {
  const db = getDb();
  const agent = db
    .prepare("SELECT * FROM agents WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: "not_found" });
  const sharedSkills = listCentralSkills().map((skill) => ({
    name: skill.name,
    description: skill.description,
    shared: true,
  }));
  res.json({
    skills: [],
    sharedSkills,
    totalCount: sharedSkills.length,
  });
});

// ── Agent channel map (role_id/alias → channel IDs by provider) ──
router.get("/api/agent-channels", (_req, res) => {
  const db = getDb();
  const agents = db
    .prepare(
      `SELECT id, role_id, name, name_ko, alias,
              discord_channel_id, discord_channel_id_alt, discord_channel_id_codex, discord_prefer_alt
       FROM agents`,
    )
    .all() as Array<{
    id: string;
    role_id: string | null;
    name: string;
    name_ko: string;
    alias: string | null;
    discord_channel_id: string | null;
    discord_channel_id_alt: string | null;
    discord_channel_id_codex: string | null;
    discord_prefer_alt: number;
  }>;

  // Collect role_map bindings keyed by roleId → channelIds
  const roleMapChannels = new Map<string, string[]>();
  for (const binding of listRoleBindings()) {
    if (!binding.channelId) continue;
    const list = roleMapChannels.get(binding.roleId) ?? [];
    list.push(binding.channelId);
    roleMapChannels.set(binding.roleId, list);
  }

  const channels: Record<
    string,
    {
      agent_id: string;
      name: string;
      name_ko: string;
      claude: string | null;
      codex: string | null;
    }
  > = {};

  for (const a of agents) {
    // Determine claude channel: prefer role_map binding, then DB columns
    const roleBindings = a.role_id ? roleMapChannels.get(a.role_id) ?? [] : [];
    const claudeChannel =
      (a.discord_prefer_alt ? a.discord_channel_id_alt : a.discord_channel_id)
      || roleBindings[0]
      || a.discord_channel_id
      || a.discord_channel_id_alt
      || null;

    const codexChannel = a.discord_channel_id_codex || null;

    // Skip agents with no channels at all
    if (!claudeChannel && !codexChannel) continue;

    // Index by role_id (primary key for lookups)
    const key = a.role_id || a.id;
    channels[key] = {
      agent_id: a.id,
      name: a.name,
      name_ko: a.name_ko,
      claude: claudeChannel,
      codex: codexChannel,
    };

    // Also index by alias if present (for convenience)
    if (a.alias && a.alias !== key) {
      channels[a.alias] = channels[key];
    }
  }

  res.json({ channels });
});

// ── Discord channel mapping (reads role_map + agent channel columns) ──
router.get("/api/discord-bindings", async (_req, res) => {
  try {
    const db = getDb();
    const bindings: Array<{
      agentId: string;
      channelId: string;
      channelName?: string;
      source?: string;
    }> = [];
    const seen = new Set<string>();

    const agentRows = db
      .prepare(
        `SELECT id, role_id, discord_channel_id, discord_channel_id_alt, discord_channel_id_codex
         FROM agents`,
      )
      .all() as Array<{
      id: string;
      role_id: string | null;
      discord_channel_id: string | null;
      discord_channel_id_alt: string | null;
      discord_channel_id_codex: string | null;
    }>;

    const dbIdByRoleId = new Map<string, string>();
    for (const row of agentRows) {
      if (row.role_id) dbIdByRoleId.set(row.role_id, row.id);
    }

    for (const binding of listRoleBindings()) {
      if (!binding.channelId) continue;
      const agentId = dbIdByRoleId.get(binding.roleId);
      if (!agentId) continue;
      const key = `${agentId}:${binding.channelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bindings.push({
        agentId,
        channelId: binding.channelId,
        channelName: binding.channelName ?? undefined,
        source: "role-map",
      });
    }

    for (const row of agentRows) {
      const pairs = [
        [row.discord_channel_id, "Primary"],
        [row.discord_channel_id_alt, "Alt"],
        [row.discord_channel_id_codex, "Codex"],
      ] as const;
      for (const [channelId, label] of pairs) {
        if (!channelId) continue;
        const key = `${row.id}:${channelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bindings.push({
          agentId: row.id,
          channelId,
          channelName: undefined,
          source: label.toLowerCase(),
        });
      }
    }

    const namedBindings = await Promise.all(
      bindings.map(async (binding) => {
        const isDmTarget = binding.channelId.startsWith("dm:");
        const channelName = isDmTarget
          ? binding.channelName ?? undefined
          : await resolveDiscordChannelName(binding.channelId);
        if (!isDmTarget && !channelName) return null;
        return {
          ...binding,
          channelName: channelName ?? binding.channelName,
        };
      }),
    );

    res.json({ bindings: namedBindings.filter(Boolean) });
  } catch {
    res.json({ bindings: [] });
  }
});

export default router;
