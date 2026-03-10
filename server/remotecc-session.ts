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
  // Provider-aware RemoteCC: "remoteCC-(claude|codex)-channelName"
  const providerMatch = sessionKey.match(/:?(remoteCC-(claude|codex)-(.+))$/i);
  if (providerMatch?.[1]) {
    return {
      tmuxName: providerMatch[1],
      provider: providerMatch[2].toLowerCase() as RemoteCcProvider,
      channelName: providerMatch[3]?.trim() || name?.trim() || null,
    };
  }

  // Local project sessions: "local-project-channelName" (must check before legacy remoteCC
  // because channel names like "remotecc-cc" would otherwise match the legacy regex)
  const localMatch = sessionKey.match(/:?(local-project-(.+))$/i);
  if (localMatch?.[1]) {
    const channelName = localMatch[2]?.trim() || name?.trim() || null;
    return {
      tmuxName: localMatch[1],
      provider: inferProviderFromChannelName(channelName),
      channelName,
    };
  }

  // Legacy RemoteCC: "remoteCC-channelName" (no provider prefix)
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
