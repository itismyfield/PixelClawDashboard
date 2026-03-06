import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

interface DiscordChannel {
  id: string;
  guild_id?: string;
  name: string;
  type: number;
  parent_id?: string | null;
  position?: number;
  topic?: string | null;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  permission_overwrites?: unknown[];
}

interface AgentRow {
  id: string;
  name: string;
  openclaw_id: string;
  discord_channel_id: string | null;
}

interface RoleBinding {
  roleId: string;
  promptFile: string;
}

interface RoleMapJson {
  version?: number;
  fallbackByChannelName?: { enabled?: boolean };
  byChannelName?: Record<string, RoleBinding>;
  byChannelId?: Record<string, RoleBinding>;
  meeting?: unknown;
}

interface BotSettingsEntry {
  token?: string;
  provider?: string;
  last_sessions?: Record<string, string>;
  last_remotes?: Record<string, string>;
}

function loadAnnounceToken(): string {
  if (process.env.DISCORD_ANNOUNCE_BOT_TOKEN) {
    return process.env.DISCORD_ANNOUNCE_BOT_TOKEN;
  }
  const envPath = path.join(process.cwd(), ".env");
  const content = fs.readFileSync(envPath, "utf-8");
  const match = content.match(/^DISCORD_ANNOUNCE_BOT_TOKEN=(.+)$/m);
  if (!match) {
    throw new Error("DISCORD_ANNOUNCE_BOT_TOKEN missing from .env");
  }
  return match[1].trim();
}

async function discordRequest<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "pcd-cdx-bootstrap",
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  if (resp.status === 204) {
    return undefined as T;
  }
  return (await resp.json()) as T;
}

async function resolveCodexBotId(): Promise<string | null> {
  const parsed = loadBotSettings();
  const codexToken = Object.values(parsed).find((entry) => entry.provider === "codex")?.token;
  if (!codexToken) return null;
  const me = await discordRequest<{ id: string }>(
    codexToken,
    "https://discord.com/api/v10/users/@me",
  );
  return me.id ?? null;
}

function botSettingsPath(): string {
  return path.join(os.homedir(), ".remotecc", "bot_settings.json");
}

function loadBotSettings(): Record<string, BotSettingsEntry> {
  const settingsPath = botSettingsPath();
  if (!fs.existsSync(settingsPath)) return {};
  return JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, BotSettingsEntry>;
}

function saveBotSessionState(
  entryKey: string,
  lastSessions: Record<string, string>,
  lastRemotes: Record<string, string>,
): void {
  const python = `
import json
import pathlib
import sys

settings_path = pathlib.Path(sys.argv[1])
entry_key = sys.argv[2]
last_sessions = json.loads(sys.argv[3])
last_remotes = json.loads(sys.argv[4])

data = json.loads(settings_path.read_text())
entry = data.get(entry_key, {})
entry["last_sessions"] = last_sessions
entry["last_remotes"] = last_remotes
data[entry_key] = entry
settings_path.write_text(json.dumps(data, indent=2) + "\\n")
`;
  execFileSync(
    "python3",
    [
      "-c",
      python,
      botSettingsPath(),
      entryKey,
      JSON.stringify(lastSessions),
      JSON.stringify(lastRemotes),
    ],
    { stdio: "pipe" },
  );
}

