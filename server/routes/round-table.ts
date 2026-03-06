import { Router } from "express";
import { execSync } from "node:child_process";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";
import { sendDiscordMessage } from "../discord-announce.js";

const router = Router();

/** Parse action items from meeting entries/summary into structured proposed issues */
function parseProposedIssues(
  agenda: string,
  meetingId: string,
  entries: Array<{ content: string; is_summary: number | boolean }>,
): Array<{ title: string; body: string; assignee: string }> {
  const issues: Array<{ title: string; body: string; assignee: string }> = [];
  // Look for action item patterns in summary entries first, then all entries
  const summaryEntries = entries.filter((e) => e.is_summary);
  const sources = summaryEntries.length > 0 ? summaryEntries : entries;

  for (const entry of sources) {
    const lines = (entry.content || "").split("\n");
    for (const line of lines) {
      // Match: - [ ] **TD** — description  or  - [ ] **TD**: description
      const m = line.match(
        /^-\s*\[[ x]\]\s*\*\*(.+?)\*\*\s*[—–:\-]\s*(.+)$/,
      );
      if (m) {
        const assignee = m[1].trim();
        const desc = m[2].trim();
        issues.push({
          title: desc,
          body: `**담당**: ${assignee}\n**안건**: ${agenda}\n**회의**: ${meetingId}`,
          assignee,
        });
      }
    }
  }
  return issues;
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
    ...r,
    participant_names: JSON.parse((r.participant_names as string) || "[]"),
    proposed_issues: JSON.parse((r.proposed_issues as string) || "null"),
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
    ...row,
    participant_names: JSON.parse((row.participant_names as string) || "[]"),
    proposed_issues: JSON.parse((row.proposed_issues as string) || "null"),
    entries,
  });
});

// Create meeting (called by RemoteCC)
router.post("/api/round-table-meetings", (req, res) => {
  const db = getDb();
  const {
    id,
    agenda,
    summary,
    status,
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

  // If proposed_issues not provided, auto-parse from entries
  let issues = proposed_issues;
  if (!issues && Array.isArray(entries) && entries.length > 0) {
    const parsed = parseProposedIssues(agenda, id, entries);
    if (parsed.length > 0) issues = parsed;
  }

  db.prepare(
    `INSERT OR REPLACE INTO round_table_meetings
       (id, agenda, summary, status, participant_names, total_rounds, started_at, completed_at, proposed_issues)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    agenda,
    summary || null,
    status || "completed",
    JSON.stringify(participant_names || []),
    total_rounds || 0,
    started_at || Date.now(),
    completed_at || null,
    issues ? JSON.stringify(issues) : null,
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
    participant_names: participant_names || [],
    total_rounds: total_rounds || 0,
    issues_created: 0,
    proposed_issues: issues || null,
    started_at: started_at || Date.now(),
    completed_at: completed_at || null,
  };

  broadcast("round_table_new", meeting);
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
  if (row.issues_created === 1) {
    return res.status(409).json({ error: "issues_already_created" });
  }

  const repo = (req.body.repo as string) || "CookingHeart/CookingHeart";
  const agenda = row.agenda as string;
  const proposed = JSON.parse(
    (row.proposed_issues as string) || "null",
  ) as Array<{ title: string; body: string; assignee: string }> | null;

  if (!proposed || proposed.length === 0) {
    return res.status(400).json({ error: "no_proposed_issues" });
  }

  const results: Array<{ title: string; ok: boolean; error?: string }> = [];

  for (const issue of proposed) {
    const title = `[RT] ${issue.title.slice(0, 80)}`;
    const body = `${issue.body}\n\n---\n_라운드 테이블: ${agenda}_`;
    try {
      execSync(
        `gh issue create --repo "${repo}" --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`,
        { timeout: 15000, stdio: "pipe" },
      );
      results.push({ title, ok: true });
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "gh issue create failed";
      results.push({ title, ok: false, error: message });
    }
  }

  const allOk = results.every((r) => r.ok);
  if (allOk || results.some((r) => r.ok)) {
    db.prepare(
      "UPDATE round_table_meetings SET issues_created = 1 WHERE id = ?",
    ).run(req.params.id);
  }

  res.json({ ok: allOk, results });
});

// Start a meeting via Discord (sends /meeting start command to configured channel)
router.post("/api/round-table-meetings/start", async (req, res) => {
  const { agenda, channel_id } = req.body;

  if (!agenda || !agenda.trim()) {
    return res.status(400).json({ error: "agenda required" });
  }
  if (!channel_id || !channel_id.trim()) {
    return res.status(400).json({ error: "channel_id required" });
  }

  const ok = await sendDiscordMessage(
    channel_id.trim(),
    `/meeting start ${agenda.trim()}`,
  );

  if (!ok) {
    return res.status(500).json({ error: "Failed to send Discord message" });
  }

  res.json({ ok: true });
});

export default router;
