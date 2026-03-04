import { useEffect, useRef, useState } from "react";
import type { Agent, Department } from "../../types";
import { localeName } from "../../i18n";
import AgentAvatar from "../AgentAvatar";
import { STATUS_DOT } from "./constants";
import type { Translator } from "./types";
import * as api from "../../api";
import type { CronJob, AgentSkill } from "../../api/client";

interface AgentInfoCardProps {
  agent: Agent;
  spriteMap: Map<string, number>;
  isKo: boolean;
  locale: string;
  tr: Translator;
  departments: Department[];
  onClose: () => void;
  onAgentUpdated?: () => void;
}

function formatSchedule(schedule: CronJob["schedule"], isKo: boolean): string {
  if (schedule.kind === "every" && schedule.everyMs) {
    const mins = Math.round(schedule.everyMs / 60000);
    if (mins >= 60) {
      const hrs = Math.round(mins / 60);
      return isKo ? `${hrs}시간마다` : `Every ${hrs}h`;
    }
    return isKo ? `${mins}분마다` : `Every ${mins}m`;
  }
  if (schedule.kind === "cron" && schedule.cron) {
    return schedule.cron;
  }
  if (schedule.kind === "at" && schedule.atMs) {
    return new Date(schedule.atMs).toLocaleString();
  }
  return schedule.kind;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function timeAgo(ms: number, isKo: boolean): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return isKo ? "방금" : "just now";
  if (mins < 60) return isKo ? `${mins}분 전` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return isKo ? `${hrs}시간 전` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return isKo ? `${days}일 전` : `${days}d ago`;
}

