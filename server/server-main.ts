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
import officeRoutes from "./routes/offices.js";
import hookRoutes from "./routes/hook.js";
import dispatchedRoutes from "./routes/dispatched.js";
import spriteRoutes from "./routes/sprites.js";

const PORT = parseInt(process.env.PORT || "8791", 10);
const HOST = process.env.HOST || "127.0.0.1";

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
app.use(hookRoutes);
app.use(dispatchedRoutes);
app.use(spriteRoutes);

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
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[PCD] shutting down...");
  server.close();
  closeDb();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[PCD] shutting down...");
  server.close();
  closeDb();
  process.exit(0);
});
