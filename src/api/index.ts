export {
  getSession,
  getOffices,
  createOffice,
  updateOffice,
  deleteOffice,
  addAgentToOffice,
  removeAgentFromOffice,
  updateOfficeAgent,
  batchAddAgentsToOffice,
  getAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  getSettings,
  saveSettings,
  getStats,
  getDispatchedSessions,
  assignDispatchedSession,
  getAgentCron,
  getAgentDispatchedSessions,
  getAgentSkills,
  getSkillRanking,
  getDiscordBindings,
  getCronJobs,
  getMachineStatus,
  getActivityHeatmap,
  getStreaks,
  getAchievements,
  getGitHubIssues,
  getMessages,
  sendMessage,
} from "./client";

export type {
  CronJob,
  CronSchedule,
  CronJobState,
  AgentSkill,
  AgentSkillsResponse,
  SkillRankingOverallRow,
  SkillRankingByAgentRow,
  SkillRankingResponse,
  DiscordBinding,
  CronJobGlobal,
  MachineStatus,
  HeatmapData,
  AgentStreak,
  Achievement,
  GitHubIssue,
  GitHubIssuesResponse,
  ChatMessage,
} from "./client";

// ── Sprite processing (stub for PCD — no backend sprite processor) ──

export async function processSprite(
  _base64: string,
): Promise<{ previews: Record<string, string>; suggestedNumber: number }> {
  console.warn("[PCD] processSprite is not supported in dashboard mode");
  return { previews: {}, suggestedNumber: 1 };
}

export async function registerSprite(
  _previews: Record<string, string>,
  _spriteNum: number,
): Promise<void> {
  console.warn("[PCD] registerSprite is not supported in dashboard mode");
}

// ── Error type guard ──

interface ApiRequestError {
  code: string;
  message?: string;
}

export function isApiRequestError(e: unknown): e is ApiRequestError {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as ApiRequestError).code === "string"
  );
}
