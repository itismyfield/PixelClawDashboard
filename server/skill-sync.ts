import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb } from "./db/runtime.js";
import { broadcast } from "./ws.js";

const OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const SESSIONS_ROOT = path.join(OPENCLAW_HOME, "agents");
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
const SKILL_SYNC_INTERVAL_MS = 60 * 1000; // 1 min

interface AgentMeta {
  id: string;
  name: string;
}

function loadAgentNameMap(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const list = parsed?.agents?.list;
    if (!Array.isArray(list)) return out;

    for (const a of list) {
      if (!a?.id) continue;
      const name = a?.identity?.name || a?.name || a.id;
      out.set(String(a.id), String(name));
    }
  } catch {
    // ignore
  }
  return out;
}

function walkSessionFiles(root: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(root)) return files;

  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl") && full.includes("/sessions/")) {
        files.push(full);
      }
    }
  }
  return files;
}

function extractSkillNamesFromText(text: string): string[] {
  const names = new Set<string>();

  // Use the `xxx` skill
  for (const m of text.matchAll(/Use\s+(?:the\s+)?`([a-z0-9][a-z0-9-]*)`\s+skill/gi)) {
    names.add(m[1].toLowerCase());
  }

  // path .../skills/public/<name>/SKILL.md
  for (const m of text.matchAll(/\/skills\/public\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/gi)) {
    names.add(m[1].toLowerCase());
  }

  // /cc <skill>
  for (const m of text.matchAll(/(?:^|\s)\/cc\s+([a-z0-9][a-z0-9-]*)/gi)) {
    names.add(m[1].toLowerCase());
  }

  return [...names];
}

function parseSkillEventsFromLine(line: string): string[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }

  if (obj?.type !== "message") return [];
  const message = obj?.message;
  if (!message) return [];

  const out = new Set<string>();
  const content = message?.content;

  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof item.text === "string") {
        for (const s of extractSkillNamesFromText(item.text)) out.add(s);
      }
      if (item.type === "toolCall") {
        // In case skill invocation appears as tool call arguments text
        const args = item.arguments;
        if (typeof args === "string") {
          for (const s of extractSkillNamesFromText(args)) out.add(s);
        } else if (args && typeof args === "object") {
          const asText = JSON.stringify(args);
          for (const s of extractSkillNamesFromText(asText)) out.add(s);
        }
      }
    }
  }

  return [...out];
}

function getAgentMetaFromFile(filePath: string, nameMap: Map<string, string>): AgentMeta | null {
  const m = filePath.match(/\/agents\/([^/]+)\/sessions\//);
  if (!m?.[1]) return null;
  const id = m[1];
  return {
    id,
    name: nameMap.get(id) || id,
  };
}

function readNewLines(filePath: string, oldOffset: number): { newOffset: number; lines: string[] } {
  const st = fs.statSync(filePath);
  const fileSize = st.size;
  let offset = oldOffset;
  if (offset > fileSize) offset = 0; // truncated

  if (offset === fileSize) return { newOffset: fileSize, lines: [] };

  const fd = fs.openSync(filePath, "r");
  try {
    const len = fileSize - offset;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, offset);
    const text = buf.toString("utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    return { newOffset: fileSize, lines };
  } finally {
    fs.closeSync(fd);
  }
}

export function syncSkillUsageOnce(): number {
  const db = getDb();
  const files = walkSessionFiles(SESSIONS_ROOT);
  if (files.length === 0) return 0;

  const getOffset = db.prepare("SELECT offset FROM skill_sync_offsets WHERE file_path = ?");
  const setOffset = db.prepare(
    `INSERT INTO skill_sync_offsets (file_path, offset, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET offset=excluded.offset, updated_at=excluded.updated_at`,
  );

  const hasEvent = db.prepare("SELECT 1 FROM skill_usage_events WHERE event_key = ? LIMIT 1");
  const insertEvent = db.prepare(
    `INSERT INTO skill_usage_events (
      event_key, skill_name, session_key, agent_openclaw_id, agent_name, used_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const agentNameMap = loadAgentNameMap();

  let inserted = 0;
  const now = Date.now();

  for (const file of files) {
    let oldOffset = 0;
    const row = getOffset.get(file) as { offset: number } | undefined;
    if (row?.offset) oldOffset = row.offset;

    let newOffset = oldOffset;
    let lines: string[] = [];
    try {
      const read = readNewLines(file, oldOffset);
      newOffset = read.newOffset;
      lines = read.lines;
    } catch {
      continue;
    } finally {
      setOffset.run(file, newOffset, now);
    }

    if (lines.length === 0) continue;

    const agentMeta = getAgentMetaFromFile(file, agentNameMap);
    const sessionKey = path.basename(file, ".jsonl");

    for (const line of lines) {
      const skills = parseSkillEventsFromLine(line);
      if (skills.length === 0) continue;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const msgId = String(obj?.id || "");
      const tsRaw = obj?.timestamp || obj?.message?.timestamp;
      const usedAt = tsRaw ? Date.parse(String(tsRaw)) || now : now;

      for (const skill of skills) {
        const key = `${msgId}:${skill}`;
        if (!msgId) continue;
        if (hasEvent.get(key)) continue;

        insertEvent.run(
          key,
          skill,
          sessionKey,
          agentMeta?.id ?? null,
          agentMeta?.name ?? null,
          usedAt,
        );
        inserted++;
      }
    }
  }

  if (inserted > 0) {
    console.log(`[PCD] skill-sync: inserted ${inserted} event(s)`);
    broadcast("skill_usage_update", { inserted });

    // Update daily_activity from recent skill_usage_events
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dayStart = new Date(today).getTime();
      const dayEnd = dayStart + 86400000;
      const dailyRows = db.prepare(
        `SELECT agent_openclaw_id, COUNT(*) as cnt
         FROM skill_usage_events
         WHERE agent_openclaw_id IS NOT NULL AND used_at >= ? AND used_at < ?
         GROUP BY agent_openclaw_id`,
      ).all(dayStart, dayEnd) as Array<{ agent_openclaw_id: string; cnt: number }>;

      const upsertDaily = db.prepare(
        `INSERT INTO daily_activity (agent_id, date, skill_calls)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id, date) DO UPDATE SET skill_calls = excluded.skill_calls`,
      );
      for (const row of dailyRows) {
        upsertDaily.run(row.agent_openclaw_id, today, row.cnt);
      }
    } catch {
      // ignore daily_activity update errors
    }
  }

  return inserted;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSkillSync(): void {
  syncSkillUsageOnce();
  timer = setInterval(syncSkillUsageOnce, SKILL_SYNC_INTERVAL_MS);
  console.log(`[PCD] skill-sync started (every ${SKILL_SYNC_INTERVAL_MS / 1000}s)`);
}

export function stopSkillSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
