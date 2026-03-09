import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RoleBinding {
  roleId: string;
  promptFile?: string;
}

interface RoleMapJson {
  byChannelId?: Record<string, RoleBinding>;
  byChannelName?: Record<string, RoleBinding>;
}

const ROLE_MAP_PATH = path.join(os.homedir(), ".remotecc", "role_map.json");

function loadRoleMapJson(): RoleMapJson {
  if (!fs.existsSync(ROLE_MAP_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(ROLE_MAP_PATH, "utf-8")) as RoleMapJson;
  } catch {
    return {};
  }
}

export function resolveRoleIdByChannelName(channelName: string): string | null {
  const roleMap = loadRoleMapJson();
  const byName = roleMap.byChannelName ?? {};
  const exact = byName[channelName];
  if (exact?.roleId) return String(exact.roleId);

  const key = Object.keys(byName).find((name) => name.toLowerCase() === channelName.toLowerCase());
  if (!key) return null;
  return byName[key]?.roleId ? String(byName[key].roleId) : null;
}

export function listRoleBindings(): Array<{
  channelId: string | null;
  channelName: string | null;
  roleId: string;
  promptFile?: string;
}> {
  const roleMap = loadRoleMapJson();
  const items: Array<{
    channelId: string | null;
    channelName: string | null;
    roleId: string;
    promptFile?: string;
  }> = [];
  const seen = new Set<string>();

  for (const [channelId, binding] of Object.entries(roleMap.byChannelId ?? {})) {
    if (!binding?.roleId) continue;
    const key = `${binding.roleId}:${channelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      channelId,
      channelName: null,
      roleId: String(binding.roleId),
      promptFile: binding.promptFile,
    });
  }

  for (const [channelName, binding] of Object.entries(roleMap.byChannelName ?? {})) {
    if (!binding?.roleId) continue;
    const key = `${binding.roleId}:${channelName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      channelId: null,
      channelName,
      roleId: String(binding.roleId),
      promptFile: binding.promptFile,
    });
  }

  return items;
}