async function ensureCodexBotAccess(token: string, channelId: string, botId: string): Promise<void> {
  const allow =
    64n + // Add Reactions
    1024n + // View Channel
    2048n + // Send Messages
    16384n + // Embed Links
    32768n + // Attach Files
    65536n + // Read Message History
    2147483648n; // Use Application Commands
  await discordRequest<unknown>(
    token,
    `https://discord.com/api/v10/channels/${channelId}/permissions/${botId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        type: 1,
        allow: allow.toString(),
        deny: "0",
      }),
    },
  );
}

function loadRoleMap(): { roleMapPath: string; roleMap: RoleMapJson } {
  const roleMapPath = path.join(os.homedir(), ".remotecc", "role_map.json");
  const raw = fs.readFileSync(roleMapPath, "utf-8");
  return { roleMapPath, roleMap: JSON.parse(raw) as RoleMapJson };
}

function saveRoleMap(roleMapPath: string, roleMap: RoleMapJson): void {
  fs.writeFileSync(roleMapPath, `${JSON.stringify(roleMap, null, 2)}\n`);
}

function buildBinding(openclawId: string): RoleBinding {
  return {
    roleId: openclawId,
    promptFile: path.join(os.homedir(), ".remotecc", "role-context", `${openclawId}.prompt.md`),
  };
}

function deriveCodexName(ccName: string): string {
  if (!ccName.endsWith("-cc")) {
    throw new Error(`expected -cc suffix, got ${ccName}`);
  }
  return `${ccName.slice(0, -3)}-cdx`;
}

function loadAgents(dbPath: string): AgentRow[] {
  const db = new DatabaseSync(dbPath);
  return db
    .prepare(
      `SELECT id, name, openclaw_id, discord_channel_id
       FROM agents
       WHERE openclaw_id LIKE 'ch-%'
         AND discord_channel_id IS NOT NULL
       ORDER BY name`,
    )
    .all() as unknown as AgentRow[];
}

function compareChannelPosition(a?: DiscordChannel, b?: DiscordChannel): number {
  return (a?.position ?? 0) - (b?.position ?? 0);
}

async function main(): Promise<void> {
  const token = loadAnnounceToken();
  const codexBotId = await resolveCodexBotId();
  const dbPath = path.join(process.cwd(), "pixel-claw-dashboard.sqlite");
  const db = new DatabaseSync(dbPath);
  const agentCols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  const canUpdateCodexChannel = agentCols.some((col) => col.name === "discord_channel_id_codex");
  const agents = loadAgents(dbPath);
  if (agents.length === 0) {
    throw new Error("No channel-backed ch-* agents found");
  }

  const seedChannelId = agents[0]?.discord_channel_id;
  if (!seedChannelId) {
    throw new Error("No seed channel found");
  }

  const seedChannel = await discordRequest<DiscordChannel>(
    token,
    `https://discord.com/api/v10/channels/${seedChannelId}`,
  );
  if (!seedChannel.guild_id) {
    throw new Error("Seed channel does not belong to a guild");
  }

  const guildChannels = await discordRequest<DiscordChannel[]>(
    token,
    `https://discord.com/api/v10/guilds/${seedChannel.guild_id}/channels`,
  );
  const channelById = new Map(guildChannels.map((channel) => [channel.id, channel]));
  const channelByName = new Map(guildChannels.map((channel) => [channel.name, channel]));

  const { roleMapPath, roleMap } = loadRoleMap();
  roleMap.byChannelName ??= {};
  roleMap.byChannelId ??= {};

  const created: Array<{ source: string; target: string; id: string; roleId: string }> = [];
  const reused: Array<{ source: string; target: string; id: string; roleId: string }> = [];
  const skipped: Array<{ agent: string; reason: string }> = [];
  const updatedAgents: Array<{ agentId: string; openclawId: string; codexChannelId: string }> = [];
  const updatedCategoryAccess: string[] = [];
  const grantedCategoryIds = new Set<string>();
  const updatedBotSettings: Array<{ channelId: string; path: string; clearedRemote: boolean }> = [];

  const botSettings = loadBotSettings();
  const codexMatch = Object.entries(botSettings).find(([, entry]) => entry.provider === "codex");
  const codexKey = codexMatch?.[0] ?? null;
  const codexEntry = codexMatch?.[1] ?? null;
  const claudeEntries = Object.values(botSettings).filter((entry) => entry.provider === "claude");
  const fallbackLocalPath =
    Object.values(codexEntry?.last_sessions ?? {}).find((value) => path.isAbsolute(value))
    ?? claudeEntries
      .flatMap((entry) => Object.values(entry.last_sessions ?? {}))
      .find((value) => path.isAbsolute(value))
    ?? null;
  if (codexEntry) {
    codexEntry.last_sessions ??= {};
    codexEntry.last_remotes ??= {};
  }

  const candidates = agents
    .filter((agent) => {
      const channel = agent.discord_channel_id ? channelById.get(agent.discord_channel_id) : undefined;
      return Boolean(channel?.name.startsWith("cookingheart-") && channel.name.endsWith("-cc"));
    })
    .sort((a, b) => {
      const ca = a.discord_channel_id ? channelById.get(a.discord_channel_id) : undefined;
      const cb = b.discord_channel_id ? channelById.get(b.discord_channel_id) : undefined;
      return compareChannelPosition(ca, cb);
    });

  for (const agent of candidates) {
    const ccChannel = agent.discord_channel_id ? channelById.get(agent.discord_channel_id) : undefined;
    if (!ccChannel) {
      skipped.push({ agent: agent.openclaw_id, reason: "primary channel missing in guild" });
      continue;
    }

    const cdxName = deriveCodexName(ccChannel.name);
    let cdxChannel = channelByName.get(cdxName);
    const legacyDxName = `${ccChannel.name.slice(0, -3)}-dx`;
    const legacyDxChannel = channelByName.get(legacyDxName);

    if (!cdxChannel && legacyDxChannel) {
      cdxChannel = await discordRequest<DiscordChannel>(
        token,
        `https://discord.com/api/v10/channels/${legacyDxChannel.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: cdxName }),
        },
      );
      channelByName.delete(legacyDxName);
      channelByName.set(cdxName, cdxChannel);
      channelById.set(cdxChannel.id, cdxChannel);
    }

    if (!cdxChannel) {
      cdxChannel = await discordRequest<DiscordChannel>(
        token,
        `https://discord.com/api/v10/guilds/${seedChannel.guild_id}/channels`,
        {
          method: "POST",
          body: JSON.stringify({
            name: cdxName,
            type: 0,
            parent_id: ccChannel.parent_id ?? null,
            topic: ccChannel.topic ?? null,
            nsfw: ccChannel.nsfw ?? false,
            rate_limit_per_user: ccChannel.rate_limit_per_user ?? 0,
            permission_overwrites: ccChannel.permission_overwrites ?? [],
            position: (ccChannel.position ?? 0) + 1,
          }),
        },
      );
      channelByName.set(cdxName, cdxChannel);
      channelById.set(cdxChannel.id, cdxChannel);
      created.push({
        source: ccChannel.name,
        target: cdxName,
        id: cdxChannel.id,
        roleId: agent.openclaw_id,
      });
    } else {
      reused.push({
        source: ccChannel.name,
        target: cdxName,
        id: cdxChannel.id,
        roleId: agent.openclaw_id,
      });
    }

    if (codexBotId) {
      if (ccChannel.parent_id && !grantedCategoryIds.has(ccChannel.parent_id)) {
        await ensureCodexBotAccess(token, ccChannel.parent_id, codexBotId);
        grantedCategoryIds.add(ccChannel.parent_id);
        updatedCategoryAccess.push(ccChannel.parent_id);
      }
      await ensureCodexBotAccess(token, cdxChannel.id, codexBotId);
    }

    const binding = buildBinding(agent.openclaw_id);
    roleMap.byChannelName[ccChannel.name] = binding;
    roleMap.byChannelId[ccChannel.id] = binding;
    delete roleMap.byChannelName[legacyDxName];
    roleMap.byChannelName[cdxName] = binding;
    roleMap.byChannelId[cdxChannel.id] = binding;

    if (canUpdateCodexChannel) {
      db.prepare(
        "UPDATE agents SET discord_channel_id_codex = ? WHERE id = ?",
      ).run(cdxChannel.id, agent.id);
      updatedAgents.push({
        agentId: agent.id,
        openclawId: agent.openclaw_id,
        codexChannelId: cdxChannel.id,
      });
    }

    if (codexEntry) {
      const sourceLocalPath = claudeEntries
        .map((entry) => entry.last_sessions?.[ccChannel.id])
        .find((value): value is string => Boolean(value && path.isAbsolute(value)));
      const targetPath = sourceLocalPath ?? fallbackLocalPath;
      if (targetPath) {
        codexEntry.last_sessions![cdxChannel.id] = targetPath;
      }
      const clearedRemote = Object.prototype.hasOwnProperty.call(codexEntry.last_remotes!, cdxChannel.id);
      delete codexEntry.last_remotes![cdxChannel.id];
      if (targetPath || clearedRemote) {
        updatedBotSettings.push({
          channelId: cdxChannel.id,
          path: codexEntry.last_sessions![cdxChannel.id] ?? "(unchanged)",
          clearedRemote,
        });
      }
    }
  }

  saveRoleMap(roleMapPath, roleMap);
  if (codexKey && codexEntry) {
    saveBotSessionState(codexKey, codexEntry.last_sessions ?? {}, codexEntry.last_remotes ?? {});
  }

  console.log(
    JSON.stringify(
      {
        guildId: seedChannel.guild_id,
        created,
        reused,
        skipped,
        updatedAgents,
        updatedCategoryAccess,
        updatedBotSettings,
        codexBotId,
        updatedRoleMap: roleMapPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