export default function AgentInfoCard({
  agent,
  spriteMap,
  isKo,
  locale,
  tr,
  departments,
  onClose,
  onAgentUpdated,
}: AgentInfoCardProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([]);
  const [sharedSkills, setSharedSkills] = useState<AgentSkill[]>([]);
  const [loadingCron, setLoadingCron] = useState(true);
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [showSharedSkills, setShowSharedSkills] = useState(false);
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasValue, setAliasValue] = useState(agent.alias ?? "");
  const [savingAlias, setSavingAlias] = useState(false);

  const saveAlias = async () => {
    const trimmed = aliasValue.trim();
    const newAlias = trimmed || null;
    if (newAlias === (agent.alias ?? null)) {
      setEditingAlias(false);
      return;
    }
    setSavingAlias(true);
    try {
      await api.updateAgent(agent.id, { alias: newAlias });
      setEditingAlias(false);
      onAgentUpdated?.();
    } catch (e) {
      console.error("Alias save failed:", e);
    } finally {
      setSavingAlias(false);
    }
  };

  const dept = departments.find((d) => d.id === agent.department_id);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    api.getAgentCron(agent.id).then((jobs) => {
      setCronJobs(jobs);
      setLoadingCron(false);
    }).catch(() => setLoadingCron(false));

    api.getAgentSkills(agent.id).then((data) => {
      setAgentSkills(data.skills);
      setSharedSkills(data.sharedSkills);
      setLoadingSkills(false);
    }).catch(() => setLoadingSkills(false));
  }, [agent.id]);

  const statusLabel: Record<string, { ko: string; en: string }> = {
    working: { ko: "근무 중", en: "Working" },
    idle: { ko: "대기", en: "Idle" },
    break: { ko: "휴식", en: "Break" },
    offline: { ko: "오프라인", en: "Offline" },
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "var(--th-modal-overlay)" }}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto overscroll-contain rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-200"
        style={{
          background: "var(--th-card-bg)",
          border: "1px solid var(--th-card-border)",
          backdropFilter: "blur(20px)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-4 p-5"
          style={{ borderBottom: "1px solid var(--th-card-border)" }}
        >
          <div className="relative shrink-0">
            <AgentAvatar agent={agent} spriteMap={spriteMap} size={56} rounded="xl" />
            <div
              className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 ${STATUS_DOT[agent.status] ?? STATUS_DOT.idle}`}
              style={{ borderColor: "var(--th-card-bg)" }}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-base" style={{ color: "var(--th-text-heading)" }}>
              {localeName(locale, agent)}
            </div>
            {(() => {
              const primary = localeName(locale, agent);
              const sub = locale === "en" ? agent.name_ko || "" : agent.name;
              return primary !== sub && sub ? (
                <div className="text-xs mt-0.5" style={{ color: "var(--th-text-muted)" }}>
                  {sub}
                </div>
              ) : null;
            })()}
            <div className="flex items-center gap-1 mt-1">
              {editingAlias ? (
                <input
                  autoFocus
                  value={aliasValue}
                  onChange={(e) => setAliasValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveAlias(); if (e.key === "Escape") { setEditingAlias(false); setAliasValue(agent.alias ?? ""); } }}
                  onBlur={saveAlias}
                  disabled={savingAlias}
                  placeholder={tr("별명 입력", "Enter alias")}
                  className="text-[11px] px-1.5 py-0.5 rounded border outline-none"
                  style={{
                    background: "var(--th-bg-surface)",
                    borderColor: "var(--th-input-border)",
                    color: "var(--th-text-primary)",
                    width: "120px",
                  }}
                />
              ) : (
                <button
                  onClick={() => { setAliasValue(agent.alias ?? ""); setEditingAlias(true); }}
                  className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--th-bg-surface-hover)] transition-colors"
                  style={{ color: agent.alias ? "var(--th-text-secondary)" : "var(--th-text-muted)" }}
                  title={tr("별명 편집", "Edit alias")}
                >
                  {agent.alias ? `aka ${agent.alias}` : `+ ${tr("별명", "alias")}`}
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{
                  background: agent.status === "working" ? "rgba(16,185,129,0.15)" :
                    agent.status === "break" ? "rgba(245,158,11,0.15)" :
                    agent.status === "offline" ? "rgba(239,68,68,0.15)" :
                    "rgba(100,116,139,0.15)",
                  color: agent.status === "working" ? "#34d399" :
                    agent.status === "break" ? "#fbbf24" :
                    agent.status === "offline" ? "#f87171" :
                    "#94a3b8",
                }}
              >
                {isKo ? statusLabel[agent.status]?.ko : statusLabel[agent.status]?.en}
              </span>
              {dept && (
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full"
                  style={{ background: "var(--th-bg-surface)", color: "var(--th-text-muted)" }}
                >
                  {dept.icon} {localeName(locale, dept)}
                </span>
              )}
              {!dept && (
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full"
                  style={{ background: "var(--th-bg-surface)", color: "var(--th-text-muted)" }}
                >
                  {tr("미배정", "Unassigned")}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[var(--th-bg-surface-hover)] transition-colors self-start"
            style={{ color: "var(--th-text-muted)" }}
          >
            ✕
          </button>
        </div>

        {/* Personality */}
        {agent.personality && (
          <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--th-card-border)" }}>
            <div
              className="text-[10px] font-semibold uppercase tracking-widest mb-1.5"
              style={{ color: "var(--th-text-muted)" }}
            >
              {tr("성격 / 역할", "Personality")}
            </div>
            <div
              className="text-xs leading-relaxed whitespace-pre-wrap"
              style={{ color: "var(--th-text-secondary)" }}
            >
              {agent.personality}
            </div>
          </div>
        )}

        {/* Session info */}
        {agent.session_info && (
          <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--th-card-border)" }}>
            <div
              className="text-[10px] font-semibold uppercase tracking-widest mb-1.5"
              style={{ color: "var(--th-text-muted)" }}
            >
              {tr("현재 작업", "Current Session")}
            </div>
            <div
              className="text-xs leading-relaxed"
              style={{ color: "var(--th-text-secondary)" }}
            >
              {agent.session_info}
            </div>
          </div>
        )}

        {/* Cron Jobs */}
        <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--th-card-border)" }}>
          <div
            className="text-[10px] font-semibold uppercase tracking-widest mb-2"
            style={{ color: "var(--th-text-muted)" }}
          >
            {tr("크론 작업", "Cron Jobs")} {!loadingCron && `(${cronJobs.length})`}
          </div>
          {loadingCron ? (
            <div className="text-xs py-2" style={{ color: "var(--th-text-muted)" }}>
              {tr("불러오는 중...", "Loading...")}
            </div>
          ) : cronJobs.length === 0 ? (
            <div className="text-xs py-2" style={{ color: "var(--th-text-muted)" }}>
              {tr("등록된 크론 작업이 없습니다", "No cron jobs")}
            </div>
          ) : (
            <div className="space-y-1.5">
              {cronJobs.map((job) => (
                <div
                  key={job.id}
                  className="flex items-start gap-2 px-2.5 py-2 rounded-lg"
                  style={{ background: "var(--th-bg-surface)" }}
                >
                  <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                    job.enabled
                      ? job.state?.lastStatus === "ok" ? "bg-emerald-400" : "bg-amber-400"
                      : "bg-slate-500"
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-xs font-medium truncate"
                      style={{ color: "var(--th-text-primary)" }}
                      title={job.name}
                    >
                      {job.name}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span
                        className="text-[10px] font-mono"
                        style={{ color: "var(--th-text-muted)" }}
                      >
                        {formatSchedule(job.schedule, isKo)}
                      </span>
                      {job.state?.lastRunAtMs && (
                        <span
                          className="text-[10px]"
                          style={{ color: "var(--th-text-muted)" }}
                        >
                          {tr("최근:", "Last:")} {timeAgo(job.state.lastRunAtMs, isKo)}
                          {job.state.lastDurationMs != null && ` (${formatDuration(job.state.lastDurationMs)})`}
                        </span>
                      )}
                    </div>
                  </div>
                  {!job.enabled && (
                    <span
                      className="text-[9px] px-1.5 py-0.5 rounded shrink-0"
                      style={{ background: "rgba(100,116,139,0.2)", color: "#94a3b8" }}
                    >
                      {tr("비활성", "Off")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Skills */}
        <div className="px-5 py-3">
          <div
            className="text-[10px] font-semibold uppercase tracking-widest mb-2"
            style={{ color: "var(--th-text-muted)" }}
          >
            {tr("스킬", "Skills")}
          </div>
          {loadingSkills ? (
            <div className="text-xs py-2" style={{ color: "var(--th-text-muted)" }}>
              {tr("불러오는 중...", "Loading...")}
            </div>
          ) : agentSkills.length === 0 && sharedSkills.length === 0 ? (
            <div className="text-xs py-2" style={{ color: "var(--th-text-muted)" }}>
              {tr("등록된 스킬이 없습니다", "No skills")}
            </div>
          ) : (
            <div className="space-y-2">
              {agentSkills.length > 0 && (
                <div>
                  <div
                    className="text-[10px] mb-1 font-medium"
                    style={{ color: "var(--th-text-secondary)" }}
                  >
                    {tr("전용 스킬", "Agent-specific")}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {agentSkills.map((skill) => (
                      <span
                        key={skill.name}
                        className="text-[10px] px-2 py-0.5 rounded-full"
                        style={{
                          background: "rgba(99,102,241,0.15)",
                          color: "#a5b4fc",
                        }}
                        title={skill.description}
                      >
                        {skill.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {sharedSkills.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowSharedSkills(!showSharedSkills)}
                    className="text-[10px] font-medium flex items-center gap-1 hover:underline"
                    style={{ color: "var(--th-text-muted)" }}
                  >
                    {tr("공유 스킬", "Shared")} ({sharedSkills.length})
                    <span className="text-[8px]">{showSharedSkills ? "▲" : "▼"}</span>
                  </button>
                  {showSharedSkills && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {sharedSkills.map((skill) => (
                        <span
                          key={skill.name}
                          className="text-[10px] px-2 py-0.5 rounded-full"
                          style={{
                            background: "var(--th-bg-surface)",
                            color: "var(--th-text-muted)",
                          }}
                          title={skill.description}
                        >
                          {skill.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-5 py-3"
          style={{ borderTop: "1px solid var(--th-card-border)" }}
        >
          <div className="flex items-center gap-3">
            {agent.openclaw_id && (
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: "var(--th-bg-surface)", color: "var(--th-text-muted)" }}
              >
                {agent.openclaw_id}
              </span>
            )}
            <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
              XP {agent.stats_xp} | {tr("완료", "Done")} {agent.stats_tasks_done}
            </span>
          </div>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:bg-[var(--th-bg-surface-hover)]"
            style={{ border: "1px solid var(--th-input-border)", color: "var(--th-text-secondary)" }}
          >
            {tr("닫기", "Close")}
          </button>
        </div>
      </div>
    </div>
  );
}
