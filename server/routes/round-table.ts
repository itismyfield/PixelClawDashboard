import { Router } from "express";
import { execFileSync } from "node:child_process";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";
import { sendDiscordMessage } from "../discord-announce.js";
import { appendAuditLog, getAuditActor } from "../audit-log.js";
import {
  getPendingIssues,
  mergeIssueCreationResults,
  normalizeIssueCreationResults,
  parseIssueCreationResults,
  parseProposedIssues,
  proposedIssueKey,
  summarizeIssueCreation,
  type IssueCreationRecord,
  type ProposedIssue,
} from "../round-table-logic.js";

const router = Router();

function formatExecError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const stderr = Reflect.get(error, "stderr");
    if (stderr) {
      const text = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr);
      if (text.trim()) return text.trim();
    }
  }
  return error instanceof Error ? error.message : "command failed";
}

function parseIssueResultsColumn(
  row: Record<string, unknown>,
  proposedIssues: ProposedIssue[],
): IssueCreationRecord[] {
  return normalizeIssueCreationResults(
    proposedIssues,
    parseIssueCreationResults(
      typeof row.issue_creation_results === "string"
        ? row.issue_creation_results
        : null,
    ),
    Number(row.issues_created || 0),
  );
}

function parseJsonColumn<T>(
  meetingId: string,
  label: string,
  raw: unknown,
  fallback: T,
): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`[round-table] Invalid ${label} JSON for meeting ${meetingId}:`, error);
    return fallback;
  }
}

function parseProposedIssuesColumn(
  row: Record<string, unknown>,
): ProposedIssue[] {
  const meetingId = typeof row.id === "string" ? row.id : "unknown";
  const proposed = parseJsonColumn<unknown>(
    meetingId,
    "proposed_issues",
    row.proposed_issues,
    null,
  );
  return Array.isArray(proposed) ? proposed as ProposedIssue[] : [];
}

function deriveProposedIssuesFromSummary(
  row: Record<string, unknown>,
): ProposedIssue[] {
  const agenda = typeof row.agenda === "string" ? row.agenda : "";
  const meetingId = typeof row.id === "string" ? row.id : "";
  const summary = typeof row.summary === "string" ? row.summary : "";

  if (!agenda || !meetingId || !summary.trim()) return [];

  return parseProposedIssues(agenda, meetingId, [
    { content: summary, is_summary: true },
  ]);
}

function resolveProposedIssues(
  row: Record<string, unknown>,
): ProposedIssue[] {
  const stored = parseProposedIssuesColumn(row);
  if (stored.length > 0) return stored;
  return deriveProposedIssuesFromSummary(row);
}

function normalizeRepoValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractIssueUrl(output: Buffer | string | null | undefined): string | null {
  if (!output) return null;
  const text = Buffer.isBuffer(output) ? output.toString("utf-8") : output;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^https?:\/\//.test(lines[i])) return lines[i];
  }
  return null;
}

function serializeIssueResults(results: IssueCreationRecord[]): string | null {
  return results.length > 0 ? JSON.stringify(results) : null;
}

function isDiscardableIssueResult(result: IssueCreationRecord | undefined): boolean {
  if (!result) return true;
  if (result.discarded === true) return false;
  return result.ok !== true;
}

function createDiscardResult(issue: ProposedIssue, key: string, attemptedAt: number): IssueCreationRecord {
  return {
    key,
    title: issue.title,
    assignee: issue.assignee,
    ok: false,
    discarded: true,
    error: null,
    issue_url: null,
    attempted_at: attemptedAt,
  };
}

function toMeetingRow(row: Record<string, unknown>): Record<string, unknown> {
  const meetingId = typeof row.id === "string" ? row.id : "unknown";
  const proposedIssues = resolveProposedIssues(row);
  const issueCreationResults = parseIssueResultsColumn(row, proposedIssues);
  const issueSummary = summarizeIssueCreation(proposedIssues, issueCreationResults);
  const participantNames = parseJsonColumn<unknown>(
    meetingId,
    "participant_names",
    row.participant_names,
    [],
  );
  return {
    ...row,
    issue_repo: normalizeRepoValue(row.issue_repo),
    participant_names: Array.isArray(participantNames) ? participantNames : [],
    proposed_issues: proposedIssues,
    issues_created: issueSummary.created,
    issue_creation_results: issueCreationResults,
  };
}

