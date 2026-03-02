import { useCallback, useMemo } from "react";
import type { Agent, DashboardStats, CompanySettings } from "../types";
import { localeName } from "../i18n";
import { useNow, type TFunction, DEPT_COLORS } from "./dashboard/model";
import {
  DashboardHeroHeader,
  DashboardHudStats,
  DashboardRankingBoard,
  type HudStat,
  type RankedAgent,
} from "./dashboard/HeroSections";
import {
  DashboardDeptAndSquad,
  type DepartmentPerformance,
} from "./dashboard/OpsSections";

interface DashboardPageViewProps {
  stats: DashboardStats | null;
  agents: Agent[];
  settings: CompanySettings;
  onNavigateToOffice?: () => void;
}

export default function DashboardPageView({
  stats,
  agents,
  settings,
  onNavigateToOffice,
}: DashboardPageViewProps) {
  const language = settings.language;
  const localeTag = language === "ko" ? "ko-KR" : language === "ja" ? "ja-JP" : language === "zh" ? "zh-CN" : "en-US";
  const numberFormatter = useMemo(() => new Intl.NumberFormat(localeTag), [localeTag]);

  const t: TFunction = useCallback(
    (messages) => messages[language] ?? messages.ko,
    [language],
  );

  const { date, time, briefing } = useNow(localeTag, t);

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--th-text-muted)" }}>
        <div className="text-center">
          <div className="text-4xl mb-4 opacity-30">📊</div>
          <div>Loading stats...</div>
        </div>
      </div>
    );
  }

  // Build HUD stats from DashboardStats
  const hudStats: HudStat[] = [
    {
      id: "total",
      label: t({ ko: "전체 직원", en: "Total Agents", ja: "全エージェント", zh: "全部代理" }),
      value: stats.agents.total,
      sub: t({ ko: "등록된 에이전트", en: "Registered agents", ja: "登録エージェント", zh: "已注册代理" }),
      color: "#60a5fa",
      icon: "👥",
    },
    {
      id: "working",
      label: t({ ko: "근무 중", en: "Working", ja: "作業中", zh: "工作中" }),
      value: stats.agents.working,
      sub: t({ ko: "실시간 활동", en: "Active now", ja: "リアルタイム活動", zh: "当前活跃" }),
      color: "#34d399",
      icon: "💼",
    },
    {
      id: "idle",
      label: t({ ko: "대기", en: "Idle", ja: "待機", zh: "空闲" }),
      value: stats.agents.idle,
      sub: t({ ko: "배치 대기", en: "Awaiting assignment", ja: "配置待ち", zh: "等待分配" }),
      color: "#94a3b8",
      icon: "⏸️",
    },
    {
      id: "dispatched",
      label: t({ ko: "파견 인력", en: "Dispatched", ja: "派遣", zh: "派遣" }),
      value: stats.dispatched_count,
      sub: t({ ko: "외부 세션", en: "External sessions", ja: "外部セッション", zh: "外部会话" }),
      color: "#fbbf24",
      icon: "⚡",
    },
  ];

  // Build ranked agents from stats.top_agents
  const deptMap = new Map(stats.departments.map((d) => [d.id, d]));
  const topAgents: RankedAgent[] = stats.top_agents.map((a) => ({
    id: a.id,
    name: a.name_ko || a.name,
    department: "",
    tasksDone: a.stats_tasks_done,
    xp: a.stats_xp,
  }));

  const podiumOrder: RankedAgent[] =
    topAgents.length >= 3
      ? [topAgents[1], topAgents[0], topAgents[2]]
      : topAgents.length === 2
        ? [topAgents[1], topAgents[0]]
        : [];

  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const maxXp = topAgents.reduce((max, a) => Math.max(max, a.xp), 1);

  // Build dept performance from stats.departments
  const deptData: DepartmentPerformance[] = stats.departments.map((d, i) => ({
    id: d.id,
    name: d.name_ko || d.name,
    icon: d.icon,
    done: d.working_agents,
    total: d.total_agents,
    ratio: d.total_agents > 0 ? Math.round((d.working_agents / d.total_agents) * 100) : 0,
    color: DEPT_COLORS[i % DEPT_COLORS.length],
  }));

  const workingAgents = agents.filter((a) => a.status === "working");
  const idleAgents = agents.filter((a) => a.status !== "working");

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto overflow-auto h-full">
      <DashboardHeroHeader
        companyName={settings.companyName}
        time={time}
        date={date}
        briefing={briefing}
        reviewQueue={0}
        numberFormatter={numberFormatter}
        primaryCtaEyebrow={t({ ko: "오피스 뷰", en: "OFFICE VIEW", ja: "オフィスビュー", zh: "办公室视图" })}
        primaryCtaDescription={t({
          ko: "Pixi.js 오피스에서 에이전트들의 실시간 활동을 확인하세요",
          en: "See real-time agent activity in the Pixi.js office",
          ja: "Pixi.jsオフィスでエージェントのリアルタイム活動を確認",
          zh: "在 Pixi.js 办公室查看代理的实时活动",
        })}
        primaryCtaLabel={t({ ko: "오피스 입장", en: "Enter Office", ja: "オフィスへ", zh: "进入办公室" })}
        onPrimaryCtaClick={onNavigateToOffice ?? (() => {})}
        t={t}
      />

      <DashboardHudStats hudStats={hudStats} numberFormatter={numberFormatter} />

      <DashboardRankingBoard
        topAgents={topAgents}
        podiumOrder={podiumOrder}
        agentMap={agentMap}
        agents={agents}
        maxXp={maxXp}
        numberFormatter={numberFormatter}
        t={t}
      />

      <DashboardDeptAndSquad
        deptData={deptData}
        workingAgents={workingAgents}
        idleAgentsList={idleAgents}
        agents={agents}
        language={language}
        numberFormatter={numberFormatter}
        t={t}
      />
    </div>
  );
}
