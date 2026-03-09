import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LAUNCH_AGENTS_DIR } from "./runtime-paths.js";

interface CronSchedule {
  kind: "every" | "cron" | "at";
  everyMs?: number;
  cron?: string;
  atMs?: number;
}

interface CronJobState {
  lastStatus?: string;
  lastRunAtMs?: number;
  lastDurationMs?: number;
  nextRunAtMs?: number;
}

interface LaunchdPlist {
  Label?: string;
  ProgramArguments?: string[];
  StartInterval?: number;
  StartCalendarInterval?: Record<string, number> | Array<Record<string, number>>;
  WatchPaths?: string[];
  StandardOutPath?: string;
  StandardErrorPath?: string;
}

const JOB_OVERRIDES: Record<string, { name: string; agentId?: string; description_ko?: string }> = {
  "com.itismyfield.ai-integrated-briefing": {
    name: "매일 09:10·21:10 AI 통합 브리핑 수집·전송",
    agentId: "project-newsbot",
    description_ko: "AI 통합 브리핑",
  },
  "com.itismyfield.banchan-day-reminder.cook": {
    name: "매일 18:00 반찬데이 당일 만들기 알림 전송",
    agentId: "family-routine",
    description_ko: "반찬데이 만들기 알림",
  },
  "com.itismyfield.banchan-day-reminder.prep": {
    name: "매일 08:00 반찬데이 전날 장보기 알림 전송",
    agentId: "family-routine",
    description_ko: "반찬데이 장보기 알림",
  },
  "com.itismyfield.cookingheart-daily-briefing": {
    name: "매일 19:00 CookingHeart 개발 데일리 브리핑 전송",
    agentId: "ch-pmd",
    description_ko: "CookingHeart 개발 데일리 브리핑",
  },
  "com.itismyfield.cookingheart-context-sync": {
    name: "CookingHeart role-context sync",
    agentId: "project-scheduler",
    description_ko: "CookingHeart role-context 동기화",
  },
  "com.itismyfield.cookingheart-issue-sync": {
    name: "하루 4회 CookingHeart 이슈·리마인더 동기화 실행",
    agentId: "ch-pmd",
    description_ko: "CookingHeart 이슈·리마인더 동기화",
  },
  "com.itismyfield.cookingheart-md-autocommit": {
    name: "6시간마다 CookingHeart MD 변경 자동 커밋 및 알림",
    agentId: "ch-pmd",
    description_ko: "CookingHeart MD 자동 커밋",
  },
  "com.itismyfield.family-morning-briefing.obujang": {
    name: "매일 06:30 오부장 모닝 DM 브리핑 전송",
    agentId: "personal-obiseo",
    description_ko: "오부장 모닝 브리핑",
  },
  "com.itismyfield.family-morning-briefing.yohoejang": {
    name: "매일 06:31 요회장 모닝 DM 브리핑 전송",
    agentId: "personal-yobiseo",
    description_ko: "요회장 모닝 브리핑",
  },
  "com.itismyfield.family-profile-probe.obujang": {
    name: "매일 12~20시 사이 랜덤 1회 (오부장) 프로필 보완 질문 DM 발송",
    agentId: "family-counsel",
    description_ko: "가족 프로필 보완 질문",
  },
  "com.itismyfield.family-profile-probe.yohoejang": {
    name: "매일 12~20시 사이 랜덤 1회 (요회장) 프로필 보완 질문 DM 발송",
    agentId: "family-counsel",
    description_ko: "가족 프로필 보완 질문",
  },
  "com.itismyfield.skill-sync": {
    name: "중앙 skill 동기화",
    agentId: "project-scheduler",
    description_ko: "중앙 skill 동기화",
  },
  "com.itismyfield.md-source-relocator": {
    name: "매일 09:30·21:30 OpenClaw·Claude 문서 동기화",
    agentId: "project-scheduler",
    description_ko: "Markdown source 동기화",
  },
  "com.itismyfield.orchestration-state-snapshot": {
    name: "매일 03:00 orchestration 상태 스냅샷 백업",
    agentId: "project-scheduler",
    description_ko: "orchestration 상태 스냅샷",
  },
};

function readLaunchdPlist(plistPath: string): LaunchdPlist | null {
  try {
    const json = execFileSync(
      "plutil",
      ["-convert", "json", "-o", "-", plistPath],
      { encoding: "utf-8" },
    );
    return JSON.parse(json) as LaunchdPlist;
  } catch {
    return null;
  }
}

function getLoadedLabels(): Set<string> {
  try {
    const raw = execFileSync("launchctl", ["list"], { encoding: "utf-8" });
    const out = new Set<string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("PID")) continue;
      const parts = trimmed.split(/\s+/);
      const label = parts[parts.length - 1];
      if (label) out.add(label);
    }
    return out;
  } catch {
    return new Set<string>();
  }
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function formatHourSpec(hours: number[]): string {
  if (hours.length === 0) return "*";
  if (hours.length === 1) return String(hours[0]);

  const contiguous = hours.every((hour, idx) => idx === 0 || hour === hours[idx - 1] + 1);
  if (contiguous) return `${hours[0]}-${hours[hours.length - 1]}`;
  return hours.join(",");
}

