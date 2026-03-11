/**
 * Dispatch input parser — separates UI display data from structured dispatch payloads.
 *
 * Design principles (from PCD#3):
 * - UI description (issue body) is for display only
 * - Dispatch input is a structured checklist array + issue link
 * - Token/item limits: ≤10 items AND ≤2k tokens; fallback to link+summary
 * - Each item must include minimum context (intent + judgment criteria) inline
 * - Parse failure → link+summary fallback, fetch 1x allowed
 * - Single source of truth: issue body (no triple-expression drift)
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

const CHECKLIST_RE = /^[\s]*[-*]\s*\[([xX ])\]\s*(.+)$/;
const HEADING_RE = /^#{1,6}\s+(.+)$/;

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

function doParse(body: string, base: DispatchInput): DispatchInput {
  const lines = body.split("\n");
  const checklist: ChecklistItem[] = [];
  let intent = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Extract intent: skip headings, use first descriptive line
    if (!intent) {
      if (HEADING_RE.test(trimmed)) continue;
      if (!CHECKLIST_RE.test(line)) {
        intent = trimmed;
        continue;
      }
    }

    // Parse checklist items
    const match = line.match(CHECKLIST_RE);
    if (match) {
      checklist.push({
        text: match[2].trim(),
        done: match[1].toLowerCase() === "x",
      });
    }
  }

  // If no heading/line found for intent, use first checklist item
  if (!intent && checklist.length > 0) {
    intent = checklist[0].text;
  }
  if (!intent) {
    intent = extractFirstLine(body);
  }

  base.intent = intent;

  // Apply limits
  const { items, truncated, reason } = applyLimits(checklist);
  base.checklist = items;
  base.truncated = truncated;
  if (reason) base.fallback_reason = reason;

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
