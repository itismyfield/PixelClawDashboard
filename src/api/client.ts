import type {
  Agent,
  Department,
  Office,
  DispatchedSession,
  DashboardStats,
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

export async function getDispatchedSessions(): Promise<DispatchedSession[]> {
  const data = await request<{ sessions: DispatchedSession[] }>(
    "/api/dispatched-sessions",
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