// List round-table meetings (newest first)
router.get("/api/round-table-meetings", (req, res) => {
  const db = getDb();
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const offset = Number(req.query.offset) || 0;

  const rows = db
    .prepare(
      `SELECT * FROM round_table_meetings ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Array<Record<string, unknown>>;

  const meetings = rows.map((r) => ({
    ...toMeetingRow(r),
  }));

  res.json({ meetings });
});

// Get single meeting with entries
router.get("/api/round-table-meetings/:id", (req, res) => {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM round_table_meetings WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!row) return res.status(404).json({ error: "not_found" });

  const entries = db
    .prepare(
      "SELECT * FROM round_table_entries WHERE meeting_id = ? ORDER BY seq ASC",
    )
    .all(req.params.id);

  res.json({
    ...toMeetingRow(row),
    entries,
  });
});

router.patch("/api/round-table-meetings/:id/issue-repo", (req, res) => {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM round_table_meetings WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!row) return res.status(404).json({ error: "not_found" });

  const issueRepo = normalizeRepoValue(req.body.repo);
  db.prepare("UPDATE round_table_meetings SET issue_repo = ? WHERE id = ?").run(
    issueRepo,
    req.params.id,
  );

  const updatedRow = db
    .prepare("SELECT * FROM round_table_meetings WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!updatedRow) return res.status(404).json({ error: "not_found" });

  const meeting = toMeetingRow(updatedRow);
  broadcast("round_table_update", meeting);
  res.json({ ok: true, meeting });
});

// Create meeting (called by RemoteCC)
router.post("/api/round-table-meetings", (req, res) => {
  const db = getDb();
  const {
    id,
    agenda,
    summary,
    status,
    primary_provider,
    reviewer_provider,
    participant_names,
    total_rounds,
    started_at,
    completed_at,
    entries,
    proposed_issues,
  } = req.body;

  if (!id || !agenda) {
    return res.status(400).json({ error: "id and agenda required" });
  }

  // If proposed_issues are missing or empty, auto-parse from entries/summary.
  let issues = proposed_issues as ProposedIssue[] | null;
  if (!issues || issues.length === 0) {
    const parsedFromEntries =
      Array.isArray(entries) && entries.length > 0
        ? parseProposedIssues(agenda, id, entries)
        : [];
    const parsedFromSummary =
      parsedFromEntries.length === 0 && typeof summary === "string" && summary.trim()
        ? parseProposedIssues(agenda, id, [{ content: summary, is_summary: true }])
        : [];
    const parsed = parsedFromEntries.length > 0 ? parsedFromEntries : parsedFromSummary;
    if (parsed.length > 0) issues = parsed;
  }

  const existing = db
    .prepare("SELECT issues_created, issue_creation_results FROM round_table_meetings WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  const existingIssueResults = existing && issues ? parseIssueResultsColumn(existing, issues) : [];
  const prunedIssueResults = issues ? mergeIssueCreationResults(issues, existingIssueResults, []) : [];
  const issueSummary = summarizeIssueCreation(issues ?? [], prunedIssueResults);

  db.prepare(
    `INSERT INTO round_table_meetings
       (id, agenda, summary, status, primary_provider, reviewer_provider, participant_names, total_rounds, started_at, completed_at, proposed_issues, issues_created, issue_creation_results)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       agenda = excluded.agenda,
       summary = excluded.summary,
       status = excluded.status,
       primary_provider = excluded.primary_provider,
       reviewer_provider = excluded.reviewer_provider,
       participant_names = excluded.participant_names,
       total_rounds = excluded.total_rounds,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       proposed_issues = excluded.proposed_issues,
       issues_created = excluded.issues_created,
       issue_creation_results = excluded.issue_creation_results`,
  ).run(
    id,
    agenda,
    summary || null,
    status || "completed",
    primary_provider || null,
    reviewer_provider || null,
    JSON.stringify(participant_names || []),
    total_rounds || 0,
    started_at || Date.now(),
    completed_at || null,
    issues ? JSON.stringify(issues) : null,
    issueSummary.created,
    serializeIssueResults(prunedIssueResults),
  );

  if (Array.isArray(entries) && entries.length > 0) {
    // Clear existing entries for idempotent re-POST
    db.prepare("DELETE FROM round_table_entries WHERE meeting_id = ?").run(id);

    const ins = db.prepare(
      `INSERT INTO round_table_entries
         (meeting_id, seq, round, speaker_role_id, speaker_name, content, is_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entries) {
      ins.run(
        id,
        e.seq,
        e.round,
        e.speaker_role_id || null,
        e.speaker_name,
        e.content,
        e.is_summary ? 1 : 0,
      );
    }
  }

  const meeting = {
    id,
    agenda,
    summary: summary || null,
    status: status || "completed",
    primary_provider: primary_provider || null,
    reviewer_provider: reviewer_provider || null,
    participant_names: participant_names || [],
    total_rounds: total_rounds || 0,
    issues_created: issueSummary.created,
    proposed_issues: issues || null,
    issue_creation_results: prunedIssueResults,
    started_at: started_at || Date.now(),
    completed_at: completed_at || null,
  };

  broadcast(existing ? "round_table_update" : "round_table_new", meeting);
  res.json(meeting);
});

