/**
 * Seed PixelClawDashboard DB from an external source API.
 * Run: npx tsx server/seed-initial-agents.ts
 */
import { getDb, closeDb } from "./db/runtime.js";

const SOURCE_API_URL = "http://127.0.0.1:8790";

async function getSourceSession(): Promise<string> {
  const res = await fetch(`${SOURCE_API_URL}/api/auth/session`);
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const c of cookies) {
    const m = c.match(/^(claw_session=[^;]+)/);
    if (m) return m[1];
  }
  const raw = res.headers.get("set-cookie") || "";
  const fb = raw.match(/claw_session=[^;]+/);
  return fb?.[0] || "";
}

async function main() {
  const cookie = await getSourceSession();
  const headers: Record<string, string> = {};
  if (cookie) headers["Cookie"] = cookie;

  // Fetch agents
  const agentsRes = await fetch(`${SOURCE_API_URL}/api/agents`, { headers });
  const { agents } = (await agentsRes.json()) as {
    agents: Array<Record<string, unknown>>;
  };

  // Fetch departments
  const deptRes = await fetch(`${SOURCE_API_URL}/api/departments`, { headers });
  const { departments } = (await deptRes.json()) as {
    departments: Array<Record<string, unknown>>;
  };

  const db = getDb();

  // Legacy source-id -> current openclaw_id mapping
  const openclawMapping: Record<string, string> = {
    "e58c1719-aed8-4219-b692-307ac46b08bd": "project-scheduler",
    "2a55915f-3d6f-405d-b52e-886c8424eb2e": "family-routine",
    "7e38d26a-e644-4409-acf2-ff989b1a6285": "family-counsel",
    "cee8c58c-5414-44fd-b601-98a25077a390": "project-newsbot",
    "49e90e1d-c2b6-4f74-83c3-9d15444e85b3": "personal-yobiseo",
    "0ee8b42d-01f1-4d34-a23b-9a5209f881fc": "personal-obiseo",
    "2a4aba20-a68e-4467-a9d0-7ef831e54e4e": "ch-pd",
    "f4fce5f6-9f62-4a8c-92f7-bb7a1a3103fe": "ch-pmd",
    "bf0ee724-e8d4-4b3a-8bfb-5870c36aeeba": "ch-dd",
    "3250399e-6f51-4ec9-bf5d-61aa42c118ce": "ch-td",
    "3c39489a-5356-4ecd-8231-8289dc70bffe": "ch-ad",
    "286c0b0e-135f-4c7f-bd3a-a4cff8d8facc": "ch-tad",
    "4b17f38e-bc6e-48e4-9728-f3dee72c7bbb": "ch-qad",
  };

  // Insert departments
  console.log(`Seeding ${departments.length} departments...`);
  const deptStmt = db.prepare(
    `INSERT OR REPLACE INTO departments (id, name, name_ko, name_ja, name_zh, icon, color, description, workflow_pack_key, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of departments) {
    deptStmt.run(
      d.id as string,
      (d.name as string) || "",
      (d.name_ko as string) || "",
      (d.name_ja as string) || "",
      (d.name_zh as string) || "",
      (d.icon as string) || "",
      (d.color as string) || "#3b82f6",
      (d.description as string) || null,
      (d.workflow_pack_key as string) || null,
      (d.sort_order as number) || 0,
    );
  }

  // Insert agents
  console.log(`Seeding ${agents.length} agents...`);
  const insertAgentStmt = db.prepare(
    `INSERT OR REPLACE INTO agents (id, openclaw_id, name, name_ko, name_ja, name_zh,
      department_id, avatar_emoji, sprite_number, personality, status,
      stats_tasks_done, stats_xp, workflow_pack_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateAgentByOpenclawIdStmt = db.prepare(
    `UPDATE agents
       SET name = ?,
           name_ko = ?,
           name_ja = ?,
           name_zh = ?,
           department_id = ?,
           avatar_emoji = ?,
           sprite_number = ?,
           personality = ?,
           status = ?,
           stats_tasks_done = ?,
           stats_xp = ?,
           workflow_pack_key = ?
     WHERE openclaw_id = ?`,
  );
  for (const a of agents) {
    const sourceAgentId = a.id as string;
    const openclawId = openclawMapping[sourceAgentId] || null;
    const values = [
      (a.name as string) || "",
      (a.name_ko as string) || "",
      (a.name_ja as string) || "",
      (a.name_zh as string) || "",
      (a.department_id as string) || null,
      (a.avatar_emoji as string) || "🙂",
      (a.sprite_number as number) || null,
      (a.personality as string) || null,
      (a.status as string) || "idle",
      (a.stats_tasks_done as number) || 0,
      (a.stats_xp as number) || 0,
      (a.workflow_pack_key as string) || null,
    ] as const;

    if (openclawId) {
      const updated = updateAgentByOpenclawIdStmt.run(...values, openclawId);
      if (updated.changes > 0) {
        continue;
      }
    }

    insertAgentStmt.run(
      sourceAgentId,
      openclawId,
      ...values,
    );
  }

  // Default settings
  const settStmt = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  );
  settStmt.run("companyName", JSON.stringify("PixelClawDashboard"));
  settStmt.run("language", JSON.stringify("ko"));
  settStmt.run("theme", JSON.stringify("dark"));
  settStmt.run("officeWorkflowPack", JSON.stringify("cookingheart"));

  closeDb();
  console.log("Done! Seeded departments and agents from source API.");
}

main().catch(console.error);
