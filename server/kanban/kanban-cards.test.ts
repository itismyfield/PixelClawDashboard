import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initSchema } from "../db/schema.js";
import {
  enforceKanbanTimeouts,
  parseKanbanCardMetadata,
  rewardKanbanCompletion,
  syncKanbanCardWithDispatch,
} from "../kanban-cards.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  return db;
}

function seedAgent(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO agents (id, name, name_ko, avatar_emoji)
     VALUES (?, ?, ?, '🙂')`,
  ).run(id, id, id);
}

test("rewardKanbanCompletion grants XP and task count only once", () => {
  const db = createDb();
  seedAgent(db, "agent-1");

  const now = Date.now();
  db.prepare(
    `INSERT INTO kanban_cards (
      id, title, status, assignee_agent_id, priority, depth, created_at, updated_at, completed_at
    )
    VALUES (?, ?, 'done', ?, 'high', 1, ?, ?, ?)`,
  ).run("card-1", "Ship dashboard", "agent-1", now, now, now);

  rewardKanbanCompletion(db, "card-1");
  rewardKanbanCompletion(db, "card-1");

  const agent = db.prepare(
    "SELECT stats_tasks_done, stats_xp FROM agents WHERE id = ?",
  ).get("agent-1") as { stats_tasks_done: number; stats_xp: number };
  assert.equal(agent.stats_tasks_done, 1);
  assert.equal(agent.stats_xp, 22);

  const card = db.prepare(
    "SELECT metadata_json FROM kanban_cards WHERE id = ?",
  ).get("card-1") as { metadata_json: string | null };
  const metadata = parseKanbanCardMetadata(card.metadata_json);
  assert.equal(metadata.reward?.agent_id, "agent-1");

  const daily = db.prepare(
    "SELECT tasks_done, xp_earned FROM daily_activity WHERE agent_id = ?",
  ).get("agent-1") as { tasks_done: number; xp_earned: number };
  assert.equal(daily.tasks_done, 1);
  assert.equal(daily.xp_earned, 22);
});

test("enforceKanbanTimeouts fails requested cards and blocks stale in-progress cards", () => {
  const db = createDb();
  seedAgent(db, "agent-1");
  seedAgent(db, "agent-2");

  const now = Date.now();
  db.prepare(
    `INSERT INTO task_dispatches (
      id, from_agent_id, to_agent_id, dispatch_type, status, title, created_at, dispatched_at
    )
    VALUES (?, ?, ?, 'generic', 'dispatched', ?, ?, ?)`,
  ).run("dispatch-1", "agent-1", "agent-2", "Waiting dispatch", now, now - 48 * 60 * 1000);

  db.prepare(
    `INSERT INTO kanban_cards (
      id, title, status, assignee_agent_id, requester_agent_id, latest_dispatch_id, requested_at, created_at, updated_at
    )
    VALUES (?, ?, 'requested', ?, ?, ?, ?, ?, ?)`,
  ).run(
    "card-requested",
    "Waiting dispatch",
    "agent-2",
    "agent-1",
    "dispatch-1",
    now - 48 * 60 * 1000,
    now,
    now,
  );

  db.prepare(
    `INSERT INTO kanban_cards (
      id, title, status, assignee_agent_id, started_at, created_at, updated_at
    )
    VALUES (?, ?, 'in_progress', ?, ?, ?, ?)`,
  ).run(
    "card-progress",
    "Long running task",
    "agent-2",
    now - 9 * 60 * 60 * 1000,
    now,
    now,
  );

  const result = enforceKanbanTimeouts(db);
  assert.equal(result.timedOutRequested.length, 1);
  assert.equal(result.stalledInProgress.length, 1);

  const requested = db.prepare(
    "SELECT status, blocked_reason, metadata_json FROM kanban_cards WHERE id = ?",
  ).get("card-requested") as { status: string; blocked_reason: string | null; metadata_json: string | null };
  assert.equal(requested.status, "failed");
  assert.match(requested.blocked_reason ?? "", /Timed out/);
  assert.equal(parseKanbanCardMetadata(requested.metadata_json).timed_out_stage, "requested");

  const dispatch = db.prepare(
    "SELECT status, result_summary FROM task_dispatches WHERE id = ?",
  ).get("dispatch-1") as { status: string; result_summary: string | null };
  assert.equal(dispatch.status, "failed");
  assert.match(dispatch.result_summary ?? "", /Timed out/);

  const inProgress = db.prepare(
    "SELECT status, blocked_reason, metadata_json FROM kanban_cards WHERE id = ?",
  ).get("card-progress") as { status: string; blocked_reason: string | null; metadata_json: string | null };
  assert.equal(inProgress.status, "blocked");
  assert.match(inProgress.blocked_reason ?? "", /No progress signal/);
  assert.equal(parseKanbanCardMetadata(inProgress.metadata_json).timed_out_stage, "in_progress");
});

test("syncKanbanCardWithDispatch ignores non-agent participants when auto-creating child cards", () => {
  const db = createDb();
  seedAgent(db, "agent-parent");
  seedAgent(db, "agent-worker");

  const now = Date.now();
  db.prepare(
    `INSERT INTO task_dispatches (
      id, from_agent_id, to_agent_id, dispatch_type, status, title, created_at, dispatched_at
    )
    VALUES (?, ?, ?, 'generic', 'dispatched', ?, ?, ?)`,
  ).run("dispatch-parent", "agent-parent", "agent-worker", "Parent work", now, now);

  db.prepare(
    `INSERT INTO kanban_cards (
      id, title, status, github_repo, owner_agent_id, requester_agent_id, assignee_agent_id,
      latest_dispatch_id, priority, depth, sort_order, created_at, updated_at
    )
    VALUES (?, ?, 'requested', ?, ?, ?, ?, ?, 'medium', 0, 1024, ?, ?)`,
  ).run(
    "card-parent",
    "Parent work",
    "itismyfield/PixelClawDashboard",
    "agent-parent",
    "agent-parent",
    "agent-worker",
    "dispatch-parent",
    now,
    now,
  );

  db.prepare(
    `INSERT INTO task_dispatches (
      id, from_agent_id, to_agent_id, dispatch_type, status, title, parent_dispatch_id, chain_depth, created_at, dispatched_at
    )
    VALUES (?, ?, ?, 'generic', 'dispatched', ?, ?, 1, ?, ?)`,
  ).run("dispatch-child", "external-requester", "external-worker", "Follow-up work", "dispatch-parent", now, now);

  assert.doesNotThrow(() => {
    syncKanbanCardWithDispatch(db, "dispatch-child");
  });

  const child = db.prepare(
    `SELECT owner_agent_id, requester_agent_id, assignee_agent_id, parent_card_id
     FROM kanban_cards
     WHERE latest_dispatch_id = ?`,
  ).get("dispatch-child") as {
    owner_agent_id: string | null;
    requester_agent_id: string | null;
    assignee_agent_id: string | null;
    parent_card_id: string | null;
  } | undefined;

  assert.ok(child);
  assert.equal(child.parent_card_id, "card-parent");
  assert.equal(child.owner_agent_id, null);
  assert.equal(child.requester_agent_id, null);
  assert.equal(child.assignee_agent_id, null);
});

test("syncKanbanCardWithDispatch clears invalid assignee ids instead of throwing", () => {
  const db = createDb();
  seedAgent(db, "agent-requester");
  seedAgent(db, "agent-assignee");

  const now = Date.now();
  db.prepare(
    `INSERT INTO task_dispatches (
      id, from_agent_id, to_agent_id, dispatch_type, status, title, created_at, dispatched_at
    )
    VALUES (?, ?, ?, 'generic', 'dispatched', ?, ?, ?)`,
  ).run("dispatch-update", "agent-requester", "external-worker", "Needs sync", now, now);

  db.prepare(
    `INSERT INTO kanban_cards (
      id, title, status, owner_agent_id, requester_agent_id, assignee_agent_id,
      latest_dispatch_id, priority, depth, sort_order, created_at, updated_at
    )
    VALUES (?, ?, 'requested', ?, ?, ?, ?, 'medium', 0, 1024, ?, ?)`,
  ).run(
    "card-update",
    "Needs sync",
    "agent-requester",
    "agent-requester",
    "agent-assignee",
    "dispatch-update",
    now,
    now,
  );

  assert.doesNotThrow(() => {
    syncKanbanCardWithDispatch(db, "dispatch-update");
  });

  const card = db.prepare(
    "SELECT assignee_agent_id FROM kanban_cards WHERE id = ?",
  ).get("card-update") as { assignee_agent_id: string | null } | undefined;
  assert.ok(card);
  assert.equal(card.assignee_agent_id, null);
});
