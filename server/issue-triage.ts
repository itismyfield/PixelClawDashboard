/**
 * Issue Auto-Triage — GitHub Issue 자동 에이전트 분류
 *
 * 5분마다 3개 레포(CookingHeart, RemoteCC, PixelClawDashboard)의
 * open issues를 스캔하고, 아직 분류하지 않은 이슈를 키워드 기반으로
 * 담당 에이전트에 할당한다.
 *
 * 결과:
 *  1. GitHub 이슈에 코멘트로 분류 결과 기록
 *  2. 담당 에이전트 채널에 Discord 알림
 *  3. PMD 채널에 요약 보고
 */

import { execFileSync } from "node:child_process";
import { getDb } from "./db/runtime.js";
import { sendToAgentChannel } from "./discord-announce.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5분
const TRIAGE_COMMENT_TAG = "<!-- pcd-auto-triage -->";

// ---------------------------------------------------------------------------
// Classification rules
// ---------------------------------------------------------------------------

interface TriageRule {
  /** 키워드 (소문자) — 이슈 제목+본문+라벨에서 매칭 */
  keywords: string[];
  /** 매칭 시 할당할 에이전트 openclaw_id */
  agentId: string;
  /** 사람이 알아볼 수 있는 분류 이유 */
  reason: string;
}

/**
 * 레포별 기본 담당자.
 * 인프라/도구 레포는 전담 프로젝트 에이전트가 있다.
 */
const REPO_DEFAULT_AGENT: Record<string, string> = {
  "itismyfield/PixelClawDashboard": "project-pixelclawdashboard",
  "itismyfield/RemoteCC": "project-remotecc",
};

/**
 * CookingHeart 등 게임 레포용 키워드 분류 규칙.
 * 순서 중요 — 먼저 매칭되는 규칙이 이긴다.
 */
