import test from "node:test";
import assert from "node:assert/strict";
import {
  collectConfiguredAgents,
  getIdleAgentIdsFromWorkingRows,
  inferDisplayEmoji,
  inferDisplayName,
} from "./agent-sync.js";

test("inferDisplayName normalizes channel and legacy agent ids", () => {
  assert.equal(inferDisplayName("ch-td"), "TD");
  assert.equal(inferDisplayName("personal-yobiseo"), "personal-yobiseo");
  assert.equal(inferDisplayName("project-scheduler"), "project-scheduler");
});

test("collectConfiguredAgents deduplicates role bindings and skips blank ids", () => {
  const configured = collectConfiguredAgents([
    { roleId: "ch-td" },
    { roleId: "ch-td" },
    { roleId: "project-scheduler" },
    { roleId: "" },
    {},
  ]);

  assert.deepEqual(configured, [
    { id: "ch-td", name: "TD", emoji: "⚙️" },
    { id: "project-scheduler", name: "project-scheduler", emoji: "🗓️" },
  ]);
});

test("inferDisplayEmoji assigns name-appropriate defaults for synced agents", () => {
  assert.equal(inferDisplayEmoji("project-pixelclawdashboard"), "🐾");
  assert.equal(inferDisplayEmoji("project-remotecc"), "📡");
  assert.equal(inferDisplayEmoji("project-agentfactory"), "🏭");
  assert.equal(inferDisplayEmoji("family-counsel"), "💚");
  assert.equal(inferDisplayEmoji("unknown-agent"), "🙂");
});

test("getIdleAgentIdsFromWorkingRows selects only agents without remotecc work", () => {
  const idleIds = getIdleAgentIdsFromWorkingRows([
    { id: "a", status: "working", remotecc_working_count: 0 },
    { id: "b", status: "working", remotecc_working_count: 2 },
    { id: "c", status: "working", remotecc_working_count: 0 },
  ]);

  assert.deepEqual(idleIds, ["a", "c"]);
});
