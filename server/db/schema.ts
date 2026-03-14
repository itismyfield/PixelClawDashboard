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
      role_id TEXT UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
      avatar_emoji TEXT NOT NULL DEFAULT '🙂',
      sprite_number INTEGER DEFAULT NULL,
      personality TEXT DEFAULT NULL,
      cli_provider TEXT NOT NULL DEFAULT 'claude'
        CHECK(cli_provider IN ('claude','codex','gemini','opencode','copilot','antigravity','api')),
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK(status IN ('idle','working','break','offline')),
      session_info TEXT DEFAULT NULL,
      stats_tasks_done INTEGER NOT NULL DEFAULT 0,
      stats_xp INTEGER NOT NULL DEFAULT 0,
      stats_tokens INTEGER NOT NULL DEFAULT 0,
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
      provider TEXT NOT NULL DEFAULT 'claude'
        CHECK(provider IN ('claude','codex','gemini','opencode','copilot','antigravity','api')),
      model TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'working'
        CHECK(status IN ('working','idle','disconnected')),
      session_info TEXT DEFAULT NULL,
      cwd TEXT DEFAULT NULL,
      sprite_number INTEGER DEFAULT NULL,
      avatar_emoji TEXT NOT NULL DEFAULT '👤',
      connected_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_seen_at INTEGER DEFAULT NULL,
      stats_xp INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS skill_usage_events (
      event_key TEXT PRIMARY KEY,
      skill_name TEXT NOT NULL,
      session_key TEXT DEFAULT NULL,
      agent_role_id TEXT DEFAULT NULL,
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
      ON skill_usage_events (agent_role_id, used_at DESC);

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

    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'backlog'
        CHECK(status IN ('backlog','ready','requested','in_progress','review','blocked','done','failed','cancelled')),
      github_repo TEXT DEFAULT NULL,
      owner_agent_id TEXT DEFAULT NULL REFERENCES agents(id) ON DELETE SET NULL,
      requester_agent_id TEXT DEFAULT NULL REFERENCES agents(id) ON DELETE SET NULL,
      assignee_agent_id TEXT DEFAULT NULL REFERENCES agents(id) ON DELETE SET NULL,
      parent_card_id TEXT DEFAULT NULL REFERENCES kanban_cards(id) ON DELETE SET NULL,
      latest_dispatch_id TEXT DEFAULT NULL REFERENCES task_dispatches(id) ON DELETE SET NULL,
      sort_order REAL NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('low','medium','high','urgent')),
      depth INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT DEFAULT NULL,
      review_notes TEXT DEFAULT NULL,
      github_issue_number INTEGER DEFAULT NULL,
      github_issue_url TEXT DEFAULT NULL,
      metadata_json TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      started_at INTEGER DEFAULT NULL,
      requested_at INTEGER DEFAULT NULL,
      completed_at INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_status ON kanban_cards (status, sort_order, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_assignee ON kanban_cards (assignee_agent_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_parent ON kanban_cards (parent_card_id);
    CREATE TABLE IF NOT EXISTS kanban_repo_sources (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL UNIQUE,
      default_agent_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_repo_sources_created ON kanban_repo_sources (created_at DESC);

    CREATE TABLE IF NOT EXISTS dispatch_queue (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      card_id TEXT NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
      priority_rank INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','dispatched','done','skipped')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      dispatched_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_agent ON dispatch_queue (agent_id, status, priority_rank);
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_status ON dispatch_queue (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS auto_queue_runs (
      id TEXT PRIMARY KEY,
      repo TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','paused','completed')),
      ai_model TEXT,
      ai_rationale TEXT,
      timeout_minutes INTEGER NOT NULL DEFAULT 100,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS round_table_meetings (
      id TEXT PRIMARY KEY,
      agenda TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK(status IN ('in_progress','completed','cancelled')),
      primary_provider TEXT DEFAULT NULL,
      reviewer_provider TEXT DEFAULT NULL,
      participant_names TEXT NOT NULL DEFAULT '[]',
      total_rounds INTEGER NOT NULL DEFAULT 0,
      issues_created INTEGER NOT NULL DEFAULT 0,
      issue_creation_results TEXT DEFAULT NULL,
      issue_repo TEXT DEFAULT NULL,
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

    CREATE TABLE IF NOT EXISTS issue_triage_log (
      github_repo TEXT NOT NULL,
      github_issue_number INTEGER NOT NULL,
      github_issue_title TEXT NOT NULL DEFAULT '',
      assigned_agent_id TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT 'medium'
        CHECK(confidence IN ('high','medium','low')),
      reason TEXT NOT NULL DEFAULT '',
      triaged_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (github_repo, github_issue_number)
    );

    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      stage_name TEXT NOT NULL,
      stage_order INTEGER NOT NULL DEFAULT 0,
      entry_skill TEXT DEFAULT NULL,
      provider TEXT DEFAULT NULL,
      agent_override_id TEXT DEFAULT NULL,
      timeout_minutes INTEGER NOT NULL DEFAULT 60,
      on_failure TEXT NOT NULL DEFAULT 'fail'
        CHECK(on_failure IN ('fail','retry','previous','goto')),
      on_failure_target TEXT DEFAULT NULL,
      max_retries INTEGER NOT NULL DEFAULT 3,
      skip_condition TEXT DEFAULT NULL,
      parallel_with TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_stages_repo ON pipeline_stages (repo, stage_order);

    CREATE TABLE IF NOT EXISTS pipeline_history (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
      stage_id TEXT NOT NULL,
      stage_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','completed','failed','skipped','retrying')),
      attempt INTEGER NOT NULL DEFAULT 1,
      dispatch_id TEXT DEFAULT NULL,
      failure_reason TEXT DEFAULT NULL,
      started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      completed_at INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_history_card ON pipeline_history (card_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS kanban_reviews (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
      round INTEGER NOT NULL DEFAULT 1,
      original_dispatch_id TEXT,
      original_agent_id TEXT,
      original_provider TEXT,
      review_dispatch_id TEXT,
      reviewer_agent_id TEXT,
      reviewer_provider TEXT,
      verdict TEXT NOT NULL DEFAULT 'pending'
        CHECK(verdict IN ('pending','pass','improve','dilemma','mixed','decided')),
      items_json TEXT DEFAULT NULL,
      github_comment_id TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      completed_at INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_reviews_card ON kanban_reviews (card_id, round DESC);
    CREATE INDEX IF NOT EXISTS idx_kanban_reviews_dispatch ON kanban_reviews (review_dispatch_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL DEFAULT 'dashboard-session',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      metadata_json TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id, created_at DESC);
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

  // Monthly token/XP soft reset (reduce to 1/10 on first boot of each month)
  db.exec("CREATE TABLE IF NOT EXISTS kv_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const lastReset = db.prepare("SELECT value FROM kv_meta WHERE key = 'xp_reset_month'").get() as { value: string } | undefined;
  if (lastReset?.value !== currentMonth) {
    db.exec("UPDATE agents SET stats_tokens = stats_tokens / 10, stats_xp = stats_tokens / 10 / 1000");
    db.prepare("INSERT INTO kv_meta (key, value) VALUES ('xp_reset_month', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(currentMonth);
    const agentCount = (db.prepare("SELECT COUNT(*) as cnt FROM agents").get() as { cnt: number }).cnt;
    console.log(`[PCD] Monthly token/XP soft reset (1/10) applied for ${currentMonth} — ${agentCount} agent(s)`);
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
  if (!dsCols.some((c) => c.name === "cwd")) {
    db.exec("ALTER TABLE dispatched_sessions ADD COLUMN cwd TEXT DEFAULT NULL");
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
  if (!agentCols.some((c) => c.name === "cli_provider")) {
    db.exec("ALTER TABLE agents ADD COLUMN cli_provider TEXT NOT NULL DEFAULT 'claude'");
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
  if (!rtCols.some((c) => c.name === "issue_repo")) {
    db.exec("ALTER TABLE round_table_meetings ADD COLUMN issue_repo TEXT DEFAULT NULL");
  }
  if (!rtCols.some((c) => c.name === "primary_provider")) {
    db.exec("ALTER TABLE round_table_meetings ADD COLUMN primary_provider TEXT DEFAULT NULL");
  }
  if (!rtCols.some((c) => c.name === "reviewer_provider")) {
    db.exec("ALTER TABLE round_table_meetings ADD COLUMN reviewer_provider TEXT DEFAULT NULL");
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
  if (!agentCols3.some((c) => c.name === "discord_channel_id_codex")) {
    db.exec("ALTER TABLE agents ADD COLUMN discord_channel_id_codex TEXT DEFAULT NULL");
  }

  const kanbanCols = db
    .prepare("PRAGMA table_info(kanban_cards)")
    .all() as Array<{ name: string }>;
  if (kanbanCols.length > 0 && !kanbanCols.some((c) => c.name === "github_repo")) {
    db.exec("ALTER TABLE kanban_cards ADD COLUMN github_repo TEXT DEFAULT NULL");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_kanban_cards_repo_issue ON kanban_cards (github_repo, github_issue_number, status, updated_at DESC)",
  );

  if (!dsCols.some((c) => c.name === "active_dispatch_id")) {
    db.exec("ALTER TABLE dispatched_sessions ADD COLUMN active_dispatch_id TEXT DEFAULT NULL");
  }
  if (!dsCols.some((c) => c.name === "provider")) {
    db.exec("ALTER TABLE dispatched_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
  }
  db.exec(`
    UPDATE dispatched_sessions
    SET provider = CASE
      WHEN session_key LIKE '%:remoteCC-codex-%' THEN 'codex'
      ELSE 'claude'
    END
    WHERE provider IS NULL OR provider = '' OR provider = 'claude'
  `);

  // Add pipeline_stage_id column to kanban_cards if missing
  const kanbanCols2 = db.prepare("PRAGMA table_info(kanban_cards)").all() as Array<{ name: string }>;
  if (!kanbanCols2.some((c) => c.name === "pipeline_stage_id")) {
    db.exec("ALTER TABLE kanban_cards ADD COLUMN pipeline_stage_id TEXT DEFAULT NULL");
  }

  const repoSrcCols = db.prepare("PRAGMA table_info(kanban_repo_sources)").all() as Array<{ name: string }>;
  if (!repoSrcCols.some((c) => c.name === "default_agent_id")) {
    db.exec("ALTER TABLE kanban_repo_sources ADD COLUMN default_agent_id TEXT DEFAULT NULL");
  }

  // Add review_status column to kanban_cards if missing
  const kanbanCols3 = db.prepare("PRAGMA table_info(kanban_cards)").all() as Array<{ name: string }>;
  if (!kanbanCols3.some((c) => c.name === "review_status")) {
    db.exec("ALTER TABLE kanban_cards ADD COLUMN review_status TEXT DEFAULT NULL");
  }

  // Rename openclaw_id → role_id (legacy column name)
  const agentCols4 = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (agentCols4.some((c) => c.name === "openclaw_id") && !agentCols4.some((c) => c.name === "role_id")) {
    db.exec("ALTER TABLE agents RENAME COLUMN openclaw_id TO role_id");
  }
  const skillEvtCols = db.prepare("PRAGMA table_info(skill_usage_events)").all() as Array<{ name: string }>;
  if (skillEvtCols.some((c) => c.name === "agent_openclaw_id") && !skillEvtCols.some((c) => c.name === "agent_role_id")) {
    db.exec("ALTER TABLE skill_usage_events RENAME COLUMN agent_openclaw_id TO agent_role_id");
  }

  // Add stats_tokens column to agents if missing
  const agentCols5 = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentCols5.some((c) => c.name === "stats_tokens")) {
    db.exec("ALTER TABLE agents ADD COLUMN stats_tokens INTEGER NOT NULL DEFAULT 0");
  }

  // Add tokens column to dispatched_sessions if missing
  const dsCols2 = db.prepare("PRAGMA table_info(dispatched_sessions)").all() as Array<{ name: string }>;
  if (!dsCols2.some((c) => c.name === "tokens")) {
    db.exec("ALTER TABLE dispatched_sessions ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0");
  }

  // delivered_at: tracks when dispatch message was actually sent to Discord
  const dispatchCols = db.prepare("PRAGMA table_info(task_dispatches)").all() as Array<{ name: string }>;
  if (!dispatchCols.some((c) => c.name === "delivered_at")) {
    db.exec("ALTER TABLE task_dispatches ADD COLUMN delivered_at INTEGER DEFAULT NULL");
    // Backfill: assume all existing dispatched/in_progress/completed rows were delivered
    db.exec("UPDATE task_dispatches SET delivered_at = dispatched_at WHERE dispatched_at IS NOT NULL AND status != 'pending'");
  }

  // One-time migration: reset all XP/token data to 0 (PCD #5)
  const tokenMigDone = db.prepare("SELECT value FROM kv_meta WHERE key = 'token_migration_v1'").get() as { value: string } | undefined;
  if (!tokenMigDone) {
    db.exec("UPDATE agents SET stats_xp = 0, stats_tokens = 0");
    db.exec("UPDATE dispatched_sessions SET stats_xp = 0, tokens = 0");
    db.prepare("INSERT INTO kv_meta (key, value) VALUES ('token_migration_v1', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
    console.log("[PCD] Token migration v1: reset all XP/token data to 0");
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
