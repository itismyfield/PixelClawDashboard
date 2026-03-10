import { Router } from "express";
import { execFileSync } from "node:child_process";

const router = Router();
const REPO_CACHE_TTL_MS = 5 * 60 * 1000;

type GitHubRepoRow = {
  nameWithOwner: string;
  updatedAt: string;
  isPrivate: boolean;
  viewerPermission?: string;
};

const GITHUB_ISSUE_JSON_FIELDS = "number,title,state,url,labels,assignees,createdAt,updatedAt";

let githubRepoCache:
  | {
      expiresAt: number;
      payload: { viewer_login: string; repos: GitHubRepoRow[] };
    }
  | null = null;

function ghText(args: string[]): string {
  return execFileSync("gh", args, {
    timeout: 15000,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function loadGithubRepos(): { viewer_login: string; repos: GitHubRepoRow[] } {
  if (githubRepoCache && githubRepoCache.expiresAt > Date.now()) {
    return githubRepoCache.payload;
  }

  const viewerLogin = ghText(["api", "user", "-q", ".login"]);
  const repoMap = new Map<string, GitHubRepoRow>();

  const raw = ghText([
    "repo",
    "list",
    viewerLogin,
    "--limit",
    "100",
    "--json",
    "nameWithOwner,updatedAt,isPrivate,viewerPermission",
  ]);
  const repos = JSON.parse(raw) as GitHubRepoRow[];
  for (const repo of repos) {
    if (!repo?.nameWithOwner) continue;
    repoMap.set(repo.nameWithOwner, repo);
  }

  const payload = {
    viewer_login: viewerLogin,
    repos: Array.from(repoMap.values()).sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }),
  };
  githubRepoCache = {
    expiresAt: Date.now() + REPO_CACHE_TTL_MS,
    payload,
  };
  return payload;
}

function normalizeGitHubRepoName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : null;
}

function normalizeGitHubIssueState(value: unknown): "open" | "closed" | "all" | null {
  if (typeof value !== "string") return "open";
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "open" || trimmed === "closed" || trimmed === "all") return trimmed;
  return null;
}

function resolveDefaultGithubIssueRepo(): string {
  const { viewer_login: viewerLogin, repos } = loadGithubRepos();
  const preferred = `${viewerLogin}/CookingHeart`;
  if (repos.some((repo) => repo.nameWithOwner === preferred)) return preferred;
  return repos[0]?.nameWithOwner ?? preferred;
}

router.get("/api/github-repos", (_req, res) => {
  try {
    res.json(loadGithubRepos());
  } catch (error) {
    const message = error instanceof Error ? error.message : "gh CLI unavailable";
    res.status(500).json({ viewer_login: "", repos: [], error: message });
  }
});

router.get("/api/github-issues", async (req, res) => {
  const requestedRepo = normalizeGitHubRepoName(req.query.repo);
  if (req.query.repo && !requestedRepo) {
    return res.status(400).json({ issues: [], repo: "", error: "invalid_repo" });
  }

  const state = normalizeGitHubIssueState(req.query.state);
  if (!state) {
    return res.status(400).json({ issues: [], repo: requestedRepo ?? "", error: "invalid_state" });
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  try {
    const repo = requestedRepo ?? resolveDefaultGithubIssueRepo();
    const result = ghText([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      state,
      "--limit",
      String(limit),
      "--json",
      GITHUB_ISSUE_JSON_FIELDS,
    ]);
    const issues = JSON.parse(result);
    res.json({ issues, repo });
  } catch {
    res.json({
      issues: [],
      repo: requestedRepo ?? "",
      error: "gh CLI unavailable or repo not accessible",
    });
  }
});

export default router;
