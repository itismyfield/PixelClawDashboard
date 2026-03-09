import test from "node:test";
import assert from "node:assert/strict";
import { startXpSync, stopXpSync, syncXp, XP_SYNC_STARTED_MESSAGE } from "./xp-sync.js";

test("xp sync helpers are safe no-ops", () => {
  assert.doesNotThrow(() => syncXp());
  assert.doesNotThrow(() => stopXpSync());
});

test("startXpSync logs the hook-session mode banner", () => {
  const calls: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    calls.push(args.join(" "));
  };

  try {
    startXpSync();
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(calls, [XP_SYNC_STARTED_MESSAGE]);
});
