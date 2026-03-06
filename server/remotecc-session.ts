export type RemoteCcProvider = "claude" | "codex";

export interface RemoteCcSessionRef {
  provider: RemoteCcProvider;
  channelName: string | null;
  tmuxName: string | null;
}

function inferProviderFromChannelName(name?: string | null): RemoteCcProvider {
  if (name?.toLowerCase().endsWith("-cdx")) return "codex";
  return "claude";
}

export function parseRemoteCcSessionKey(sessionKey: string, name?: string | null): RemoteCcSessionRef {
  const providerMatch = sessionKey.match(/:?(remoteCC-(claude|codex)-(.+))$/i);
  if (providerMatch?.[1]) {
    return {
      tmuxName: providerMatch[1],
      provider: providerMatch[2].toLowerCase() as RemoteCcProvider,
      channelName: providerMatch[3]?.trim() || name?.trim() || null,
    };
  }

  const legacyMatch = sessionKey.match(/:?(remoteCC-(.+))$/i);
  if (legacyMatch?.[1]) {
    return {
      tmuxName: legacyMatch[1],
      provider: "claude",
      channelName: legacyMatch[2]?.trim() || name?.trim() || null,
    };
  }

  return {
    tmuxName: null,
    provider: inferProviderFromChannelName(name),
    channelName: name?.trim() || null,
  };
}

export function inferRemoteCcProvider(sessionKey: string, name?: string | null, explicit?: string | null): RemoteCcProvider {
  if (explicit === "claude" || explicit === "codex") return explicit;
  return parseRemoteCcSessionKey(sessionKey, name).provider;
}

export function extractTmuxName(sessionKey: string): string | null {
  return parseRemoteCcSessionKey(sessionKey).tmuxName;
}