function formatCalendarSchedule(
  raw: LaunchdPlist["StartCalendarInterval"],
): CronSchedule {
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (entries.length === 0) return { kind: "cron", cron: "launchd" };

  const hours = uniqueSorted(
    entries
      .map((entry) => Number(entry.Hour))
      .filter((value) => Number.isFinite(value)),
  );
  const minutes = uniqueSorted(
    entries
      .map((entry) => Number(entry.Minute))
      .filter((value) => Number.isFinite(value)),
  );

  if (hours.length > 0 && minutes.length > 0) {
    return {
      kind: "cron",
      cron: `${minutes.join(",")} ${formatHourSpec(hours)} * * *`,
    };
  }
  return { kind: "cron", cron: `launchd:${entries.length} slots` };
}

function deriveState(plist: LaunchdPlist): CronJobState | undefined {
  const logPaths = [plist.StandardOutPath, plist.StandardErrorPath].filter(
    (value): value is string => Boolean(value && fs.existsSync(value)),
  );
  if (logPaths.length === 0) return undefined;

  const latest = logPaths
    .map((logPath) => {
      const stat = fs.statSync(logPath);
      return { logPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

  let tail = "";
  try {
    const text = fs.readFileSync(latest.logPath, "utf-8");
    tail = text.slice(-4096);
  } catch {
    // ignore log read failure
  }

  const errorPattern = /\b(ERROR|Traceback|Failed to|discord send failed|"ok"\s*:\s*false)\b/i;
  return {
    lastRunAtMs: Math.floor(latest.mtimeMs),
    lastStatus: tail && errorPattern.test(tail) ? "error" : "ok",
  };
}

function inferMetadata(label: string, plist: LaunchdPlist): { name: string; agentId?: string; description_ko?: string } {
  const override = JOB_OVERRIDES[label];
  if (override) return override;

  const args = plist.ProgramArguments ?? [];
  if (args.some((arg) => arg.includes("run_profile_probe.py"))) {
    return {
      name: label.includes("yohoejang")
        ? "매일 12~20시 사이 랜덤 1회 (요회장) 프로필 보완 질문 DM 발송"
        : "매일 12~20시 사이 랜덤 1회 (오부장) 프로필 보완 질문 DM 발송",
      agentId: "family-counsel",
      description_ko: "가족 프로필 보완 질문",
    };
  }

  const basename = label.startsWith("com.") ? label.split(".").slice(2).join(".") : label;
  return {
    name: basename.replaceAll("-", " "),
  };
}

function inferSchedule(plist: LaunchdPlist): CronSchedule {
  if (typeof plist.StartInterval === "number" && plist.StartInterval > 0) {
    return { kind: "every", everyMs: plist.StartInterval * 1000 };
  }
  if (plist.StartCalendarInterval) {
    return formatCalendarSchedule(plist.StartCalendarInterval);
  }
  if ((plist.WatchPaths ?? []).length > 0) {
    return { kind: "cron", cron: `watch:${plist.WatchPaths!.length}` };
  }
  return { kind: "cron", cron: "launchd" };
}

function isAutomationPlist(plist: LaunchdPlist): boolean {
  return Boolean(plist.StartInterval || plist.StartCalendarInterval || (plist.WatchPaths ?? []).length > 0);
}

export interface LaunchdJobRecord {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  state?: CronJobState;
  description_ko?: string;
  agentId?: string;
  label: string;
  plistPath: string;
}

export function listLaunchdJobs(): LaunchdJobRecord[] {
  if (!fs.existsSync(LAUNCH_AGENTS_DIR)) return [];

  const loadedLabels = getLoadedLabels();
  const jobs: LaunchdJobRecord[] = [];

  for (const entry of fs.readdirSync(LAUNCH_AGENTS_DIR).filter((name) => name.endsWith(".plist")).sort()) {
    const plistPath = path.join(LAUNCH_AGENTS_DIR, entry);
    const plist = readLaunchdPlist(plistPath);
    if (!plist?.Label || !isAutomationPlist(plist)) continue;
    if (!plist.Label.startsWith("com.itismyfield.")) continue;
    if (plist.Label === "com.itismyfield.codex-3am-resume") continue;

    const meta = inferMetadata(plist.Label, plist);
    jobs.push({
      id: plist.Label,
      label: plist.Label,
      plistPath,
      name: meta.name,
      agentId: meta.agentId,
      enabled: loadedLabels.has(plist.Label),
      schedule: inferSchedule(plist),
      state: deriveState(plist),
      description_ko: meta.description_ko,
    });
  }

  return jobs;
}
