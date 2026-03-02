import type {
  Agent,
  Department,
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

// Agents
export async function getAgents(): Promise<Agent[]> {
  const data = await request<{ agents: Agent[] }>("/api/agents");
  return data.agents;
}

export async function createAgent(
  agent: Partial<Agent>,
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

// Departments
export async function getDepartments(
  packKey?: string,
): Promise<Department[]> {
  const q = packKey ? `?workflowPackKey=${packKey}` : "";
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

// Settings
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

// Stats
export async function getStats(): Promise<DashboardStats> {
  return request("/api/stats");
}

// Dispatched Sessions
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
