import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getDb } from "./db/runtime.js";
import { listRoleBindings } from "./role-map.js";

const execFileAsync = promisify(execFile);
const REMOTECC_BIN = path.join(os.homedir(), ".remotecc", "bin", "remotecc");
const PCD_STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "pixel-claw-dashboard",
);

export type BotType = "command" | "notify";

/** Load command (명령봇) token: env var > state file > .env file */
function loadCommandToken(): string {
  if (process.env.DISCORD_AUTOMATION_BOT_TOKEN) return process.env.DISCORD_AUTOMATION_BOT_TOKEN;
  try {
    const tokenFile = path.join(PCD_STATE_DIR, "discord-automation-token");
    if (fs.existsSync(tokenFile)) {
      const fileToken = fs.readFileSync(tokenFile, "utf-8").trim();
      if (fileToken) return fileToken;
    }
  } catch {}
  if (process.env.DISCORD_ANNOUNCE_BOT_TOKEN) return process.env.DISCORD_ANNOUNCE_BOT_TOKEN;
  try {
    const envPath = path.join(import.meta.dirname ?? process.cwd(), "..", ".env");
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const m = line.match(/^(DISCORD_AUTOMATION_BOT_TOKEN|DISCORD_ANNOUNCE_BOT_TOKEN)=(.+)/);
      if (m) return m[2].trim();
    }
  } catch {}
  return "";
}

/** Load notify (알림봇) token: env var > state file */
function loadNotifyToken(): string {
  if (process.env.DISCORD_NOTIFY_BOT_TOKEN) return process.env.DISCORD_NOTIFY_BOT_TOKEN;
  try {
    const tokenFile = path.join(PCD_STATE_DIR, "discord-notify-token");
    if (fs.existsSync(tokenFile)) {
      const fileToken = fs.readFileSync(tokenFile, "utf-8").trim();
      if (fileToken) return fileToken;
    }
  } catch {}
  return "";
}

const COMMAND_BOT_TOKEN = loadCommandToken();
const NOTIFY_BOT_TOKEN = loadNotifyToken();
const CHANNEL_NAME_CACHE = new Map<string, string | null>();

function getToken(bot: BotType = "command"): string {
  return bot === "notify" ? (NOTIFY_BOT_TOKEN || COMMAND_BOT_TOKEN) : COMMAND_BOT_TOKEN;
}

function discordHeaders(bot: BotType = "command"): Record<string, string> {
  return {
    Authorization: `Bot ${getToken(bot)}`,
    "Content-Type": "application/json",
  };
}

interface DiscordChannelLookup {
  id?: string;
  name?: string;
  type?: number;
}

export async function resolveDiscordChannelName(channelId: string): Promise<string | null> {
  if (!/^\d+$/.test(channelId) || !COMMAND_BOT_TOKEN) return null;
  if (CHANNEL_NAME_CACHE.has(channelId)) {
    return CHANNEL_NAME_CACHE.get(channelId) ?? null;
  }

  try {
    const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
      method: "GET",
      headers: discordHeaders(),
    });
    if (!resp.ok) {
      console.error(
        `[discord-announce] Failed to resolve channel name ${channelId}: ${resp.status} ${resp.statusText}`,
      );
      CHANNEL_NAME_CACHE.set(channelId, null);
      return null;
    }
    const json = (await resp.json()) as DiscordChannelLookup;
    const name = typeof json.name === "string" && json.name.trim() ? json.name.trim() : null;
    CHANNEL_NAME_CACHE.set(channelId, name);
    return name;
  } catch (err) {
    console.error(`[discord-announce] Error resolving channel name ${channelId}:`, err);
    CHANNEL_NAME_CACHE.set(channelId, null);
    return null;
  }
}

async function sendDiscordViaRemoteCc(channelId: string, text: string): Promise<boolean> {
  if (!/^\d+$/.test(channelId) || !fs.existsSync(REMOTECC_BIN)) return false;
  try {
    await execFileAsync(
      REMOTECC_BIN,
      ["--discord-sendmessage", "--channel", channelId, "--message", text],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    return true;
  } catch (err) {
    console.error(`[discord-announce] RemoteCC send failed ${channelId}:`, err);
    return false;
  }
}

function normalizeChannelTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("channel:")) {
    const channelId = trimmed.slice("channel:".length).trim();
    return /^\d+$/.test(channelId) ? channelId : null;
  }
  return null;
}

async function openDiscordDm(userId: string, bot: BotType = "command"): Promise<string | null> {
  const token = getToken(bot);
  if (!token || !/^\d+$/.test(userId)) return null;
  try {
    const resp = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: discordHeaders(bot),
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!resp.ok) {
      console.error(`[discord-announce] Failed to open DM for ${userId}: ${resp.status} ${resp.statusText}`);
      return null;
    }
    const json = await resp.json() as { id?: string };
    return json.id && /^\d+$/.test(json.id) ? json.id : null;
  } catch (err) {
    console.error(`[discord-announce] Error opening DM for ${userId}:`, err);
    return null;
  }
}

