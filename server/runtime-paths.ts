import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CENTRAL_SKILLS_DIR = path.join(
  os.homedir(),
  "ObsidianVault",
  "RemoteVault",
  "99_Skills",
);

export const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");

export const PCD_STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "pixel-claw-dashboard",
);

export const PCD_DISPATCH_DIR = path.join(PCD_STATE_DIR, "dispatch");
export const PCD_HANDOFF_DIR = path.join(PCD_DISPATCH_DIR, "handoff");
export const PCD_HANDOFF_ARCHIVE_DIR = path.join(PCD_HANDOFF_DIR, "archive");

export function ensurePcdRuntimeDirs(): void {
  fs.mkdirSync(PCD_HANDOFF_ARCHIVE_DIR, { recursive: true });
}
