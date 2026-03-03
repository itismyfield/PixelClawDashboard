import { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../db/runtime.js";

const router = Router();

const SKILLS_DIR = path.join(os.homedir(), ".openclaw", "workspace", "skills", "public");

const SKILL_DESC_KO: Record<string, string> = {
  "ai-integrated-briefing": "AI 업데이트를 통합 정리하는 브리핑",
  "banchan-day-reminder": "반찬데이 캘린더 기반 알림",
  "family-morning-briefing": "가족 아침 브리핑 생성",
  "family-profile-probe": "가족 프로필 보완 질문",
  "cookingheart-issue-sync": "이슈와 리마인더 동기화",
  "tmux-parallel-watch": "tmux 병렬 작업 완료 감시",
  "checkpoint-save": "중단 지점 저장 및 재개 지원",
  "coupang-cart-routine": "쿠팡 장바구니 자동화",
  "devstack-updater": "개발 도구 스택 업데이트",
  "md-source-relocator": "Markdown 원본 위치 이전/링크 관리",
};

function hasKorean(text: string): boolean {
  return /[가-힣]/.test(text);
}

function loadSkillDescriptions(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(SKILLS_DIR)) return out;

  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(SKILLS_DIR);
  } catch {
    return out;
  }

  for (const d of dirs) {
    const p = path.join(SKILLS_DIR, d, "SKILL.md");
    if (!fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, "utf-8");
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      const desc = fm?.[1].match(/description:\s*(.+)/)?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "";
      if (desc) out.set(d.toLowerCase(), desc);
    } catch {
      // ignore malformed skill files
    }
  }
  return out;
}

function resolveSkillDescKo(skillName: string, descMap: Map<string, string>): string {
  const key = skillName.toLowerCase();
  if (SKILL_DESC_KO[key]) return SKILL_DESC_KO[key];

  const raw = descMap.get(key);
  if (raw && hasKorean(raw)) return raw;
  if (raw) return `${skillName} 관련 자동화`;

  return `${skillName} 실행`;
}

function parseWindowMs(windowRaw: string | undefined): number {
  if (!windowRaw || windowRaw === "all") return 0;
  const v = windowRaw.toLowerCase();
  if (v === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (v === "30d") return 30 * 24 * 60 * 60 * 1000;
  if (v === "90d") return 90 * 24 * 60 * 60 * 1000;
  return 0;
}

router.get("/api/skills/ranking", (req, res) => {
  const db = getDb();
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  const windowMs = parseWindowMs((req.query.window as string) || "7d");
  const since = windowMs > 0 ? Date.now() - windowMs : 0;

  const where = since > 0 ? "WHERE used_at >= ?" : "";
  const args = since > 0 ? [since, limit] : [limit];

  const descMap = loadSkillDescriptions();

  const overallRows = db
    .prepare(
      `SELECT skill_name,
              COUNT(*) AS calls,
              MAX(used_at) AS last_used_at
       FROM skill_usage_events
       ${where}
       GROUP BY skill_name
       ORDER BY calls DESC, last_used_at DESC
       LIMIT ?`,
    )
    .all(...args) as Array<{ skill_name: string; calls: number; last_used_at: number }>;

  const byAgentRows = db
    .prepare(
      `SELECT COALESCE(agent_openclaw_id, 'dispatched') AS agent_openclaw_id,
              COALESCE(agent_name, 'Dispatched') AS agent_name,
              skill_name,
              COUNT(*) AS calls,
              MAX(used_at) AS last_used_at
       FROM skill_usage_events
       ${where}
       GROUP BY COALESCE(agent_openclaw_id, 'dispatched'), COALESCE(agent_name, 'Dispatched'), skill_name
       ORDER BY calls DESC, last_used_at DESC`,
    )
    .all(...(since > 0 ? [since] : [])) as Array<{
      agent_openclaw_id: string;
      agent_name: string;
      skill_name: string;
      calls: number;
      last_used_at: number;
    }>;

  const overall = overallRows.map((r) => ({
    ...r,
    skill_desc_ko: resolveSkillDescKo(r.skill_name, descMap),
  }));

  const byAgent = byAgentRows.map((r) => ({
    ...r,
    skill_desc_ko: resolveSkillDescKo(r.skill_name, descMap),
  }));

  res.json({
    window: windowMs > 0 ? (req.query.window || "7d") : "all",
    overall,
    byAgent,
  });
});

export default router;