// Delete meeting
router.delete("/api/round-table-meetings/:id", (req, res) => {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM round_table_meetings WHERE id = ?")
    .get(req.params.id);

  if (!row) return res.status(404).json({ error: "not_found" });

  db.prepare("DELETE FROM round_table_entries WHERE meeting_id = ?").run(
    req.params.id,
  );
  db.prepare("DELETE FROM round_table_meetings WHERE id = ?").run(
    req.params.id,
  );

  broadcast("round_table_update", { id: req.params.id, deleted: true });
  res.json({ ok: true });
});

// Create GitHub issues from proposed_issues
router.post("/api/round-table-meetings/:id/issues", (req, res) => {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM round_table_meetings WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!row) return res.status(404).json({ error: "not_found" });

  const requestedRepo = normalizeRepoValue(req.body.repo);
  const repo = requestedRepo || normalizeRepoValue(row.issue_repo);
  const agenda = row.agenda as string;
  const proposed = resolveProposedIssues(row);

  if (!repo) {
    return res.status(400).json({ error: "repo_required" });
  }

  if (proposed.length === 0) {
    return res.status(400).json({ error: "no_proposed_issues" });
  }

  if (requestedRepo) {
    db.prepare("UPDATE round_table_meetings SET issue_repo = ? WHERE id = ?").run(
      requestedRepo,
      req.params.id,
    );
  }

  const existingResults = parseIssueResultsColumn(row, proposed);
  const pendingIssues = getPendingIssues(proposed, existingResults);
  if (pendingIssues.length === 0) {
    const mergedResults = mergeIssueCreationResults(proposed, existingResults, []);
    const summary = summarizeIssueCreation(proposed, mergedResults);
    return res.json({ ok: summary.all_created, results: mergedResults, summary, skipped: true });
  }

  const results: IssueCreationRecord[] = [];

  for (const issue of pendingIssues) {
    const title = `[RT] ${issue.title.slice(0, 80)}`;
    const body = `${issue.body}\n\n---\n_라운드 테이블: ${agenda}_`;
    const attemptedAt = Date.now();
    try {
      const stdout = execFileSync(
        "gh",
        ["issue", "create", "--repo", repo, "--title", title, "--body", body],
        { timeout: 15000, stdio: "pipe" },
      );
      results.push({
        key: proposedIssueKey(issue),
        title: issue.title,
        assignee: issue.assignee,
        ok: true,
        error: null,
        issue_url: extractIssueUrl(stdout),
        attempted_at: attemptedAt,
      });
    } catch (e: unknown) {
      results.push({
        key: proposedIssueKey(issue),
        title: issue.title,
        assignee: issue.assignee,
        ok: false,
        error: formatExecError(e),
        issue_url: null,
        attempted_at: attemptedAt,
      });
    }
  }

  const mergedResults = mergeIssueCreationResults(proposed, existingResults, results);
  const summary = summarizeIssueCreation(proposed, mergedResults);
  db.prepare(
    "UPDATE round_table_meetings SET issues_created = ?, issue_creation_results = ? WHERE id = ?",
  ).run(summary.created, serializeIssueResults(mergedResults), req.params.id);

  broadcast("round_table_update", {
    id: req.params.id,
    issue_repo: requestedRepo || normalizeRepoValue(row.issue_repo),
    issues_created: summary.created,
    issue_creation_results: mergedResults,
  });
  res.json({ ok: summary.all_created, results: mergedResults, summary, skipped: false });
});

