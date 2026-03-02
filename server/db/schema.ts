import type { DatabaseSync } from "node:sqlite";

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#3b82f6',
      description TEXT DEFAULT NULL,
      workflow_pack_key TEXT DEFAULT NULL,
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
      workflow_pack_key TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
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
  `);
}