const CLASSIFICATION_RULES: TriageRule[] = [
  // QA
  {
    keywords: ["테스트", "qa", "품질", "버그", "regression", "coverage", "테스트 케이스"],
    agentId: "ch-qad",
    reason: "QA/테스트 관련 키워드",
  },
  // Technical Art
  {
    keywords: [
      "리깅", "스켈레톤", "셰이더", "렌더링", "파이프라인", "모델링",
      "텍스처", "애니메이션", "vfx", "이펙트", "라이팅", "rigging",
      "skeleton", "shader", "rendering",
    ],
    agentId: "ch-tad",
    reason: "테크니컬 아트 관련 키워드",
  },
  // Art Direction
  {
    keywords: ["컨셉아트", "스타일가이드", "월드맵", "ui 디자인", "아이콘", "비주얼"],
    agentId: "ch-ad",
    reason: "아트 디렉션 관련 키워드",
  },
  // Engineering / TD
  {
    keywords: [
      "아키텍처", "네트워크", "서버", "동기화", "c++", "rust",
      "프로토타입", "빌드", "인프라", "ci/cd", "성능", "최적화",
      "코드", "구현", "api", "sdk",
    ],
    agentId: "ch-td",
    reason: "엔지니어링 관련 키워드",
  },
  // Product Direction
  {
    keywords: ["제품", "스펙", "요구사항", "ux", "사용자", "플로우", "와이어프레임"],
    agentId: "ch-pd",
    reason: "프로덕트 관련 키워드",
  },
  // Project Management
  {
    keywords: ["일정", "마일스톤", "리소스", "진행", "pm", "스프린트"],
    agentId: "ch-pmd",
    reason: "프로젝트 관리 관련 키워드",
  },
  // Game Design (DD) — 가장 넓은 매칭이므로 마지막
  {
    keywords: [
      "gdd", "게임플레이", "밸런스", "npc", "던전", "전투", "퀘스트",
      "스토리", "요리", "대접", "온기", "레시피", "캐릭터", "스킬",
      "장비", "아이템", "몬스터", "보스", "이벤트", "시스템 설계",
      "메커닉", "상세 설계", "데이터 정의", "풀 정의", "목록",
      "정합성", "시뮬레이션", "역산", "수급",
    ],
    agentId: "ch-dd",
    reason: "게임 디자인 관련 키워드",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ghJson(args: string[], timeoutMs = 30000): string {
  return execFileSync("gh", args, {
    timeout: timeoutMs,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

interface GitHubIssueRow {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: Array<{ name: string }>;
  createdAt: string;
}

function fetchOpenIssues(repo: string): GitHubIssueRow[] {
  try {
    const raw = ghJson([
      "issue", "list",
      "--repo", repo,
      "--state", "open",
      "--limit", "30",
      "--json", "number,title,body,url,labels,createdAt",
    ]);
    return JSON.parse(raw) as GitHubIssueRow[];
  } catch {
    console.error(`[triage] Failed to fetch issues from ${repo}`);
    return [];
  }
}

function classifyIssue(
  repo: string,
  issue: GitHubIssueRow,
): { agentId: string; reason: string; confidence: "high" | "medium" | "low" } {
  // 1) Repo-level default (for infra repos)
  const repoDefault = REPO_DEFAULT_AGENT[repo];
  if (repoDefault) {
    return { agentId: repoDefault, reason: `${repo} 전담 에이전트`, confidence: "high" };
  }

  // 2) Keyword matching
  const haystack = [
    issue.title,
    issue.body ?? "",
    ...issue.labels.map((l) => l.name),
  ].join(" ").toLowerCase();

  for (const rule of CLASSIFICATION_RULES) {
    const matched = rule.keywords.filter((kw) => haystack.includes(kw));
    if (matched.length >= 2) {
      return { agentId: rule.agentId, reason: `${rule.reason} (${matched.slice(0, 3).join(", ")})`, confidence: "high" };
    }
    if (matched.length === 1) {
      return { agentId: rule.agentId, reason: `${rule.reason} (${matched[0]})`, confidence: "medium" };
    }
  }

  // 3) Fallback → DD for CookingHeart, PMD otherwise
  if (repo === "itismyfield/CookingHeart") {
    return { agentId: "ch-dd", reason: "CookingHeart 기본 분류 (DD)", confidence: "low" };
  }
  return { agentId: "ch-pmd", reason: "분류 불명 → PMD 수동 배정", confidence: "low" };
}

function postTriageComment(repo: string, issueNumber: number, agentName: string, reason: string): void {
  try {
    const comment = [
      TRIAGE_COMMENT_TAG,
      `**🤖 Auto-Triage**: ${agentName}에게 분류됨`,
      `> 사유: ${reason}`,
    ].join("\n");
    ghJson(["issue", "comment", String(issueNumber), "--repo", repo, "--body", comment]);
  } catch (error) {
    console.error(`[triage] Failed to comment on ${repo}#${issueNumber}:`, error);
  }
}

function hasTriageComment(repo: string, issueNumber: number): boolean {
  try {
    const raw = ghJson([
      "issue", "view", String(issueNumber),
      "--repo", repo,
      "--json", "comments",
    ]);
    const parsed = JSON.parse(raw) as { comments: Array<{ body: string }> };
    return parsed.comments.some((c) => c.body.includes(TRIAGE_COMMENT_TAG));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core triage loop
// ---------------------------------------------------------------------------

interface TriageResult {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  agentId: string;
  agentName: string;
  confidence: string;
  reason: string;
}

function resolveAgentName(openclawId: string): string {
  const db = getDb();
  const row = db
    .prepare("SELECT name_ko, alias, name FROM agents WHERE openclaw_id = ?")
    .get(openclawId) as { name_ko: string; alias: string | null; name: string } | undefined;
  return row?.alias || row?.name_ko || row?.name || openclawId;
}

async function triageOnce(): Promise<void> {
  const db = getDb();

  // Get tracked repos
  const repos = (
    db.prepare("SELECT repo FROM kanban_repo_sources").all() as Array<{ repo: string }>
  ).map((r) => r.repo);

  if (repos.length === 0) return;

  // Get already-triaged issues from DB
  const triaged = new Set(
    (
      db
        .prepare("SELECT github_repo || '#' || github_issue_number AS key FROM issue_triage_log")
        .all() as Array<{ key: string }>
    ).map((r) => r.key),
  );

  const results: TriageResult[] = [];

  for (const repo of repos) {
    const issues = fetchOpenIssues(repo);

    for (const issue of issues) {
      const key = `${repo}#${issue.number}`;
      if (triaged.has(key)) continue;

      // Double-check: skip if already has triage comment on GitHub
      if (hasTriageComment(repo, issue.number)) {
        // Record in DB so we don't check again
        db.prepare(
          `INSERT OR IGNORE INTO issue_triage_log (github_repo, github_issue_number, github_issue_title, assigned_agent_id, confidence, reason, triaged_at)
           VALUES (?, ?, ?, 'unknown', 'high', 'pre-existing triage comment', ?)`,
        ).run(repo, issue.number, issue.title, Date.now());
        continue;
      }

      const classification = classifyIssue(repo, issue);
      const agentName = resolveAgentName(classification.agentId);

      // 1. Record in DB
      db.prepare(
        `INSERT OR IGNORE INTO issue_triage_log (github_repo, github_issue_number, github_issue_title, assigned_agent_id, confidence, reason, triaged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        repo,
        issue.number,
        issue.title,
        classification.agentId,
        classification.confidence,
        classification.reason,
        Date.now(),
      );

      // 2. Post GitHub comment
      postTriageComment(repo, issue.number, agentName, classification.reason);

      // 3. Notify agent channel
      const notifyText = [
        `📋 **새 이슈 분류됨** — ${repo}#${issue.number}`,
        `> **${issue.title}**`,
        `> 사유: ${classification.reason} (${classification.confidence})`,
        `> ${issue.url}`,
      ].join("\n");

      void sendToAgentChannel(classification.agentId, notifyText, null, "notify");

      results.push({
        repo,
        issueNumber: issue.number,
        issueTitle: issue.title,
        agentId: classification.agentId,
        agentName,
        confidence: classification.confidence,
        reason: classification.reason,
      });
    }
  }

  // 4. PMD summary report (if any new triages)
  if (results.length > 0) {
    const lines = results.map(
      (r) => `- ${r.repo}#${r.issueNumber} **${r.issueTitle}** → ${r.agentName} (${r.confidence}: ${r.reason})`,
    );
    const summary = [
      `📊 **Auto-Triage 보고** — ${results.length}건 신규 분류`,
      ...lines,
      "",
      "_보정이 필요하면 이슈에 직접 재할당해주세요._",
    ].join("\n");

    void sendToAgentChannel("ch-pmd", summary, null, "notify");
    console.log(`[triage] Triaged ${results.length} issue(s)`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;

export function startIssueTriage(): void {
  console.log("[triage] Starting issue auto-triage (5min interval)");

  // Run first triage after a short delay (let server settle)
  setTimeout(() => {
    void triageOnce().catch((err) =>
      console.error("[triage] Error in initial triage:", err),
    );
  }, 10_000);

  timer = setInterval(() => {
    void triageOnce().catch((err) =>
      console.error("[triage] Error in triage poll:", err),
    );
  }, POLL_INTERVAL_MS);
}

export function stopIssueTriage(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log("[triage] Stopped issue auto-triage");
}
