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
  `);

  migrate(db);

  // Reset stale working agents to idle on startup
  // (gateway restarts can cause "sent" events to be lost, leaving agents stuck in working)
  const staleCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE status = 'working'").get() as { cnt: number }
  ).cnt;
  if (staleCount > 0) {
    db.exec("UPDATE agents SET status = 'idle' WHERE status = 'working'");
    console.log(`[PCD] Reset ${staleCount} stale working agent(s) to idle`);
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
