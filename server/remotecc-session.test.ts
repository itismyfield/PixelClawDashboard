import test from "node:test";
import assert from "node:assert/strict";
import { parseRemoteCcSessionKey } from "./remotecc-session.js";

test("parseRemoteCcSessionKey parses provider-aware Claude session names", () => {
  assert.deepEqual(
    parseRemoteCcSessionKey("mac-mini:remoteCC-claude-cookingheart-dev-cc"),
    {
      tmuxName: "remoteCC-claude-cookingheart-dev-cc",
      provider: "claude",
      channelName: "cookingheart-dev-cc",
    },
  );
});

test("parseRemoteCcSessionKey parses provider-aware Codex session names", () => {
  assert.deepEqual(
    parseRemoteCcSessionKey("mac-mini:remoteCC-codex-cookingheart-dev-cdx"),
    {
      tmuxName: "remoteCC-codex-cookingheart-dev-cdx",
      provider: "codex",
      channelName: "cookingheart-dev-cdx",
    },
  );
});

test("parseRemoteCcSessionKey keeps legacy session names as Claude", () => {
  assert.deepEqual(parseRemoteCcSessionKey("mac-mini:remoteCC-mac-mini"), {
    tmuxName: "remoteCC-mac-mini",
    provider: "claude",
    channelName: "mac-mini",
  });
});