router.post("/api/round-table-meetings/:id/issues/discard", (req, res) => {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM round_table_meetings WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!row) return res.status(404).json({ error: "not_found" });

  const issueKey = typeof req.body.key === "string" ? req.body.key.trim() : "";
  if (!issueKey) {
    return res.status(400).json({ error: "issue_key_required" });
  }

  const proposed = resolveProposedIssues(row);
  if (proposed.length === 0) {
    return res.status(400).json({ error: "no_proposed_issues" });
  }

  const targetIssue = proposed.find((issue) => proposedIssueKey(issue) === issueKey);
  if (!targetIssue) {
    return res.status(404).json({ error: "issue_not_found" });
  }

  const existingResults = parseIssueResultsColumn(row, proposed);
  const existingResult = existingResults.find((result) => result.key === issueKey);

  if (!isDiscardableIssueResult(existingResult)) {
    return res.status(409).json({ error: "issue_already_created" });
  }

  const discardResult = createDiscardResult(targetIssue, issueKey, Date.now());

  const mergedResults = mergeIssueCreationResults(proposed, existingResults, [discardResult]);
  const summary = summarizeIssueCreation(proposed, mergedResults);

  db.prepare(
    "UPDATE round_table_meetings SET issues_created = ?, issue_creation_results = ? WHERE id = ?",
  ).run(summary.created, serializeIssueResults(mergedResults), req.params.id);

  const updatedRow = db
    .prepare("SELECT * FROM round_table_meetings WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!updatedRow) return res.status(404).json({ error: "not_found" });

  const meeting = toMeetingRow(updatedRow);

  appendAuditLog({
    actor: getAuditActor(req),
    action: "meeting.issue_discarded",
    entityType: "round_table_meeting",
    entityId: req.params.id,
    summary: `Round table issue discarded: ${targetIssue.title}`,
    metadata: {
      key: issueKey,
      title: targetIssue.title,
      assignee: targetIssue.assignee,
    },
  });

  broadcast("round_table_update", meeting);
  res.json({ ok: true, meeting, result: discardResult, summary });
});

router.post("/api/round-table-meetings/:id/issues/discard-all", (req, res) => {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM round_table_meetings WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!row) return res.status(404).json({ error: "not_found" });

  const proposed = resolveProposedIssues(row);
  if (proposed.length === 0) {
    return res.status(400).json({ error: "no_proposed_issues" });
  }

  const existingResults = parseIssueResultsColumn(row, proposed);
  const discardableIssues = proposed.filter((issue) => {
    const issueKey = proposedIssueKey(issue);
    const existingResult = existingResults.find((result) => result.key === issueKey);
    return isDiscardableIssueResult(existingResult);
  });

  if (discardableIssues.length === 0) {
    const meeting = toMeetingRow(row);
    const summary = summarizeIssueCreation(proposed, existingResults);
    return res.json({ ok: true, meeting, results: [], summary, skipped: true });
  }

  const attemptedAt = Date.now();
  const discardResults = discardableIssues.map((issue) =>
    createDiscardResult(issue, proposedIssueKey(issue), attemptedAt),
  );
  const mergedResults = mergeIssueCreationResults(proposed, existingResults, discardResults);
  const summary = summarizeIssueCreation(proposed, mergedResults);

  db.prepare(
    "UPDATE round_table_meetings SET issues_created = ?, issue_creation_results = ? WHERE id = ?",
  ).run(summary.created, serializeIssueResults(mergedResults), req.params.id);

  const updatedRow = db
    .prepare("SELECT * FROM round_table_meetings WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!updatedRow) return res.status(404).json({ error: "not_found" });

  const meeting = toMeetingRow(updatedRow);

  appendAuditLog({
    actor: getAuditActor(req),
    action: "meeting.issues_discarded",
    entityType: "round_table_meeting",
    entityId: req.params.id,
    summary: `Round table issues discarded: ${discardResults.length}`,
    metadata: {
      discarded_count: discardResults.length,
      discarded_titles: discardResults.map((result) => result.title),
    },
  });

  broadcast("round_table_update", meeting);
  res.json({ ok: true, meeting, results: discardResults, summary });
});

// Start a meeting via Discord (sends /meeting start command to configured channel)
router.post("/api/round-table-meetings/start", async (req, res) => {
  const { agenda, channel_id, primary_provider } = req.body;

  if (!agenda || !agenda.trim()) {
    return res.status(400).json({ error: "agenda required" });
  }
  if (!channel_id || !channel_id.trim()) {
    return res.status(400).json({ error: "channel_id required" });
  }

  const providerPart =
    typeof primary_provider === "string" && primary_provider.trim()
      ? ` --primary ${primary_provider.trim()}`
      : "";
  const ok = await sendDiscordMessage(channel_id.trim(), `/meeting start${providerPart} ${agenda.trim()}`);

  if (!ok) {
    return res.status(500).json({ error: "Failed to send Discord message" });
  }

  res.json({ ok: true });
});

export default router;
