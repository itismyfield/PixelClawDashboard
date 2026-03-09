export interface ProposedIssue {
  title: string;
  body: string;
  assignee: string;
}

export interface IssueCreationRecord {
  key: string;
  title: string;
  assignee: string;
  ok: boolean;
  discarded?: boolean;
  error?: string | null;
  issue_url?: string | null;
  attempted_at: number;
}

export interface IssueCreationSummary {
  total: number;
  created: number;
  failed: number;
  discarded: number;
  pending: number;
  all_created: boolean;
  all_resolved: boolean;
}

export function parseProposedIssues(
  agenda: string,
  meetingId: string,
  entries: Array<{ content: string; is_summary: number | boolean }>,
): ProposedIssue[] {
  const issues: ProposedIssue[] = [];
  const summaryEntries = entries.filter((e) => e.is_summary);
  const sources = summaryEntries.length > 0 ? summaryEntries : entries;

  for (const entry of sources) {
    const lines = (entry.content || "").split("\n");
    for (const line of lines) {
      const match = line.match(
        /^-\s*\[[ x]\]\s*\*\*(.+?)\*\*\s*[—–:\-]\s*(.+)$/,
      );
      if (!match) continue;

      const assignee = match[1].trim();
      const description = match[2].trim();
      issues.push({
        title: description,
        body: `**담당**: ${assignee}\n**안건**: ${agenda}\n**회의**: ${meetingId}`,
        assignee,
      });
    }
  }

  return issues;
}

export function proposedIssueKey(issue: ProposedIssue): string {
  return JSON.stringify([
    issue.title.trim(),
    issue.body.trim(),
    issue.assignee.trim(),
  ]);
}

export function parseIssueCreationResults(
  raw: string | null | undefined,
): IssueCreationRecord[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => {
        const title = typeof item.title === "string" ? item.title : "";
        const assignee = typeof item.assignee === "string" ? item.assignee : "";
        const key =
          typeof item.key === "string" && item.key.length > 0
            ? item.key
            : proposedIssueKey({
                title,
                body: typeof item.body === "string" ? item.body : "",
                assignee,
              });

        return {
          key,
          title,
          assignee,
          ok: item.ok === true,
          discarded: item.discarded === true,
          error: typeof item.error === "string" ? item.error : null,
          issue_url: typeof item.issue_url === "string" ? item.issue_url : null,
          attempted_at:
            typeof item.attempted_at === "number" ? item.attempted_at : 0,
        };
      })
      .filter((item) => item.key.length > 0 && item.title.length > 0);
  } catch {
    return [];
  }
}

export function pruneIssueCreationResults(
  proposedIssues: ProposedIssue[],
  results: IssueCreationRecord[],
): IssueCreationRecord[] {
  const allowedKeys = new Set(proposedIssues.map(proposedIssueKey));
  const latestByKey = new Map<string, IssueCreationRecord>();

  for (const result of results) {
    if (!allowedKeys.has(result.key)) continue;
    latestByKey.set(result.key, result);
  }

  return proposedIssues
    .map((issue) => latestByKey.get(proposedIssueKey(issue)))
    .filter((result): result is IssueCreationRecord => Boolean(result));
}

export function normalizeIssueCreationResults(
  proposedIssues: ProposedIssue[],
  results: IssueCreationRecord[],
  legacyIssuesCreatedCount = 0,
): IssueCreationRecord[] {
  const pruned = pruneIssueCreationResults(proposedIssues, results);
  if (pruned.length > 0 || proposedIssues.length === 0 || legacyIssuesCreatedCount <= 0) {
    return pruned;
  }

  // Legacy rows only tracked a boolean-ish `issues_created` flag.
  // Prefer treating them as completed to avoid duplicate GitHub issues.
  return proposedIssues.map((issue) => ({
    key: proposedIssueKey(issue),
    title: issue.title,
    assignee: issue.assignee,
    ok: true,
    discarded: false,
    error: null,
    issue_url: null,
    attempted_at: 0,
  }));
}

export function getPendingIssues(
  proposedIssues: ProposedIssue[],
  results: IssueCreationRecord[],
): ProposedIssue[] {
  const handledKeys = new Set(
    pruneIssueCreationResults(proposedIssues, results)
      .filter((result) => result.ok || result.discarded === true)
      .map((result) => result.key),
  );

  return proposedIssues.filter(
    (issue) => !handledKeys.has(proposedIssueKey(issue)),
  );
}

export function mergeIssueCreationResults(
  proposedIssues: ProposedIssue[],
  existingResults: IssueCreationRecord[],
  attemptResults: IssueCreationRecord[],
): IssueCreationRecord[] {
  const merged = new Map<string, IssueCreationRecord>();

  for (const result of pruneIssueCreationResults(proposedIssues, existingResults)) {
    merged.set(result.key, result);
  }
  for (const result of attemptResults) {
    merged.set(result.key, result);
  }

  return proposedIssues
    .map((issue) => merged.get(proposedIssueKey(issue)))
    .filter((result): result is IssueCreationRecord => Boolean(result));
}

export function summarizeIssueCreation(
  proposedIssues: ProposedIssue[],
  results: IssueCreationRecord[],
): IssueCreationSummary {
  const relevant = pruneIssueCreationResults(proposedIssues, results);
  const created = relevant.filter((result) => result.ok && result.discarded !== true).length;
  const failed = relevant.filter((result) => !result.ok && result.discarded !== true).length;
  const discarded = relevant.filter((result) => result.discarded === true).length;
  const total = proposedIssues.length;
  const pending = Math.max(total - created - failed - discarded, 0);

  return {
    total,
    created,
    failed,
    discarded,
    pending,
    all_created: total > 0 && created === total,
    all_resolved: total > 0 && pending === 0 && failed === 0,
  };
}
