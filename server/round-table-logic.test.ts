import test from "node:test";
import assert from "node:assert/strict";

import {
  getPendingIssues,
  mergeIssueCreationResults,
  normalizeIssueCreationResults,
  parseIssueCreationResults,
  parseProposedIssues,
  proposedIssueKey,
  pruneIssueCreationResults,
  summarizeIssueCreation,
  type IssueCreationRecord,
  type ProposedIssue,
} from "./round-table-logic.js";

function sampleIssues(): ProposedIssue[] {
  return [
    {
      title: "첫 번째 작업",
      body: "**담당**: TD\n**안건**: 안건\n**회의**: mtg-1",
      assignee: "TD",
    },
    {
      title: "두 번째 작업",
      body: "**담당**: QAD\n**안건**: 안건\n**회의**: mtg-1",
      assignee: "QAD",
    },
  ];
}

test("parseProposedIssues extracts checkbox action items from summary lines", () => {
  const issues = parseProposedIssues("안건", "mtg-1", [
    {
      is_summary: true,
      content: [
        "- [ ] **TD** — 첫 번째 작업",
        "- [x] **QAD**: 두 번째 작업",
      ].join("\n"),
    },
  ]);

  assert.deepEqual(
    issues.map((issue) => ({
      title: issue.title,
      assignee: issue.assignee,
    })),
    [
      { title: "첫 번째 작업", assignee: "TD" },
      { title: "두 번째 작업", assignee: "QAD" },
    ],
  );
});

test("parseIssueCreationResults tolerates legacy rows without explicit keys", () => {
  const parsed = parseIssueCreationResults(
    JSON.stringify([
      {
        title: "첫 번째 작업",
        body: "**담당**: TD\n**안건**: 안건\n**회의**: mtg-1",
        assignee: "TD",
        ok: true,
        issue_url: "https://example.test/1",
      },
    ]),
  );

  assert.equal(parsed.length, 1);
  assert.equal(
    parsed[0].key,
    proposedIssueKey({
      title: "첫 번째 작업",
      body: "**담당**: TD\n**안건**: 안건\n**회의**: mtg-1",
      assignee: "TD",
    }),
  );
});

test("prune and summarize issue creation keep only current proposals", () => {
  const issues = sampleIssues();
  const staleKey = proposedIssueKey({
    title: "stale",
    body: "stale",
    assignee: "TD",
  });
  const results: IssueCreationRecord[] = [
    {
      key: proposedIssueKey(issues[0]),
      title: issues[0].title,
      assignee: issues[0].assignee,
      ok: true,
      issue_url: "https://example.test/1",
      attempted_at: 1,
    },
    {
      key: staleKey,
      title: "stale",
      assignee: "TD",
      ok: false,
      error: "old error",
      attempted_at: 2,
    },
  ];

  const pruned = pruneIssueCreationResults(issues, results);
  const summary = summarizeIssueCreation(issues, results);

  assert.equal(pruned.length, 1);
  assert.equal(summary.created, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.discarded, 0);
  assert.equal(summary.pending, 1);
});

test("getPendingIssues and mergeIssueCreationResults retry only failed items", () => {
  const issues = sampleIssues();
  const existing: IssueCreationRecord[] = [
    {
      key: proposedIssueKey(issues[0]),
      title: issues[0].title,
      assignee: issues[0].assignee,
      ok: true,
      issue_url: "https://example.test/1",
      attempted_at: 1,
    },
    {
      key: proposedIssueKey(issues[1]),
      title: issues[1].title,
      assignee: issues[1].assignee,
      ok: false,
      error: "gh failed",
      attempted_at: 2,
    },
  ];

  const pending = getPendingIssues(issues, existing);
  assert.deepEqual(pending.map((issue) => issue.title), ["두 번째 작업"]);

  const merged = mergeIssueCreationResults(issues, existing, [
    {
      key: proposedIssueKey(issues[1]),
      title: issues[1].title,
      assignee: issues[1].assignee,
      ok: true,
      issue_url: "https://example.test/2",
      attempted_at: 3,
    },
  ]);
  const summary = summarizeIssueCreation(issues, merged);

  assert.equal(summary.created, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.discarded, 0);
  assert.equal(summary.all_created, true);
  assert.equal(summary.all_resolved, true);
});

test("normalizeIssueCreationResults treats legacy created flag as completed", () => {
  const issues = sampleIssues();
  const normalized = normalizeIssueCreationResults(issues, [], 1);
  const summary = summarizeIssueCreation(issues, normalized);

  assert.equal(normalized.length, issues.length);
  assert.equal(summary.created, issues.length);
  assert.equal(summary.all_created, true);
  assert.equal(summary.all_resolved, true);
});

test("discarded issues are excluded from pending and counted separately", () => {
  const issues = sampleIssues();
  const results: IssueCreationRecord[] = [
    {
      key: proposedIssueKey(issues[0]),
      title: issues[0].title,
      assignee: issues[0].assignee,
      ok: true,
      discarded: false,
      issue_url: "https://example.test/1",
      attempted_at: 1,
    },
    {
      key: proposedIssueKey(issues[1]),
      title: issues[1].title,
      assignee: issues[1].assignee,
      ok: false,
      discarded: true,
      error: null,
      attempted_at: 2,
    },
  ];

  const pending = getPendingIssues(issues, results);
  const summary = summarizeIssueCreation(issues, results);

  assert.deepEqual(pending, []);
  assert.equal(summary.created, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.discarded, 1);
  assert.equal(summary.pending, 0);
  assert.equal(summary.all_created, false);
  assert.equal(summary.all_resolved, true);
});
