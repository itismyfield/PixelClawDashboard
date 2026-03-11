import { Router } from "express";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendAuditLog, getAuditActor } from "../audit-log.js";
import { getDb } from "../db/runtime.js";

const router = Router();

function normalizeGitHubRepo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : null;
}

function ensureGitHubRepoAccessible(repo: string): void {
  execFileSync("gh", ["repo", "view", repo, "--json", "nameWithOwner"], {
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

router.get("/api/kanban-repos", (_req, res) => {
  const db = getDb();
  const repos = db.prepare(
    `SELECT id, repo, default_agent_id, created_at
     FROM kanban_repo_sources
     ORDER BY created_at DESC`,
  ).all();
  res.json({ repos });
});

router.post("/api/kanban-repos", (req, res) => {
  const db = getDb();
  const repo = normalizeGitHubRepo(req.body?.repo);
  if (!repo) {
    res.status(400).json({ error: "invalid_repo" });
    return;
  }

  try {
    ensureGitHubRepoAccessible(repo);
  } catch {
    res.status(400).json({ error: "repo_not_accessible" });
    return;
  }

  const existing = db.prepare(
    `SELECT id, repo, default_agent_id, created_at
     FROM kanban_repo_sources
     WHERE repo = ?
     LIMIT 1`,
  ).get(repo);

  if (existing) {
    res.json(existing);
    return;
  }

  const createdAt = Date.now();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO kanban_repo_sources (id, repo, created_at)
     VALUES (?, ?, ?)`,
  ).run(id, repo, createdAt);

  const created = db.prepare(
    `SELECT id, repo, default_agent_id, created_at
     FROM kanban_repo_sources
     WHERE id = ?
     LIMIT 1`,
  ).get(id);

  appendAuditLog({
    actor: getAuditActor(req),
    action: "create",
    entityType: "kanban_repo_source",
    entityId: id,
    summary: `Kanban repo source added: ${repo}`,
  });

  res.status(201).json(created);
});

router.patch("/api/kanban-repos/:id", (req, res) => {
  const db = getDb();
  const defaultAgentId = typeof req.body?.default_agent_id === "string" ? req.body.default_agent_id.trim() || null : null;
  db.prepare("UPDATE kanban_repo_sources SET default_agent_id = ? WHERE id = ?").run(defaultAgentId, req.params.id);
  const updated = db.prepare(
    `SELECT id, repo, default_agent_id, created_at FROM kanban_repo_sources WHERE id = ? LIMIT 1`,
  ).get(req.params.id);
  if (!updated) {
    res.status(404).json({ error: "kanban_repo_not_found" });
    return;
  }
  res.json(updated);
});

router.delete("/api/kanban-repos/:id", (req, res) => {
  const db = getDb();
  const existing = db.prepare(
    `SELECT id, repo
     FROM kanban_repo_sources
     WHERE id = ?
     LIMIT 1`,
  ).get(req.params.id) as { id: string; repo: string } | undefined;

  if (!existing) {
    res.status(404).json({ error: "kanban_repo_not_found" });
    return;
  }

  db.prepare("DELETE FROM kanban_repo_sources WHERE id = ?").run(req.params.id);

  appendAuditLog({
    actor: getAuditActor(req),
    action: "delete",
    entityType: "kanban_repo_source",
    entityId: req.params.id,
    summary: `Kanban repo source removed: ${existing.repo}`,
  });

  res.json({ ok: true });
});

export default router;
