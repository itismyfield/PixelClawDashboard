import type {
  Agent,
  Department,
  Office,
  DispatchedSession,
  DashboardStats,
  RoundTableMeeting,
  SkillCatalogEntry,
} from "../types";

const BASE = "";

async function request<T>(
  url: string,
  opts?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    credentials: "include",
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "unknown" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Auth
export async function getSession(): Promise<{ ok: boolean; csrf_token: string }> {
  return request("/api/auth/session");
}

// ── Offices ──

export async function getOffices(): Promise<Office[]> {
  const data = await request<{ offices: Office[] }>("/api/offices");
  return data.offices;
}

export async function createOffice(
  office: Partial<Office>,
): Promise<Office> {
  return request("/api/offices", {
    method: "POST",
    body: JSON.stringify(office),
  });
}

export async function updateOffice(
  id: string,
  patch: Partial<Office>,
): Promise<Office> {
  return request(`/api/offices/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteOffice(id: string): Promise<void> {
  await request(`/api/offices/${id}`, { method: "DELETE" });
}

export async function addAgentToOffice(
  officeId: string,
  agentId: string,
  departmentId?: string | null,
): Promise<void> {
  await request(`/api/offices/${officeId}/agents`, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, department_id: departmentId ?? null }),
  });
}

export async function removeAgentFromOffice(
  officeId: string,
  agentId: string,
): Promise<void> {
  await request(`/api/offices/${officeId}/agents/${agentId}`, {
    method: "DELETE",
  });
}

export async function updateOfficeAgent(
  officeId: string,
  agentId: string,
  patch: { department_id?: string | null },
): Promise<void> {
  await request(`/api/offices/${officeId}/agents/${agentId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function batchAddAgentsToOffice(
  officeId: string,
  agentIds: string[],
): Promise<void> {
  await request(`/api/offices/${officeId}/agents/batch`, {
    method: "POST",
    body: JSON.stringify({ agent_ids: agentIds }),
  });
}

// ── Agents ──

export async function getAgents(officeId?: string): Promise<Agent[]> {
  const q = officeId ? `?officeId=${officeId}` : "";
  const data = await request<{ agents: Agent[] }>(`/api/agents${q}`);
  return data.agents;
}

export async function createAgent(
  agent: Partial<Agent> & { office_id?: string },
): Promise<Agent> {
  return request("/api/agents", {
    method: "POST",
    body: JSON.stringify(agent),
  });
}

export async function updateAgent(
  id: string,
  patch: Partial<Agent>,
): Promise<Agent> {
  return request(`/api/agents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteAgent(id: string): Promise<void> {
  await request(`/api/agents/${id}`, { method: "DELETE" });
}

// ── Departments ──

export async function getDepartments(officeId?: string): Promise<Department[]> {
  const q = officeId ? `?officeId=${officeId}` : "";
  const data = await request<{ departments: Department[] }>(
    `/api/departments${q}`,
  );
  return data.departments;
}

export async function createDepartment(
  dept: Partial<Department>,
): Promise<Department> {
  return request("/api/departments", {
    method: "POST",
    body: JSON.stringify(dept),
  });
}

export async function updateDepartment(
  id: string,
  patch: Partial<Department>,
): Promise<Department> {
  return request(`/api/departments/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteDepartment(id: string): Promise<void> {
  await request(`/api/departments/${id}`, { method: "DELETE" });
}

// ── Settings ──

export async function getSettings(): Promise<Record<string, unknown>> {
  return request("/api/settings");
}

export async function saveSettings(
  settings: Record<string, unknown>,
): Promise<void> {
  await request("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

// ── Stats ──

export async function getStats(officeId?: string): Promise<DashboardStats> {
  const q = officeId ? `?officeId=${officeId}` : "";
  return request(`/api/stats${q}`);
}

// ── Dispatched Sessions ──

export async function getDispatchedSessions(includeMerged = false): Promise<DispatchedSession[]> {
  const q = includeMerged ? "?includeMerged=1" : "";
  const data = await request<{ sessions: DispatchedSession[] }>(
    `/api/dispatched-sessions${q}`,
  );
  return data.sessions;
}

export async function assignDispatchedSession(
  id: string,
  patch: Partial<DispatchedSession>,
): Promise<DispatchedSession> {
  return request(`/api/dispatched-sessions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ── Agent Cron Jobs ──

export interface CronSchedule {
  kind: "every" | "cron" | "at";
  everyMs?: number;
  cron?: string;
  atMs?: number;
}

export interface CronJobState {
  lastStatus?: string;
  lastRunAtMs?: number;
  lastDurationMs?: number;
  nextRunAtMs?: number;
}

export interface CronJob {
  id: string;
  name: string;
  description_ko?: string;
  enabled: boolean;
  schedule: CronSchedule;
  state?: CronJobState;
}

export async function getAgentCron(agentId: string): Promise<CronJob[]> {
  const data = await request<{ jobs: CronJob[] }>(`/api/agents/${agentId}/cron`);
  return data.jobs;
}

export async function getAgentDispatchedSessions(agentId: string): Promise<DispatchedSession[]> {
  const data = await request<{ sessions: DispatchedSession[] }>(`/api/agents/${agentId}/dispatched-sessions`);
  return data.sessions;
}

// ── Agent Skills ──

export interface AgentSkill {
  name: string;
  description: string;
  shared: boolean;
}

export interface AgentSkillsResponse {
  skills: AgentSkill[];
  sharedSkills: AgentSkill[];
  totalCount: number;
}

export async function getAgentSkills(agentId: string): Promise<AgentSkillsResponse> {
  return request(`/api/agents/${agentId}/skills`);
}

// ── Discord Bindings ──

export interface DiscordBinding {
  agentId: string;
  channelId: string;
  channelName?: string;
}

export async function getDiscordBindings(): Promise<DiscordBinding[]> {
  const data = await request<{ bindings: DiscordBinding[] }>("/api/discord-bindings");
  return data.bindings;
}

// ── Cron Jobs (global) ──

export interface CronJobGlobal {
  id: string;
  name: string;
  agentId?: string;
  enabled: boolean;
  schedule: CronSchedule;
  state?: CronJobState;
  discordChannelId?: string;
  description_ko?: string;
}

export async function getCronJobs(): Promise<CronJobGlobal[]> {
  const data = await request<{ jobs: CronJobGlobal[] }>("/api/cron-jobs");
  return data.jobs;
}

// ── Machine Status ──

export interface MachineStatus {
  name: string;
  online: boolean;
  lastChecked: number;
}

export async function getMachineStatus(): Promise<MachineStatus[]> {
  return request("/api/machine-status");
}

// ── Activity Heatmap ──

export interface HeatmapData {
  hours: Array<{
    hour: number;
    agents: Record<string, number>; // agentId → event count
  }>;
  date: string;
}

export async function getActivityHeatmap(date?: string): Promise<HeatmapData> {
  const q = date ? `?date=${date}` : "";
  return request(`/api/activity-heatmap${q}`);
}

// ── Skill Ranking ──

export interface SkillRankingOverallRow {
  skill_name: string;
  skill_desc_ko: string;
  calls: number;
  last_used_at: number;
}

export interface SkillRankingByAgentRow {
  agent_openclaw_id: string;
  agent_name: string;
  skill_name: string;
  skill_desc_ko: string;
  calls: number;
  last_used_at: number;
}

export interface SkillRankingResponse {
  window: string;
  overall: SkillRankingOverallRow[];
  byAgent: SkillRankingByAgentRow[];
}

export async function getSkillRanking(
  window: "7d" | "30d" | "90d" | "all" = "7d",
  limit = 20,
): Promise<SkillRankingResponse> {
  return request(`/api/skills/ranking?window=${window}&limit=${limit}`);
}

// ── GitHub Issues ──

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubIssuesResponse {
  issues: GitHubIssue[];
  repo: string;
  error?: string;
}

// ── Streaks ──

export interface AgentStreak {
  agent_id: string;
  name: string;
  avatar_emoji: string;
  streak: number;
  last_active: string;
}

export async function getStreaks(): Promise<{ streaks: AgentStreak[] }> {
  return request("/api/streaks");
}

// ── Achievements ──

export interface Achievement {
  id: string;
  agent_id: string;
  type: string;
  name: string;
  description: string | null;
  earned_at: number;
  agent_name: string;
  agent_name_ko: string;
  avatar_emoji: string;
}

export async function getAchievements(agentId?: string): Promise<{ achievements: Achievement[] }> {
  const q = agentId ? `?agentId=${agentId}` : "";
  return request(`/api/achievements${q}`);
}

// ── Messages (Chat) ──

export interface ChatMessage {
  id: number;
  sender_type: "ceo" | "agent" | "system";
  sender_id: string | null;
  receiver_type: "agent" | "department" | "all";
  receiver_id: string | null;
  content: string;
  message_type: string;
  created_at: number;
  sender_name?: string | null;
  sender_name_ko?: string | null;
  sender_avatar?: string | null;
}

export async function getMessages(opts?: {
  receiverId?: string;
  receiverType?: string;
  limit?: number;
  before?: number;
}): Promise<{ messages: ChatMessage[] }> {
  const params = new URLSearchParams();
  if (opts?.receiverId) params.set("receiverId", opts.receiverId);
  if (opts?.receiverType) params.set("receiverType", opts.receiverType);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.before) params.set("before", String(opts.before));
  const q = params.toString();
  return request(`/api/messages${q ? `?${q}` : ""}`);
}

export async function sendMessage(payload: {
  sender_type?: string;
  sender_id?: string | null;
  receiver_type: string;
  receiver_id?: string | null;
  content: string;
  message_type?: string;
}): Promise<ChatMessage> {
  return request("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ── GitHub Issues ──

export async function getGitHubIssues(
  repo?: string,
  state: "open" | "closed" | "all" = "open",
  limit = 20,
): Promise<GitHubIssuesResponse> {
  const params = new URLSearchParams({ state, limit: String(limit) });
  if (repo) params.set("repo", repo);
  return request(`/api/github-issues?${params}`);
}

// ── Round Table Meetings ──

export async function getRoundTableMeetings(): Promise<RoundTableMeeting[]> {
  const data = await request<{ meetings: RoundTableMeeting[] }>("/api/round-table-meetings");
  return data.meetings;
}

export async function getRoundTableMeeting(id: string): Promise<RoundTableMeeting> {
  return request(`/api/round-table-meetings/${id}`);
}

export async function deleteRoundTableMeeting(id: string): Promise<{ ok: boolean }> {
  return request(`/api/round-table-meetings/${id}`, { method: "DELETE" });
}

export interface RoundTableIssueCreationResponse {
  ok: boolean;
  skipped?: boolean;
  results: Array<{
    key: string;
    title: string;
    assignee: string;
    ok: boolean;
    error?: string | null;
    issue_url?: string | null;
    attempted_at: number;
  }>;
  summary: {
    total: number;
    created: number;
    failed: number;
    pending: number;
    all_created: boolean;
  };
}

export async function createRoundTableIssues(id: string, repo?: string): Promise<RoundTableIssueCreationResponse> {
  return request(`/api/round-table-meetings/${id}/issues`, {
    method: "POST",
    body: JSON.stringify({ repo }),
  });
}

export async function startRoundTableMeeting(
  agenda: string,
  channelId: string,
  primaryProvider?: "claude" | "codex",
): Promise<{ ok: boolean }> {
  return request("/api/round-table-meetings/start", {
    method: "POST",
    body: JSON.stringify({ agenda, channel_id: channelId, primary_provider: primaryProvider ?? null }),
  });
}

// ── Skill Catalog ──

export async function getSkillCatalog(): Promise<SkillCatalogEntry[]> {
  const data = await request<{ catalog: SkillCatalogEntry[] }>("/api/skills/catalog");
  return data.catalog;
}
