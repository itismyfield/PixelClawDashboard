/**
 * Dispatch input parser — separates UI display data from structured dispatch payloads.
 *
 * Follows PMD issue format spec (ch-issue-format-spec.md):
 * - Issue body is single source of truth (no triple-expression drift)
 * - `## 배경` → intent (why), `## 내용` → description (what)
 * - `## DoD` → checklist items (`- [ ]` task-list only)
 * - Checklist extracted ONLY from `## DoD` section (other `- [ ]` ignored)
 * - Token/item limits: ≤10 items AND ≤2k tokens; fallback to link+summary
 * - Parse failure → link+summary fallback, fetch 1x allowed
 */

// ── Constants ──

const MAX_CHECKLIST_ITEMS = 10;
const MAX_TOKEN_ESTIMATE = 2000;
/** Rough token estimate: ~4 chars per token for mixed CJK/English */
const CHARS_PER_TOKEN = 4;

// ── Types ──

export interface ChecklistItem {
  /** Raw text of the checklist item (markdown stripped) */
  text: string;
  /** Whether already completed */
  done: boolean;
}

export interface DispatchInput {
  /** One-line intent summary */
  intent: string;
  /** Structured checklist items extracted from issue body */
  checklist: ChecklistItem[];
  /** GitHub issue URL as canonical source of truth */
  issue_url: string | null;
  /** GitHub repo (owner/name) */
  repo: string | null;
  /** GitHub issue number */
  issue_number: number | null;
  /** Whether the input was truncated/fell back due to limits */
  truncated: boolean;
  /** Parse failure reason if fallback was used */
  fallback_reason: string | null;
}

export interface DispatchPayload {
  /** For display in dispatch title */
  title: string;
  /** Structured input for the agent */
  input: DispatchInput;
  /** Full description for UI display only (not sent to agent) */
  ui_description: string | null;
}

// ── Parsing ──

const CHECKLIST_RE = /^[\s]*-\s*\[([xX ])\]\s*(.+)$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Parse a GitHub issue body into structured dispatch input.
 */
export function parseIssueBody(
  body: string | null | undefined,
  opts: {
    issue_url?: string | null;
    repo?: string | null;
    issue_number?: number | null;
  } = {},
): DispatchInput {
  const base: DispatchInput = {
    intent: "",
    checklist: [],
    issue_url: opts.issue_url ?? null,
    repo: opts.repo ?? null,
    issue_number: opts.issue_number ?? null,
    truncated: false,
    fallback_reason: null,
  };

  if (!body || body.trim().length === 0) {
    base.fallback_reason = "empty_body";
    return base;
  }

  try {
    return doParse(body, base);
  } catch {
    base.fallback_reason = "parse_error";
    base.intent = extractFirstLine(body);
    return base;
  }
}

/**
 * Split issue body into named sections keyed by H2 heading.
 * Lines before the first heading go into key "".
 */
function splitSections(body: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "";
  sections.set(current, []);

  for (const line of body.split("\n")) {
    const match = line.match(HEADING_RE);
    if (match && match[1] === "##") {
      current = match[2].trim();
      if (!sections.has(current)) sections.set(current, []);
    } else {
      sections.get(current)!.push(line);
    }
  }
  return sections;
}

function doParse(body: string, base: DispatchInput): DispatchInput {
  const sections = splitSections(body);

  // Extract intent from ## 배경 section (first non-empty line)
  const bgLines = sections.get("배경") ?? [];
  let intent = "";
  for (const line of bgLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!CHECKLIST_RE.test(line)) {
      intent = trimmed;
      break;
    }
  }

  // Fallback: first descriptive line anywhere
  if (!intent) {
    for (const [, sectionLines] of sections) {
      for (const line of sectionLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (HEADING_RE.test(trimmed)) continue;
        if (!CHECKLIST_RE.test(line)) {
          intent = trimmed;
          break;
        }
      }
      if (intent) break;
    }
  }
  if (!intent) intent = extractFirstLine(body);
  base.intent = intent;

  // Extract checklist ONLY from ## DoD section
  const dodLines = sections.get("DoD") ?? [];
  const checklist: ChecklistItem[] = [];
  for (const line of dodLines) {
    const match = line.match(CHECKLIST_RE);
    if (match) {
      checklist.push({
        text: match[2].trim(),
        done: match[1].toLowerCase() === "x",
      });
    }
  }

  // Fallback: if no DoD section, try legacy whole-body scan
  if (checklist.length === 0) {
    for (const line of body.split("\n")) {
      const match = line.match(CHECKLIST_RE);
      if (match) {
        checklist.push({
          text: match[2].trim(),
          done: match[1].toLowerCase() === "x",
        });
      }
    }
    if (checklist.length > 0) {
      base.fallback_reason = "no_dod_section";
    }
  }

  // Apply limits
  const { items, truncated, reason } = applyLimits(checklist);
  base.checklist = items;
  base.truncated = truncated;
  if (reason) {
    base.fallback_reason = base.fallback_reason
      ? `${base.fallback_reason};${reason}`
      : reason;
  }

  return base;
}