/** Send a message to a Discord channel.
 * @param bot - "command" (명령봇, default) or "notify" (알림봇, info-only) */
export async function sendDiscordMessage(channelId: string, text: string, bot: BotType = "command"): Promise<boolean> {
  if (!channelId) return false;
  const token = getToken(bot);
  if (token) {
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: discordHeaders(bot),
        body: JSON.stringify({ content: text }),
      });
      if (resp.ok) return true;
      console.error(`[discord-announce] Failed ${channelId} (bot=${bot}): ${resp.status} ${resp.statusText}`);
    } catch (err) {
      console.error(`[discord-announce] Error ${channelId} (bot=${bot}):`, err);
    }
  }
  return sendDiscordViaRemoteCc(channelId, text);
}

/** Send a message to a concrete Discord target.
 *
 * Supported targets:
 * - `channel:<id>`
 * - raw channel ID
 * - `dm:<userId>`
 * - `user:<userId>`
 *
 * @param bot - "command" (명령봇, default) or "notify" (알림봇, info-only)
 */
export async function sendDiscordTarget(target: string, text: string, bot: BotType = "command"): Promise<boolean> {
  const channelId = normalizeChannelTarget(target);
  if (channelId) {
    return sendDiscordMessage(channelId, text, bot);
  }

  const trimmed = target.trim();
  const dmPrefixes = ["dm:", "user:"];
  for (const prefix of dmPrefixes) {
    if (!trimmed.startsWith(prefix)) continue;
    const userId = trimmed.slice(prefix.length).trim();
    const dmChannelId = await openDiscordDm(userId, bot);
    if (dmChannelId) {
      return sendDiscordMessage(dmChannelId, text, bot);
    }
    return false;
  }

  console.error(`[discord-announce] Unsupported target: ${target}`);
  return false;
}

interface AgentChannels {
  openclaw_id: string | null;
  discord_channel_id: string | null;
  discord_channel_id_alt: string | null;
  discord_channel_id_codex: string | null;
  discord_prefer_alt: number;
}

function collectAgentTargets(agentLookup: string, agent?: AgentChannels): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  const pushTarget = (value: string | null | undefined) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    targets.push(trimmed);
  };

  const roleIds = new Set<string>();
  if (agentLookup.trim()) roleIds.add(agentLookup.trim());
  if (agent?.openclaw_id?.trim()) roleIds.add(agent.openclaw_id.trim());

  for (const binding of listRoleBindings()) {
    if (!binding.channelId || !roleIds.has(binding.roleId)) continue;
    pushTarget(binding.channelId);
  }

  if (!agent) return targets;

  const primary = agent.discord_prefer_alt ? agent.discord_channel_id_alt : agent.discord_channel_id;
  const fallback = agent.discord_prefer_alt ? agent.discord_channel_id : agent.discord_channel_id_alt;
  pushTarget(primary);
  pushTarget(fallback);
  pushTarget(agent.discord_channel_id_codex);

  return targets;
}

/**
 * Resolve agent → send to preferred channel with fallback.
 * If prefer_alt=0: try discord_channel_id first, fallback to discord_channel_id_alt.
 * If prefer_alt=1: try discord_channel_id_alt first, fallback to discord_channel_id.
 */
export async function sendToAgentChannel(
  agentId: string,
  text: string,
  preferredTarget?: string | null,
  bot: BotType = "command",
): Promise<boolean> {
  const db = getDb();
  const agent = db
    .prepare(
      `SELECT openclaw_id, discord_channel_id, discord_channel_id_alt, discord_channel_id_codex, discord_prefer_alt
       FROM agents
       WHERE id = ? OR openclaw_id = ? OR name = ? OR name_ko = ? OR alias = ?`,
    )
    .get(agentId, agentId, agentId, agentId, agentId) as AgentChannels | undefined;

  const targets = collectAgentTargets(agentId, agent);
  if (targets.length === 0) {
    if (!agent) {
      console.error(`[discord-announce] Agent not found: ${agentId}`);
      return false;
    }
    console.error(`[discord-announce] No routed channel configured for agent: ${agentId}`);
    return false;
  }

  const orderedTargets =
    preferredTarget && targets.includes(preferredTarget)
      ? [preferredTarget, ...targets.filter((target) => target !== preferredTarget)]
      : targets;

  for (const target of orderedTargets) {
    const ok = await sendDiscordTarget(target, text, bot);
    if (ok) return true;
    console.error(`[discord-announce] Channel failed for ${agentId}: ${target}`);
  }

  console.error(`[discord-announce] No working channel for agent: ${agentId}`);
  return false;
}
