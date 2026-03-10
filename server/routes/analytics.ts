import { Router } from "express";
import { execSync } from "node:child_process";
import { getDb } from "../db/runtime.js";
import { listLaunchdJobs } from "../launchd-jobs.js";
import { IN_PROGRESS_STALE_MS, REQUEST_ACK_TIMEOUT_MS } from "../kanban-cards.js";

const router = Router();

router.get("/api/stats", (req, res) => {
  const db = getDb();
  const officeId = req.query.officeId as string | undefined;

  let agentStats: Record<string, number>;
  let topAgents;
  let deptStats;

  if (officeId) {
    const agentRows = db
      .prepare(
        `SELECT a.status, COUNT(*) as cnt
         FROM office_agents oa JOIN agents a ON a.id = oa.agent_id
         WHERE oa.office_id = ?
         GROUP BY a.status`,
      )
      .all(officeId) as Array<{ status: string; cnt: number }>;
    agentStats = { total: 0, working: 0, idle: 0, break: 0, offline: 0 };
    for (const r of agentRows) {
      agentStats[r.status] = r.cnt;
      agentStats.total += r.cnt;
    }

    const remoteCcWorkingOnly = (
      db
        .prepare(
          `SELECT COUNT(*) as cnt
           FROM office_agents oa
           JOIN agents a ON a.id = oa.agent_id
           WHERE oa.office_id = ?
             AND a.status != 'working'
             AND EXISTS (
               SELECT 1 FROM dispatched_sessions ds
               WHERE ds.linked_agent_id = a.id AND ds.status = 'working'
             )`,
        )
        .get(officeId) as { cnt: number }
    ).cnt;
    agentStats.working += remoteCcWorkingOnly;

    topAgents = db
      .prepare(
        `SELECT a.id, a.name, a.alias, a.name_ko, a.avatar_emoji, a.stats_tasks_done, a.stats_xp
         FROM office_agents oa JOIN agents a ON a.id = oa.agent_id
         WHERE oa.office_id = ?
         ORDER BY a.stats_xp DESC LIMIT 10`,
      )
      .all(officeId);

    deptStats = db
      .prepare(
        `SELECT d.id, d.name, d.name_ko, d.icon, d.color,
                COUNT(oa.agent_id) as total_agents,
                SUM(CASE WHEN a.status = 'working' THEN 1 ELSE 0 END) as working_agents,
                COALESCE(SUM(a.stats_xp), 0) as sum_xp
         FROM departments d
         LEFT JOIN office_agents oa ON oa.department_id = d.id AND oa.office_id = ?
         LEFT JOIN agents a ON a.id = oa.agent_id
         WHERE d.office_id = ?
         GROUP BY d.id
         ORDER BY d.sort_order`,
      )
      .all(officeId, officeId);
  } else {
    const agentRows = db
      .prepare("SELECT status, COUNT(*) as cnt FROM agents GROUP BY status")
      .all() as Array<{ status: string; cnt: number }>;
    agentStats = { total: 0, working: 0, idle: 0, break: 0, offline: 0 };
    for (const r of agentRows) {
      agentStats[r.status] = r.cnt;
      agentStats.total += r.cnt;
    }

    const remoteCcWorkingOnly = (
      db
        .prepare(
          `SELECT COUNT(*) as cnt
           FROM agents a
           WHERE a.status != 'working'
             AND EXISTS (
               SELECT 1 FROM dispatched_sessions ds
               WHERE ds.linked_agent_id = a.id AND ds.status = 'working'
             )`,
        )
        .get() as { cnt: number }
    ).cnt;
    agentStats.working += remoteCcWorkingOnly;

    topAgents = db
      .prepare(
        `SELECT id, name, alias, name_ko, avatar_emoji, stats_tasks_done, stats_xp
         FROM agents ORDER BY stats_xp DESC LIMIT 10`,
      )
      .all();

    deptStats = db
      .prepare(
        `SELECT d.id, d.name, d.name_ko, d.icon, d.color,
                COUNT(a.id) as total_agents,
                SUM(CASE WHEN a.status = 'working' THEN 1 ELSE 0 END) as working_agents,
                COALESCE(SUM(a.stats_xp), 0) as sum_xp
         FROM departments d
         LEFT JOIN agents a ON a.department_id = d.id
         GROUP BY d.id
         ORDER BY d.sort_order`,
      )
      .all();
  }

  const dispatchedCount = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM dispatched_sessions WHERE status != 'disconnected' AND linked_agent_id IS NULL",
      )
      .get() as { cnt: number }
  ).cnt;

  const requestedCutoff = Date.now() - REQUEST_ACK_TIMEOUT_MS;
  const progressCutoff = Date.now() - IN_PROGRESS_STALE_MS;
  const kanbanCounts = db.prepare(
    `SELECT status, COUNT(*) as cnt
     FROM kanban_cards
     GROUP BY status`,
  ).all() as Array<{ status: string; cnt: number }>;
  const kanbanByStatus = {
    backlog: 0,
    ready: 0,
    requested: 0,
    in_progress: 0,
    review: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of kanbanCounts) {
    if (row.status in kanbanByStatus) {
      kanbanByStatus[row.status as keyof typeof kanbanByStatus] = row.cnt;
    }
  }

  const waitingAcceptance = (
    db.prepare(
      `SELECT COUNT(*) as cnt
       FROM kanban_cards
       WHERE status = 'requested'
         AND COALESCE(requested_at, updated_at, created_at) < ?`,
    ).get(requestedCutoff) as { cnt: number }
  ).cnt;

  const staleInProgress = (
    db.prepare(
      `SELECT COUNT(*) as cnt
       FROM kanban_cards
       WHERE status = 'in_progress'
         AND COALESCE(started_at, updated_at, created_at) < ?`,
    ).get(progressCutoff) as { cnt: number }
  ).cnt;

  const topRepos = db.prepare(
    `SELECT COALESCE(github_repo, '(unscoped)') as github_repo,
            COUNT(*) as open_count,
            SUM(CASE WHEN status IN ('review', 'blocked', 'failed') THEN 1 ELSE 0 END) as pressure_count
     FROM kanban_cards
     WHERE status NOT IN ('done', 'cancelled')
     GROUP BY COALESCE(github_repo, '(unscoped)')
     ORDER BY pressure_count DESC, open_count DESC, github_repo ASC
     LIMIT 5`,
  ).all() as Array<{ github_repo: string; open_count: number; pressure_count: number }>;

  res.json({
    agents: agentStats,
    top_agents: topAgents,
    departments: deptStats,
    dispatched_count: dispatchedCount,
    kanban: {
      open_total:
        kanbanByStatus.backlog +
        kanbanByStatus.ready +
        kanbanByStatus.requested +
        kanbanByStatus.in_progress +
        kanbanByStatus.review +
        kanbanByStatus.blocked +
        kanbanByStatus.failed,
      review_queue: kanbanByStatus.review,
      blocked: kanbanByStatus.blocked,
      failed: kanbanByStatus.failed,
      waiting_acceptance: waitingAcceptance,
      stale_in_progress: staleInProgress,
      by_status: kanbanByStatus,
      top_repos: topRepos,
    },
  });
});

