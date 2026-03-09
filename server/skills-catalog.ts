import fs from "node:fs";
import path from "node:path";
import { CENTRAL_SKILLS_DIR } from "./runtime-paths.js";

export interface CatalogSkill {
  name: string;
  description: string;
}

export function loadSkillDescriptions(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(CENTRAL_SKILLS_DIR)) return out;

  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(CENTRAL_SKILLS_DIR);
  } catch {
    return out;
  }

  for (const dirName of dirs) {
    const skillPath = path.join(CENTRAL_SKILLS_DIR, dirName, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    try {
      const content = fs.readFileSync(skillPath, "utf-8");
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      const desc = fm?.[1]
        .match(/description:\s*(.+)/)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, "");
      if (desc) out.set(dirName.toLowerCase(), desc);
    } catch {
      // ignore malformed skill files
    }
  }

  return out;
}

export function listCentralSkills(): CatalogSkill[] {
  if (!fs.existsSync(CENTRAL_SKILLS_DIR)) return [];
  try {
    return fs
      .readdirSync(CENTRAL_SKILLS_DIR)
      .filter((name) => fs.existsSync(path.join(CENTRAL_SKILLS_DIR, name, "SKILL.md")))
      .sort()
      .map((name) => {
        const skillPath = path.join(CENTRAL_SKILLS_DIR, name, "SKILL.md");
        const content = fs.readFileSync(skillPath, "utf-8");
        const fm = content.match(/^---\n([\s\S]*?)\n---/);
        const description = fm?.[1]
          .match(/description:\s*(.+)/)?.[1]
          ?.trim()
          .replace(/^['"]|['"]$/g, "") ?? "";
        return { name, description };
      });
  } catch {
    return [];
  }
}