function extractFirstLine(text: string): string {
  const first = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = first.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

// ── Limits ──

function estimateTokens(items: ChecklistItem[]): number {
  const totalChars = items.reduce((sum, item) => sum + item.text.length, 0);
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

function applyLimits(items: ChecklistItem[]): {
  items: ChecklistItem[];
  truncated: boolean;
  reason: string | null;
} {
  if (items.length === 0) {
    return { items, truncated: false, reason: null };
  }

  // Check item count
  let result = items;
  let truncated = false;
  let reason: string | null = null;

  if (result.length > MAX_CHECKLIST_ITEMS) {
    result = result.slice(0, MAX_CHECKLIST_ITEMS);
    truncated = true;
    reason = `items_exceeded:${items.length}>${MAX_CHECKLIST_ITEMS}`;
  }

  // Check token estimate
  const tokens = estimateTokens(result);
  if (tokens > MAX_TOKEN_ESTIMATE) {
    // Progressively trim until under limit
    while (result.length > 1 && estimateTokens(result) > MAX_TOKEN_ESTIMATE) {
      result = result.slice(0, -1);
    }
    // If single item still exceeds, truncate its text
    if (result.length === 1 && estimateTokens(result) > MAX_TOKEN_ESTIMATE) {
      const maxChars = MAX_TOKEN_ESTIMATE * CHARS_PER_TOKEN;
      result[0] = { ...result[0], text: `${result[0].text.slice(0, maxChars - 3)}...` };
    }
    truncated = true;
    reason = reason
      ? `${reason};tokens_exceeded:${tokens}>${MAX_TOKEN_ESTIMATE}`
      : `tokens_exceeded:${tokens}>${MAX_TOKEN_ESTIMATE}`;
  }

  return { items: result, truncated, reason };
}

// ── Dispatch payload builder ──

/**
 * Build a structured dispatch payload from a kanban card's data.
 * This is the single function that creates the separation between
 * UI display and dispatch input.
 */
export function buildDispatchPayload(card: {
  title: string;
  description: string | null;
  github_issue_url: string | null;
  github_repo: string | null;
  github_issue_number: number | null;
}): DispatchPayload {
  const input = parseIssueBody(card.description, {
    issue_url: card.github_issue_url,
    repo: card.github_repo,
    issue_number: card.github_issue_number,
  });

  return {
    title: card.title,
    input,
    ui_description: card.description,
  };
}

/**
 * Convert DispatchInput into the `instructions` string for the handoff JSON.
 * This is the structured format agents receive.
 */
export function formatInstructionsFromInput(input: DispatchInput): string {
  const parts: string[] = [];

  if (input.intent) {
    parts.push(`## Intent\n${input.intent}`);
  }

  if (input.checklist.length > 0) {
    parts.push("## Checklist");
    for (const item of input.checklist) {
      parts.push(`- [${item.done ? "x" : " "}] ${item.text}`);
    }
  }

  if (input.issue_url) {
    parts.push(`## Source\n${input.issue_url}`);
  }

  if (input.truncated && input.issue_url) {
    parts.push(
      `> Note: Checklist was truncated (${input.fallback_reason}). See full issue at ${input.issue_url}`,
    );
  }

  return parts.join("\n\n");
}
