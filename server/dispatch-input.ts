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

// ── DoD verification classification (DD 합의 2026-03-11) ──

const AUTO_KEYWORDS = ["빌드", "컴파일", "테스트 통과", "에러 없음", "로그 확인", "실행", "크래시"];
const MANUAL_KEYWORDS = ["느낌", "재미", "감정선", "연출", "분위기", "톤", "몰입", "직관적", "사용성", "체감"];
const SEMI_KEYWORDS = ["성능", "프레임", "메모리", "수치 확인", "WP 계산", "비율", "밸런스 수치", "드로우콜"];

/** Edge cases: standalone keywords with special default classification */
const EDGE_CASES: Array<{ pattern: RegExp; default: "auto" | "manual" | "semi" }> = [
  { pattern: /밸런스(?!\s*수치)/, default: "semi" },
  { pattern: /NPC\s*반응/, default: "semi" },
  { pattern: /연출/, default: "manual" },
];

function classifyDodItem(text: string): "auto" | "manual" | "semi" {
  const lower = text.toLowerCase();

  // Check edge cases first (more specific patterns)
  for (const edge of EDGE_CASES) {
    if (edge.pattern.test(text)) return edge.default;
  }

  // "확인" alone doesn't count — only compound forms like "수치 확인", "로그 확인"
  // (already handled by keyword lists containing the compound forms)

  let autoScore = 0;
  let manualScore = 0;
  let semiScore = 0;

  for (const kw of AUTO_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) autoScore++;
  }
  for (const kw of MANUAL_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) manualScore++;
  }
  for (const kw of SEMI_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) semiScore++;
  }

  if (autoScore === 0 && manualScore === 0 && semiScore === 0) return "auto";
  if (semiScore > 0) return "semi";
  if (manualScore > autoScore) return "manual";
  return "auto";
}

// ── Types ──

export type DodVerifyType = "auto" | "manual" | "semi";

export interface ChecklistItem {
  /** Raw text of the checklist item (markdown stripped) */
  text: string;
  /** Whether already completed */
  done: boolean;
  /** Verification classification per DD spec */
  verify: DodVerifyType;
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
      const itemText = match[2].trim();
      checklist.push({
        text: itemText,
        done: match[1].toLowerCase() === "x",
        verify: classifyDodItem(itemText),
      });
    }
  }

  // Fallback: if no DoD section, try legacy whole-body scan
  if (checklist.length === 0) {
    for (const line of body.split("\n")) {
      const match = line.match(CHECKLIST_RE);
      if (match) {
        const itemText = match[2].trim();
        checklist.push({
          text: itemText,
          done: match[1].toLowerCase() === "x",
          verify: classifyDodItem(itemText),
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
      parts.push(`- [${item.done ? "x" : " "}] ${item.text}  \`[${item.verify}]\``);
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

  if (input.checklist.length > 0 && input.issue_url) {
    parts.push(
      `## DoD 체크 필수\n작업 완료 시 GitHub 이슈 본문의 DoD 체크박스를 반드시 체크하세요.\n\`gh api\`로 이슈 body의 \`- [ ]\` → \`- [x]\`로 PATCH (DoD 섹션만 치환).\n미체크 시 리뷰 파이프라인이 지연됩니다.`,
    );
  }

  return parts.join("\n\n");
}
