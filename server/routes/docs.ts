import { Router } from "express";

const router = Router();

/* ------------------------------------------------------------------ */
/*  Route metadata registry                                           */
/*  Key: "METHOD /path"                                               */
/*  New routes auto-appear in /api/docs; add a metadata entry here    */
/*  to provide description, params, query, body info.                 */
/* ------------------------------------------------------------------ */

interface RouteMeta {
  description: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, string>;
}

const META: Record<string, RouteMeta> = {
  // health
  "GET /api/health": { description: "Health check" },
  "GET /health": { description: "Health check (alias)" },

  // auth
  "GET /api/auth/session": { description: "Create auth session cookie and get CSRF token" },

  // agents
  "GET /api/agents": {
    description: "List all agents",
    query: { officeId: "Filter by office ID" },
  },
  "GET /api/agents/:id": { description: "Get agent by ID" },
  "GET /api/agents/:id/offices": { description: "List offices the agent belongs to" },
  "POST /api/agents": {
    description: "Create a new agent",
    body: { name: "string", department_id: "string?", avatar_emoji: "string?", sprite_number: "number?", personality: "string?", cli_provider: "string?", status: "string?", alias: "string?", discord_channel_id_codex: "string?", office_id: "string?" },
  },
  "PATCH /api/agents/:id": {
    description: "Update agent fields",
    body: { name: "string?", department_id: "string?", avatar_emoji: "string?", sprite_number: "number?", personality: "string?", status: "string?", session_info: "string?", role_id: "string?", alias: "string?", cli_provider: "string?", discord_channel_id: "string?", discord_channel_id_alt: "string?", discord_channel_id_codex: "string?", discord_prefer_alt: "boolean?" },
  },
  "DELETE /api/agents/:id": { description: "Delete an agent" },
  "GET /api/agents/:id/cron": { description: "List cron jobs for agent" },
  "GET /api/agents/:id/dispatched-sessions": { description: "List dispatched sessions for agent" },
  "GET /api/agents/:id/skills": { description: "List skills for agent" },
  "GET /api/discord-bindings": { description: "List all Discord channel bindings (role-map + agent channels)" },

  // departments
  "GET /api/departments": {
    description: "List all departments",
    query: { officeId: "Filter by office ID" },
  },
  "GET /api/departments/:id": { description: "Get department with its agents" },
  "POST /api/departments": {
    description: "Create a department",
    body: { name: "string", icon: "string?", color: "string?", description: "string?", office_id: "string?", sort_order: "number?" },
  },
  "PATCH /api/departments/:id": { description: "Update department fields" },
  "PATCH /api/departments/reorder": {
    description: "Reorder departments",
    body: { order: "[{id, sort_order}]" },
  },
  "DELETE /api/departments/:id": { description: "Delete department (must have no agents)" },

  // settings
  "GET /api/settings": { description: "Get all settings" },
  "PUT /api/settings": { description: "Save settings (key-value pairs)" },
  "GET /api/settings/runtime-config": { description: "Get runtime config with defaults" },
  "PUT /api/settings/runtime-config": { description: "Update runtime config (numeric validation)" },

  // analytics
  "GET /api/github-closed-today": { description: "Count GitHub issues closed today" },
  "GET /api/stats": { description: "Dashboard statistics (agents, departments, kanban, dispatches)" },
  "GET /api/cron-jobs": { description: "List launchd cron jobs" },
  "GET /api/machine-status": { description: "Check mac-mini / mac-book online status" },
  "GET /api/activity-heatmap": {
    description: "Skill usage heatmap by hour",
    query: { date: "YYYY-MM-DD" },
  },
  "GET /api/skills/trend": {
    description: "Skill usage trend",
    query: { days: "number (default 30)" },
  },
  "GET /api/streaks": { description: "Agent activity streaks" },
  "GET /api/achievements": {
    description: "Achievement list",
    query: { agentId: "Filter by agent ID" },
  },

  // github
  "GET /api/github-repos": { description: "List user's GitHub repos" },
  "GET /api/github-issues": {
    description: "List GitHub issues",
    query: { repo: "owner/repo", state: "open|closed|all", limit: "number" },
  },
  "PATCH /api/github-issues/:owner/:repo/:number/close": { description: "Close a GitHub issue" },

  // offices
  "GET /api/offices": { description: "List all offices" },
  "GET /api/offices/:id": { description: "Get office with agents and departments" },
  "POST /api/offices": {
    description: "Create an office",
    body: { name: "string", icon: "string?", color: "string?", description: "string?", sort_order: "number?" },
  },
  "PATCH /api/offices/:id": { description: "Update office fields" },
  "DELETE /api/offices/:id": { description: "Delete an office" },
  "POST /api/offices/:id/agents": {
    description: "Add agent to office",
    body: { agent_id: "string", department_id: "string?" },
  },
  "POST /api/offices/:id/agents/batch": {
    description: "Add multiple agents to office",
    body: { agent_ids: "string[]" },
  },
  "DELETE /api/offices/:id/agents/:agentId": { description: "Remove agent from office" },
  "PATCH /api/offices/:id/agents/:agentId": {
    description: "Change agent's department within office",
    body: { department_id: "string" },
  },

  // hook (public, no auth)
  "POST /api/hook/sync-agents": { description: "Sync agents from role-map (creates missing agents)" },
  "POST /api/hook/reset-status": { description: "Reset all working agents to idle (gateway start)" },
  "POST /api/hook/session": {
    description: "Register/heartbeat a dispatched session",
    body: { session_key: "string", name: "string?", model: "string?", status: "string?", session_info: "string?", tokens: "number?", cwd: "string?", dispatch_id: "string?", blocked_reason: "string?" },
  },
  "DELETE /api/hook/session/:sessionKey": { description: "Disconnect a dispatched session" },
  "POST /api/hook/skill-usage": {
    description: "Record skill usage event",
    body: { skill_name: "string", session_key: "string?", agent_role_id: "string?", agent_id: "string?", agent_name: "string?", used_at: "string?", event_key: "string?" },
  },

  // dispatched sessions
  "GET /api/dispatched-sessions": {
    description: "List active dispatched sessions",
    query: { includeMerged: "boolean" },
  },
  "PATCH /api/dispatched-sessions/:id": { description: "Update dispatched session fields" },
  "DELETE /api/dispatched-sessions/cleanup": { description: "Cleanup disconnected sessions" },

  // sprites
  "GET /sprites/:filename": { description: "Serve sprite image file" },

  // skills
  "GET /api/skills/catalog": { description: "List all skills with usage stats" },
  "GET /api/skills/ranking": {
    description: "Skill ranking",
    query: { limit: "number", window: "7d|30d|90d|all" },
  },

  // messages
  "GET /api/messages": {
    description: "List messages",
    query: { receiverId: "string", receiverType: "string", limit: "number", before: "string", messageType: "string" },
  },
  "POST /api/messages": {
    description: "Send a message",
    body: { sender_type: "string", sender_id: "string", receiver_type: "string", receiver_id: "string", content: "string", message_type: "string?", discord_target: "string?" },
  },
  "POST /api/discord/send-target": {
    description: "Send Discord message via bot",
    body: { target: "channel:{id} or user:{id}", content: "string", source: "string?", bot: "command|notification?" },
  },

  // audit
  "GET /api/audit-logs": {
    description: "List audit logs",
    query: { limit: "number", entityType: "string", entityId: "string" },
  },

  // dispatches
  "GET /api/dispatches": {
    description: "List task dispatches",
    query: { status: "string", from_agent_id: "string", to_agent_id: "string", limit: "number" },
  },
  "GET /api/dispatches/:id": { description: "Get dispatch with chain info" },
  "POST /api/dispatches": {
    description: "Create a new dispatch",
    body: { id: "string?", from_agent_id: "string", to_agent_id: "string", dispatch_type: "string?", title: "string?", parent_dispatch_id: "string?" },
  },
  "PATCH /api/dispatches/:id": {
    description: "Update dispatch status",
    body: { status: "pending|dispatched|in_progress|completed|failed|cancelled" },
  },

  // round-table
  "GET /api/round-table-meetings": {
    description: "List round-table meetings",
    query: { limit: "number", offset: "number" },
  },
  "GET /api/round-table-meetings/:id": { description: "Get meeting with entries" },
  "PATCH /api/round-table-meetings/:id/issue-repo": {
    description: "Set GitHub repo for meeting issues",
    body: { repo: "owner/repo" },
  },
  "POST /api/round-table-meetings": {
    description: "Create or update a round-table meeting",
    body: { id: "string?", agenda: "string?", summary: "string?", status: "string?", primary_provider: "string?", participant_names: "string[]?", total_rounds: "number?", entries: "array?", proposed_issues: "array?" },
  },
  "DELETE /api/round-table-meetings/:id": { description: "Delete a meeting" },
  "POST /api/round-table-meetings/:id/issues": {
    description: "Create GitHub issues from meeting proposals",
    body: { repo: "owner/repo" },
  },
  "POST /api/round-table-meetings/:id/issues/discard": {
    description: "Discard a proposed issue",
    body: { key: "string" },
  },
  "POST /api/round-table-meetings/:id/issues/discard-all": { description: "Discard all proposed issues" },
  "POST /api/round-table-meetings/start": {
    description: "Start a round-table meeting via Discord",
    body: { agenda: "string", channel_id: "string?", primary_provider: "string?" },
  },

  // kanban cards
  "GET /api/kanban-cards": {
    description: "List kanban cards",
    query: { status: "string", github_repo: "string", assignee_agent_id: "string", requester_agent_id: "string", limit: "number" },
  },
  "POST /api/kanban-cards/assign-issue": {
    description: "Assign GitHub issue to agent (creates/updates kanban card)",
    body: { github_repo: "string", github_issue_number: "number", github_issue_url: "string?", assignee_agent_id: "string", title: "string?", description: "string?" },
  },
  "GET /api/kanban-cards/:id": { description: "Get kanban card with child cards" },
  "POST /api/kanban-cards/:id/retry": {
    description: "Retry a failed/cancelled card",
    body: { assignee_agent_id: "string?", request_now: "boolean?" },
  },
  "POST /api/kanban-cards/:id/redispatch": {
    description: "Cancel current dispatch and redispatch with latest issue body",
    body: { reason: "string?" },
  },
  "POST /api/kanban-cards": {
    description: "Create a kanban card",
    body: { title: "string", status: "string?", assignee_agent_id: "string?", github_repo: "string?", github_issue_number: "number?", priority: "number?" },
  },
  "PATCH /api/kanban-cards/:id": {
    description: "Update kanban card fields",
    body: { title: "string?", description: "string?", status: "string?", assignee_agent_id: "string?", priority: "number?", review_notes: "string?" },
  },
  "GET /api/kanban-cards/:id/reviews": { description: "Get review history for a kanban card" },
  "PATCH /api/kanban-reviews/:reviewId/decisions": {
    description: "Save review decisions",
    body: { decisions: "[{item_id, decision: accept|reject}]" },
  },
  "POST /api/kanban-reviews/:reviewId/trigger-rework": { description: "Trigger rework based on review decisions" },
  "DELETE /api/kanban-cards/:id": { description: "Delete a kanban card" },

  // kanban repos
  "GET /api/kanban-repos": { description: "List kanban repo sources" },
  "POST /api/kanban-repos": {
    description: "Add a kanban repo source",
    body: { repo: "owner/repo" },
  },
  "PATCH /api/kanban-repos/:id": {
    description: "Update kanban repo source",
    body: { default_agent_id: "string?" },
  },
  "DELETE /api/kanban-repos/:id": { description: "Remove kanban repo source" },

  // rate limits
  "GET /api/rate-limits": { description: "Get Claude + Codex rate limit status (cached polling)" },

  // auto-queue
  "POST /api/auto-queue/generate": {
    description: "Generate auto-queue from ready cards",
    query: { repo: "owner/repo?" },
  },
  "POST /api/auto-queue/activate": { description: "Activate queue (dispatch first card per agent)" },
  "GET /api/auto-queue/status": {
    description: "Get current queue status",
    query: { repo: "owner/repo?" },
  },
  "PATCH /api/auto-queue/entries/:id/skip": { description: "Skip a queue entry" },
  "PATCH /api/auto-queue/runs/:id": {
    description: "Pause/resume/complete a queue run",
    body: { status: "paused|active|completed" },
  },
  "PATCH /api/auto-queue/reorder": {
    description: "Reorder queue entries",
    body: { orderedIds: "string[]", agentId: "string" },
  },

  // pipeline
  "GET /api/pipeline/stages": {
    description: "Get pipeline stages for a repo",
    query: { repo: "owner/repo (required)" },
  },
  "PUT /api/pipeline/stages": {
    description: "Set pipeline stages",
    body: { repo: "owner/repo", stages: "[{stage_name, on_failure}]" },
  },
  "DELETE /api/pipeline/stages": {
    description: "Delete pipeline stages",
    query: { repo: "owner/repo (required)" },
  },
  "GET /api/pipeline/cards/:cardId": { description: "Get pipeline status for a card" },
  "GET /api/pipeline/cards/:cardId/history": { description: "Get pipeline history for a card" },

  // docs
  "GET /api/docs": { description: "This endpoint — auto-generated API documentation" },
};

