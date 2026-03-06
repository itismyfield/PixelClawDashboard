import type { DatabaseSync } from "node:sqlite";

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS offices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '🏢',
      color TEXT NOT NULL DEFAULT '#6366f1',
      description TEXT DEFAULT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#3b82f6',
      description TEXT DEFAULT NULL,
      office_id TEXT DEFAULT NULL REFERENCES offices(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      openclaw_id TEXT UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
      role TEXT NOT NULL DEFAULT 'senior'
        CHECK(role IN ('team_leader','senior','junior','intern')),
      avatar_emoji TEXT NOT NULL DEFAULT '🙂',
      sprite_number INTEGER DEFAULT NULL,
      personality TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK(status IN ('idle','working','break','offline')),
      session_info TEXT DEFAULT NULL,
      stats_tasks_done INTEGER NOT NULL DEFAULT 0,
      stats_xp INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS office_agents (
      office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      department_id TEXT DEFAULT NULL REFERENCES departments(id) ON DELETE SET NULL,
      joined_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (office_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS dispatched_sessions (
      id TEXT PRIMARY KEY,
      session_key TEXT UNIQUE,
      name TEXT DEFAULT NULL,
      department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
      linked_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      model TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'working'
        CHECK(status IN ('working','idle','disconnected')),
      session_info TEXT DEFAULT NULL,
      sprite_number INTEGER DEFAULT NULL,
      avatar_emoji TEXT NOT NULL DEFAULT '👤',
      connected_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_seen_at INTEGER DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS skill_usage_events (
      event_key TEXT PRIMARY KEY,
      skill_name TEXT NOT NULL,
      session_key TEXT DEFAULT NULL,
      agent_openclaw_id TEXT DEFAULT NULL,
      agent_name TEXT DEFAULT NULL,
      used_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_sync_offsets (
      file_path TEXT PRIMARY KEY,
      offset INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_usage_name_time
      ON skill_usage_events (skill_name, used_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_usage_agent_time
      ON skill_usage_events (agent_openclaw_id, used_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_type TEXT NOT NULL DEFAULT 'ceo' CHECK(sender_type IN ('ceo','agent','system')),
      sender_id TEXT DEFAULT NULL,
      receiver_type TEXT NOT NULL DEFAULT 'agent' CHECK(receiver_type IN ('agent','department','all')),
      receiver_id TEXT DEFAULT NULL,
      content TEXT NOT NULL DEFAULT '',
      message_type TEXT NOT NULL DEFAULT 'chat' CHECK(message_type IN ('chat','announcement','directive','report','status_update')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages (receiver_type, receiver_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_type, sender_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS daily_activity (
      agent_id TEXT NOT NULL,
      date TEXT NOT NULL,
      tasks_done INTEGER NOT NULL DEFAULT 0,
      xp_earned INTEGER NOT NULL DEFAULT 0,
      skill_calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, date)
    );

    CREATE TABLE IF NOT EXISTS achievements (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT NULL,
      earned_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_achievements_agent ON achievements (agent_id);

    CREATE TABLE IF NOT EXISTS task_dispatches (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT,
      dispatch_type TEXT NOT NULL DEFAULT 'generic',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','dispatched','in_progress','completed','failed','cancelled')),
      title TEXT NOT NULL,
      context_file TEXT DEFAULT NULL,
      result_file TEXT DEFAULT NULL,
      result_summary TEXT DEFAULT NULL,
      parent_dispatch_id TEXT DEFAULT NULL,
      chain_depth INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      dispatched_at INTEGER DEFAULT NULL,
      completed_at INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatches_status ON task_dispatches (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dispatches_chain ON task_dispatches (parent_dispatch_id);

    CREATE TABLE IF NOT EXISTS round_table_meetings (
      id TEXT PRIMARY KEY,
      agenda TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK(status IN ('in_progress','completed','cancelled')),
      participant_names TEXT NOT NULL DEFAULT '[]',
      total_rounds INTEGER NOT NULL DEFAULT 0,
      issues_created INTEGER NOT NULL DEFAULT 0,
      issue_creation_results TEXT DEFAULT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS round_table_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES round_table_meetings(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      round INTEGER NOT NULL,
      speaker_role_id TEXT,
      speaker_name TEXT NOT NULL,
      content TEXT NOT NULL,
      is_summary INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_rt_entries_meeting ON round_table_entries (meeting_id, seq);
  `);

  migrate(db);

  // Reset stale working agents to idle on startup
  const staleCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE status = 'working'").get() as { cnt: number }
  ).cnt;
  if (staleCount > 0) {
    db.exec("UPDATE agents SET status = 'idle' WHERE status = 'working'");
    console.log(`[PCD] Reset ${staleCount} stale working agent(s) to idle`);
  }

  // Reset stale dispatched sessions to disconnected on startup
  const staleDispatched = (
    db.prepare("SELECT COUNT(*) as cnt FROM dispatched_sessions WHERE status != 'disconnected'").get() as { cnt: number }
  ).cnt;
  if (staleDispatched > 0) {
    db.exec("UPDATE dispatched_sessions SET status = 'disconnected' WHERE status != 'disconnected'");
    console.log(`[PCD] Reset ${staleDispatched} stale dispatched session(s) to disconnected`);
  }
}

function migrate(db: DatabaseSync): void {
  // Add stats_xp column to dispatched_sessions if missing
  const dsCols = db
    .prepare("PRAGMA table_info(dispatched_sessions)")
    .all() as Array<{ name: string }>;
  if (!dsCols.some((c) => c.name === "stats_xp")) {
    db.exec(
      "ALTER TABLE dispatched_sessions ADD COLUMN stats_xp INTEGER NOT NULL DEFAULT 0",
    );
  }

  // Add office_id column to departments if missing (existing DB upgrade)
  const deptCols = db
    .prepare("PRAGMA table_info(departments)")
    .all() as Array<{ name: string }>;
  if (!deptCols.some((c) => c.name === "office_id")) {
    db.exec(
      "ALTER TABLE departments ADD COLUMN office_id TEXT DEFAULT NULL",
    );
  }

  // Add alias column to agents if missing
  const agentCols = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;
  if (!agentCols.some((c) => c.name === "alias")) {
    db.exec("ALTER TABLE agents ADD COLUMN alias TEXT DEFAULT NULL");
  }

  // Add discord_channel_id column to agents if missing
  const agentCols2 = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;
  if (!agentCols2.some((c) => c.name === "discord_channel_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN discord_channel_id TEXT DEFAULT NULL");
  }

  // Add proposed_issues column to round_table_meetings if missing
  const rtCols = db
    .prepare("PRAGMA table_info(round_table_meetings)")
    .all() as Array<{ name: string }>;
  if (!rtCols.some((c) => c.name === "proposed_issues")) {
    db.exec("ALTER TABLE round_table_meetings ADD COLUMN proposed_issues TEXT DEFAULT NULL");
  }
  if (!rtCols.some((c) => c.name === "issue_creation_results")) {
    db.exec(
      "ALTER TABLE round_table_meetings ADD COLUMN issue_creation_results TEXT DEFAULT NULL",
    );
  }

  // Add dual-channel support: alt channel + preference flag
  const agentCols3 = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;
  if (!agentCols3.some((c) => c.name === "discord_channel_id_alt")) {
    db.exec("ALTER TABLE agents ADD COLUMN discord_channel_id_alt TEXT DEFAULT NULL");
  }
  if (!agentCols3.some((c) => c.name === "discord_prefer_alt")) {
    db.exec("ALTER TABLE agents ADD COLUMN discord_prefer_alt INTEGER NOT NULL DEFAULT 0");
  }

  // Merge legacy dispatched XP into linked agents (one-time idempotent behavior via zeroing)
  const linkedXpRows = db
    .prepare(
      "SELECT id, linked_agent_id, stats_xp FROM dispatched_sessions WHERE linked_agent_id IS NOT NULL AND stats_xp > 0",
    )
    .all() as Array<{ id: string; linked_agent_id: string; stats_xp: number }>;
  if (linkedXpRows.length > 0) {
    const addXp = db.prepare("UPDATE agents SET stats_xp = stats_xp + ? WHERE id = ?");
    const clearXp = db.prepare("UPDATE dispatched_sessions SET stats_xp = 0 WHERE id = ?");
    for (const row of linkedXpRows) {
      addXp.run(row.stats_xp, row.linked_agent_id);
      clearXp.run(row.id);
    }
    console.log(`[PCD] Migrated dispatched XP into linked agents: ${linkedXpRows.length} row(s)`);
  }

  // If no offices exist and there are agents or departments, seed default office
  const officeCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM offices").get() as { cnt: number }
  ).cnt;

  if (officeCount === 0) {
    const agentCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM agents").get() as {
        cnt: number;
      }
    ).cnt;
    const deptCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM departments").get() as {
        cnt: number;
      }
    ).cnt;

    if (agentCount > 0 || deptCount > 0) {
      db.prepare(
        `INSERT INTO offices (id, name, name_ko, icon, color, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("main", "Main Office", "메인 오피스", "🏢", "#6366f1", 0);

      // Assign existing departments to main office
      db.exec(
        "UPDATE departments SET office_id = 'main' WHERE office_id IS NULL",
      );

      // Assign existing agents to main office
      const existingAgents = db
        .prepare("SELECT id, department_id FROM agents")
        .all() as Array<{ id: string; department_id: string | null }>;
      const ins = db.prepare(
        "INSERT OR IGNORE INTO office_agents (office_id, agent_id, department_id) VALUES (?, ?, ?)",
      );
      for (const a of existingAgents) {
        ins.run("main", a.id, a.department_id);
      }
    }
  }
}
