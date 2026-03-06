import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";

const router = Router();

function hydrateActivitySource<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    const remoteCcWorking = Number(row.remotecc_working_count || 0);
    const baseStatus = String(row.status || "idle");

    let activitySource = "idle";
    if (baseStatus === "working" && remoteCcWorking > 0) activitySource = "both";
    else if (remoteCcWorking > 0) activitySource = "remotecc";
    else if (baseStatus === "working") activitySource = "openclaw";

    const effectiveStatus = remoteCcWorking > 0 ? "working" : baseStatus;

    return {
      ...row,
      status: effectiveStatus,
      activity_source: activitySource,
      remotecc_working_count: remoteCcWorking,
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

  let rows;
  if (officeId) {
    // Return agents in a specific office, with their office-specific department
    rows = db
      .prepare(
        `SELECT a.*, oa.department_id as office_department_id,
                d.name AS department_name, d.name_ko AS department_name_ko, d.color AS department_color,
                COALESCE(ds.remotecc_working_count, 0) AS remotecc_working_count
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
                COALESCE(ds.remotecc_working_count, 0) AS remotecc_working_count
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
              COALESCE(ds.remotecc_working_count, 0) AS remotecc_working_count
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

router.post("/api/agents", (req, res) => {
  const db = getDb();
  const id = crypto.randomUUID();
  const b = req.body;
  db.prepare(
    `INSERT INTO agents (id, openclaw_id, name, name_ko, name_ja, name_zh,
      department_id, role, avatar_emoji, sprite_number, personality, cli_provider, status, alias, discord_channel_id_codex)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    b.openclaw_id ?? null,
    b.name ?? "",
    b.name_ko ?? "",
    b.name_ja ?? "",
    b.name_zh ?? "",
    b.department_id ?? null,
    b.role ?? "senior",
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
    "role",
    "avatar_emoji",
    "sprite_number",
    "personality",
    "status",
    "session_info",
    "stats_tasks_done",
    "stats_xp",
    "openclaw_id",
    "alias",
    "cli_provider",
    "discord_channel_id",
    "discord_channel_id_alt",
    "discord_channel_id_codex",
    "discord_prefer_alt",
  ];
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const f of fields) {
    if (f in req.body) {
      sets.push(`${f} = ?`);
      vals.push(req.body[f]);
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
              COALESCE(ds.remotecc_working_count, 0) AS remotecc_working_count
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
  broadcast("agent_status", hydrated);
  res.json(hydrated);
});

router.delete("/api/agents/:id", (req, res) => {
  const db = getDb();
  // office_agents cascade-deletes automatically
  db.prepare("DELETE FROM agents WHERE id = ?").run(req.params.id);
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

  const openclawId = agent.openclaw_id as string | null;
  if (!openclawId) return res.json({ jobs: [] });

  try {
    const cronPath = nodePath.join(
      os.homedir(),
      ".openclaw",
      "cron",
      "jobs.json",
    );
    if (!fs.existsSync(cronPath)) return res.json({ jobs: [] });
    const data = JSON.parse(fs.readFileSync(cronPath, "utf-8"));
    const jobs = (data.jobs || [])
      .filter((j: Record<string, unknown>) => j.agentId === openclawId)
      .map((j: Record<string, unknown>) => ({
        id: j.id,
        name: String(j.name || ""),
        enabled: j.enabled,
        schedule: j.schedule,
        state: j.state,
      }));
    res.json({ jobs });
  } catch {
    res.json({ jobs: [] });
  }
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

  const openclawId = agent.openclaw_id as string | null;
  if (!openclawId) return res.json({ skills: [], shared: true });

  const homeDir = os.homedir();
  const agentWsDir = nodePath.join(
    homeDir,
    ".openclaw",
    `workspace-${openclawId}`,
    "skills",
    "public",
  );
  const mainWsDir = nodePath.join(
    homeDir,
    ".openclaw",
    "workspace",
    "skills",
    "public",
  );

  // Determine which workspace to read
  const wsDir = fs.existsSync(agentWsDir) ? agentWsDir : mainWsDir;
  if (!fs.existsSync(wsDir)) return res.json({ skills: [], shared: true });

  try {
    // Get main workspace skills for comparison
    const mainSkillNames = new Set<string>();
    if (fs.existsSync(mainWsDir)) {
      for (const name of fs.readdirSync(mainWsDir)) {
        if (fs.existsSync(nodePath.join(mainWsDir, name, "SKILL.md"))) {
          mainSkillNames.add(name);
        }
      }
    }

    const skillDirs = fs.readdirSync(wsDir).filter((name) => {
      return fs.existsSync(nodePath.join(wsDir, name, "SKILL.md"));
    });

    const skills = skillDirs.map((name) => {
      const skillMdPath = nodePath.join(wsDir, name, "SKILL.md");
      const content = fs.readFileSync(skillMdPath, "utf-8");
      // Parse frontmatter description
      let description = "";
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/description:\s*(.+)/);
        if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
      }
      const isShared = mainSkillNames.has(name);
      return { name, description, shared: isShared };
    });

    // Separate: agent-specific (not in main workspace) vs shared
    const agentSpecific = skills.filter((s) => !s.shared);
    const shared = skills.filter((s) => s.shared);

    res.json({
      skills: agentSpecific,
      sharedSkills: shared,
      totalCount: skills.length,
    });
  } catch {
    res.json({ skills: [], shared: true });
  }
});

// ── Discord channel mapping (reads openclaw.json bindings) ──
router.get("/api/discord-bindings", (_req, res) => {
  try {
    const db = getDb();
    const ocPath = nodePath.join(os.homedir(), ".openclaw", "openclaw.json");
    const bindings: Array<{ agentId: string; channelId: string; channelName?: string }> = [];
    const seen = new Set<string>();

    if (fs.existsSync(ocPath)) {
      const oc = JSON.parse(fs.readFileSync(ocPath, "utf-8"));
      const discordChannels = oc?.channels?.discord;
      if (discordChannels?.bindings && Array.isArray(discordChannels.bindings)) {
        for (const b of discordChannels.bindings) {
          if (!b.agentId) continue;
          if (b.channelId) {
            const key = `${b.agentId}:${b.channelId}`;
            if (!seen.has(key)) {
              seen.add(key);
              bindings.push({ agentId: b.agentId, channelId: b.channelId, channelName: b.channelName });
            }
          }
          if (b.dmUserId) {
            const dmChannelId = `dm:${b.dmUserId}`;
            const key = `${b.agentId}:${dmChannelId}`;
            if (!seen.has(key)) {
              seen.add(key);
              bindings.push({ agentId: b.agentId, channelId: dmChannelId, channelName: "DM" });
            }
          }
        }
      }
    }

    const agentRows = db
      .prepare(
        `SELECT id, discord_channel_id, discord_channel_id_alt, discord_channel_id_codex
         FROM agents`,
      )
      .all() as Array<{
      id: string;
      discord_channel_id: string | null;
      discord_channel_id_alt: string | null;
      discord_channel_id_codex: string | null;
    }>;
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
        bindings.push({ agentId: row.id, channelId, channelName: label });
      }
    }

    res.json({ bindings });
  } catch {
    res.json({ bindings: [] });
  }
});

export default router;
