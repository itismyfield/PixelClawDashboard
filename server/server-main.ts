import { config } from "dotenv";
import { fileURLToPath } from "node:url";
const __dirname = import.meta.dirname ?? (() => { const p = fileURLToPath(import.meta.url); return p.substring(0, p.lastIndexOf("/")); })();
config({ path: __dirname + "/../.env" });

import express from "express";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "node:http";
import { getDb, closeDb } from "./db/runtime.js";
import { createWsServer } from "./ws.js";
import { authMiddleware, sessionRoute } from "./auth.js";
import agentRoutes from "./routes/agents.js";
import departmentRoutes from "./routes/departments.js";
import settingsRoutes from "./routes/settings.js";
import analyticsRoutes from "./routes/analytics.js";
import githubRoutes from "./routes/github.js";
import officeRoutes from "./routes/offices.js";
import hookRoutes from "./routes/hook.js";
import dispatchedRoutes from "./routes/dispatched.js";
import spriteRoutes from "./routes/sprites.js";
import skillRoutes from "./routes/skills.js";
import messageRoutes from "./routes/messages.js";
import auditRoutes from "./routes/audit.js";
import { startXpSync, stopXpSync } from "./xp-sync.js";
import { startAgentSync, stopAgentSync } from "./agent-sync.js";
import { startSkillSync, stopSkillSync } from "./skill-sync.js";
import { startDispatchedSync, stopDispatchedSync } from "./dispatched-sync.js";
import dispatchTaskRoutes from "./routes/dispatches-task.js";
import roundTableRoutes from "./routes/round-table.js";
import { startDispatchWatcher, stopDispatchWatcher } from "./dispatch-watcher.js";
import kanbanCardRoutes from "./routes/kanban-cards.js";
import kanbanRepoRoutes from "./routes/kanban-repos.js";

const PORT = parseInt(process.env.PORT || "8791", 10);
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS for local dev
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,X-CSRF-Token",
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Auth
app.use(authMiddleware);
app.get("/api/auth/session", sessionRoute);

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Routes
app.use(officeRoutes);
app.use(agentRoutes);
app.use(departmentRoutes);
app.use(settingsRoutes);
app.use(analyticsRoutes);
app.use(githubRoutes);
app.use(hookRoutes);
app.use(dispatchedRoutes);
app.use(spriteRoutes);
app.use(skillRoutes);
app.use(messageRoutes);
app.use(auditRoutes);
app.use(dispatchTaskRoutes);
app.use(kanbanCardRoutes);
app.use(kanbanRepoRoutes);
app.use(roundTableRoutes);

// Static files (production)
const distDir = path.join(process.cwd(), "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

// Initialize DB
getDb();

// Start server
const server = createServer(app);
createWsServer(server);

server.listen(PORT, HOST, () => {
  console.log(`[PCD] PixelClawDashboard listening on http://${HOST}:${PORT}`);
  startXpSync();
  startAgentSync();
  startSkillSync();
  startDispatchedSync();
  startDispatchWatcher();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[PCD] shutting down...");
  stopXpSync();
  stopAgentSync();
  stopSkillSync();
  stopDispatchedSync();
  stopDispatchWatcher();
  server.close();
  closeDb();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[PCD] shutting down...");
  stopXpSync();
  stopAgentSync();
  stopSkillSync();
  stopDispatchedSync();
  stopDispatchWatcher();
  server.close();
  closeDb();
  process.exit(0);
});
