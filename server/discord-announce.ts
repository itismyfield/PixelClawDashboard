import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db/runtime.js";

/** Load announce bot token: env var > .env file */
function loadToken(): string {
  if (process.env.DISCORD_ANNOUNCE_BOT_TOKEN) return process.env.DISCORD_ANNOUNCE_BOT_TOKEN;
  try {
    const envPath = path.join(import.meta.dirname ?? process.cwd(), "..", ".env");
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const m = line.match(/^DISCORD_ANNOUNCE_BOT_TOKEN=(.+)/);
      if (m) return m[1].trim();
    }
  } catch {}
  return "";
}

const BOT_TOKEN = loadToken();

/** Send a message to a Discord channel via the announce bot */
export async function sendDiscordMessage(channelId: string, text: string): Promise<boolean> {
  if (!BOT_TOKEN || !channelId) return false;
  try {
    const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    });
    if (!resp.ok) {
      console.error(`[discord-announce] Failed ${channelId}: ${resp.status} ${resp.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[discord-announce] Error ${channelId}:`, err);
    return false;
  }
}

interface AgentChannels {
  discord_channel_id: string | null;
  discord_channel_id_alt: string | null;
  discord_prefer_alt: number;
}

/**
 * Resolve agent → send to preferred channel with fallback.
 * If prefer_alt=0: try discord_channel_id first, fallback to discord_channel_id_alt.
 * If prefer_alt=1: try discord_channel_id_alt first, fallback to discord_channel_id.
 */
export async function sendToAgentChannel(agentId: string, text: string): Promise<boolean> {
  const db = getDb();
  const agent = db
    .prepare(
      `SELECT discord_channel_id, discord_channel_id_alt, discord_prefer_alt
       FROM agents
       WHERE id = ? OR name = ? OR name_ko = ? OR alias = ?`,
    )
    .get(agentId, agentId, agentId, agentId) as AgentChannels | undefined;

  if (!agent) {
    console.error(`[discord-announce] Agent not found: ${agentId}`);
    return false;
  }

  const primary = agent.discord_prefer_alt ? agent.discord_channel_id_alt : agent.discord_channel_id;
  const fallback = agent.discord_prefer_alt ? agent.discord_channel_id : agent.discord_channel_id_alt;

  if (primary) {
    const ok = await sendDiscordMessage(primary, text);
    if (ok) return true;
    console.error(`[discord-announce] Primary channel failed for ${agentId}, trying fallback`);
  }

  if (fallback) {
    const ok = await sendDiscordMessage(fallback, text);
    if (ok) return true;
    console.error(`[discord-announce] Fallback channel also failed for ${agentId}`);
  }

  console.error(`[discord-announce] No working channel for agent: ${agentId}`);
  return false;
}