router.get("/api/cron-jobs", (_req, res) => {
  res.json({ jobs: listLaunchdJobs() });
});

router.get("/api/machine-status", (_req, res) => {
  const machines = [
    { name: "mac-mini", online: true, lastChecked: Date.now() },
  ];
  try {
    execSync("/sbin/ping -c 1 -W 2 100.71.169.10 2>/dev/null", {
      timeout: 3000,
      encoding: "utf-8",
    });
    machines.push({ name: "mac-book", online: true, lastChecked: Date.now() });
  } catch {
    machines.push({ name: "mac-book", online: false, lastChecked: Date.now() });
  }
  res.json(machines);
});

router.get("/api/activity-heatmap", (req, res) => {
  const db = getDb();
  const dateStr = req.query.date as string | undefined;
  const now = new Date();
  const targetDate = dateStr ? new Date(dateStr) : now;
  const dayStart = new Date(targetDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const rows = db
    .prepare(
      `SELECT agent_openclaw_id, used_at FROM skill_usage_events
       WHERE used_at >= ? AND used_at < ?
       ORDER BY used_at`,
    )
    .all(dayStart.getTime(), dayEnd.getTime()) as Array<{
    agent_openclaw_id: string | null;
    used_at: number;
  }>;

  const hours: Array<{ hour: number; agents: Record<string, number> }> = [];
  for (let h = 0; h < 24; h++) {
    hours.push({ hour: h, agents: {} });
  }
  for (const r of rows) {
    const h = new Date(r.used_at).getHours();
    const aid = r.agent_openclaw_id || "unknown";
    hours[h].agents[aid] = (hours[h].agents[aid] || 0) + 1;
  }

  res.json({ hours, date: dayStart.toISOString().slice(0, 10) });
});

router.get("/api/skills/trend", (req, res) => {
  const db = getDb();
  const days = Math.min(parseInt(req.query.days as string) || 30, 90);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const rows = db
    .prepare(
      `SELECT skill_name, used_at FROM skill_usage_events
       WHERE used_at >= ?
       ORDER BY used_at`,
    )
    .all(cutoff) as Array<{ skill_name: string; used_at: number }>;

  const byDay: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const day = new Date(r.used_at).toISOString().slice(0, 10);
    if (!byDay[day]) byDay[day] = {};
    byDay[day][r.skill_name] = (byDay[day][r.skill_name] || 0) + 1;
  }

  res.json({ trend: byDay, days });
});

