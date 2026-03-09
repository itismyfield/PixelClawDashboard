export const XP_SYNC_STARTED_MESSAGE = "[PCD] XP sync started (hook/session mode)";

export function syncXp(): void {
  // XP is now updated from explicit hook/session events.
}

export function startXpSync(): void {
  console.log(XP_SYNC_STARTED_MESSAGE);
}

export function stopXpSync(): void {
  // no-op
}
