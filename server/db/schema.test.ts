import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initSchema } from "./schema.js";

test("initSchema migrates legacy kanban_cards before creating repo issue index", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'backlog',
      owner_agent_id TEXT DEFAULT NULL,
      requester_agent_id TEXT DEFAULT NULL,
      assignee_agent_id TEXT DEFAULT NULL,
      parent_card_id TEXT DEFAULT NULL,
      latest_dispatch_id TEXT DEFAULT NULL,
      sort_order REAL NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'medium',
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
  `);

  assert.doesNotThrow(() => initSchema(db));

  const kanbanCols = db
    .prepare("PRAGMA table_info(kanban_cards)")
    .all() as Array<{ name: string }>;
  assert.ok(kanbanCols.some((column) => column.name === "github_repo"));

  const indexes = db
    .prepare("PRAGMA index_list(kanban_cards)")
    .all() as Array<{ name: string }>;
  assert.ok(indexes.some((index) => index.name === "idx_kanban_cards_repo_issue"));

  db.close();
});