router.get("/api/streaks", (_req, res) => {
  const db = getDb();

  const agents = db.prepare("SELECT id, name, alias, name_ko, avatar_emoji, stats_xp FROM agents").all() as Array<{
    id: string;
    name: string;
    alias: string | null;
    name_ko: string;
    avatar_emoji: string;
    stats_xp: number;
  }>;

  const today = new Date().toISOString().slice(0, 10);
  const streaks: Array<{ agent_id: string; name: string; avatar_emoji: string; streak: number; last_active: string }> = [];

  for (const agent of agents) {
    const rows = db.prepare(
      "SELECT date FROM daily_activity WHERE agent_id = ? ORDER BY date DESC LIMIT 60",
    ).all(agent.id) as Array<{ date: string }>;

    if (rows.length === 0) continue;

    let streak = 0;
    const dates = new Set(rows.map((r) => r.date));
    const d = new Date(today);
    if (!dates.has(d.toISOString().slice(0, 10))) {
      d.setDate(d.getDate() - 1);
    }
    while (dates.has(d.toISOString().slice(0, 10))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }

    if (streak > 0) {
      streaks.push({
        agent_id: agent.id,
        name: agent.alias || agent.name_ko || agent.name,
        avatar_emoji: agent.avatar_emoji,
        streak,
        last_active: rows[0].date,
      });
    }
  }

  streaks.sort((a, b) => b.streak - a.streak);
  res.json({ streaks });
});

router.get("/api/achievements", (req, res) => {
  const db = getDb();
  const agentId = req.query.agentId as string | undefined;

  autoGenerateAchievements(db);

  let rows;
  if (agentId) {
    rows = db.prepare(
      `SELECT ach.*, a.name as agent_name, a.name_ko as agent_name_ko, a.avatar_emoji
       FROM achievements ach JOIN agents a ON ach.agent_id = a.id
       WHERE ach.agent_id = ? ORDER BY ach.earned_at DESC LIMIT 50`,
    ).all(agentId);
  } else {
    rows = db.prepare(
      `SELECT ach.*, a.name as agent_name, a.name_ko as agent_name_ko, a.avatar_emoji
       FROM achievements ach JOIN agents a ON ach.agent_id = a.id
       ORDER BY ach.earned_at DESC LIMIT 100`,
    ).all();
  }
  res.json({ achievements: rows });
});

function autoGenerateAchievements(db: ReturnType<typeof getDb>) {
  const agents = db.prepare("SELECT id, name, stats_tasks_done, stats_xp FROM agents").all() as Array<{
    id: string;
    name: string;
    stats_tasks_done: number;
    stats_xp: number;
  }>;

  const rules = [
    { type: "xp_100", threshold: 100, field: "stats_xp" as const, name: "First Steps", desc: "XP 100 달성" },
    { type: "xp_500", threshold: 500, field: "stats_xp" as const, name: "Rising Star", desc: "XP 500 달성" },
    { type: "xp_1000", threshold: 1000, field: "stats_xp" as const, name: "Veteran", desc: "XP 1,000 달성" },
    { type: "xp_5000", threshold: 5000, field: "stats_xp" as const, name: "Legend", desc: "XP 5,000 달성" },
    { type: "tasks_10", threshold: 10, field: "stats_tasks_done" as const, name: "Worker Bee", desc: "10개 작업 완료" },
    { type: "tasks_50", threshold: 50, field: "stats_tasks_done" as const, name: "Productivity King", desc: "50개 작업 완료" },
    { type: "tasks_100", threshold: 100, field: "stats_tasks_done" as const, name: "Centurion", desc: "100개 작업 완료" },
  ];

  const insert = db.prepare(
    "INSERT OR IGNORE INTO achievements (id, agent_id, type, name, description) VALUES (?, ?, ?, ?, ?)",
  );

  for (const agent of agents) {
    for (const rule of rules) {
      if (agent[rule.field] >= rule.threshold) {
        const id = `${agent.id}-${rule.type}`;
        insert.run(id, agent.id, rule.type, rule.name, rule.desc);
      }
    }
  }

  const streakAgents = db.prepare(
    "SELECT agent_id, COUNT(*) as days FROM daily_activity GROUP BY agent_id",
  ).all() as Array<{ agent_id: string; days: number }>;

  for (const sa of streakAgents) {
    if (sa.days >= 7) {
      insert.run(`${sa.agent_id}-streak_7`, sa.agent_id, "streak_7", "Week Warrior", "7일 이상 활동");
    }
    if (sa.days >= 30) {
      insert.run(`${sa.agent_id}-streak_30`, sa.agent_id, "streak_30", "Monthly Hero", "30일 이상 활동");
    }
  }
}

export default router;