/* ------------------------------------------------------------------ */
/*  Express router introspection                                      */
/* ------------------------------------------------------------------ */

interface RouteDoc {
  method: string;
  path: string;
  description: string;
  auth: boolean;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, string>;
}

const PUBLIC_PREFIXES = [
  "/api/health",
  "/api/auth/session",
  "/api/hook/",
  "/api/round-table-meetings",
  "/api/docs",
  "/health",
];

function isPublic(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

function extractRoutes(app: any): RouteDoc[] {
  const routes: RouteDoc[] = [];
  const internalRouter = app._router || app.router;
  const stack = internalRouter?.stack || [];

  for (const layer of stack) {
    if (layer.route) {
      addRoute(layer.route);
    } else if (layer.name === "router" && layer.handle?.stack) {
      for (const sub of layer.handle.stack) {
        if (sub.route) {
          addRoute(sub.route);
        }
      }
    }
  }

  function addRoute(route: any) {
    const methods = Object.keys(route.methods).filter(
      (m) => route.methods[m] && m !== "_all",
    );
    for (const method of methods) {
      const m = method.toUpperCase();
      const path: string = route.path;
      // Skip SPA fallback and non-API routes without metadata
      if (path.includes("*") || path.includes("{")) continue;
      const key = `${m} ${path}`;
      const meta = META[key];
      routes.push({
        method: m,
        path,
        description: meta?.description ?? "",
        auth: !isPublic(path),
        ...(meta?.params && { params: meta.params }),
        ...(meta?.query && { query: meta.query }),
        ...(meta?.body && { body: meta.body }),
      });
    }
  }

  return routes.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

/* ------------------------------------------------------------------ */
/*  Handler                                                           */
/* ------------------------------------------------------------------ */

router.get("/api/docs", (req, res) => {
  const routes = extractRoutes(req.app);
  res.json({
    name: "PixelClawDashboard API",
    base_url: `http://${req.headers.host || "localhost:8791"}`,
    total: routes.length,
    routes,
  });
});

export default router;
