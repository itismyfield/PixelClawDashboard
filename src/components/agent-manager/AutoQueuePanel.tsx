import { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import type { AutoQueueStatus, DispatchQueueEntry as DispatchQueueEntryType, AutoQueueRun } from "../../api";
import type { Agent, UiLanguage } from "../../types";
import { localeName } from "../../i18n";

interface Props {
  tr: (ko: string, en: string) => string;
  locale: UiLanguage;
  agents: Agent[];
  selectedRepo: string;
}

function formatTs(value: number | null | undefined, locale: UiLanguage): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

const ENTRY_STATUS_STYLE: Record<string, { bg: string; text: string; label: string; labelEn: string }> = {
  pending: { bg: "rgba(100,116,139,0.18)", text: "#94a3b8", label: "대기", labelEn: "Pending" },
  dispatched: { bg: "rgba(245,158,11,0.18)", text: "#fbbf24", label: "진행", labelEn: "Active" },
  done: { bg: "rgba(34,197,94,0.22)", text: "#4ade80", label: "완료", labelEn: "Done" },
  skipped: { bg: "rgba(107,114,128,0.18)", text: "#9ca3af", label: "건너뜀", labelEn: "Skipped" },
};

export default function AutoQueuePanel({ tr, locale, agents, selectedRepo }: Props) {
  const [status, setStatus] = useState<AutoQueueStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const fetchStatus = useCallback(async () => {
    try {
      const s = await api.getAutoQueueStatus();
      setStatus(s);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const timer = setInterval(() => void fetchStatus(), 30_000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  const getAgentLabel = (agentId: string) => {
    const agent = agentMap.get(agentId);
    return agent ? localeName(locale, agent) : agentId.slice(0, 8);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      await api.generateAutoQueue(selectedRepo || null);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("큐 생성 실패", "Queue generation failed"));
    } finally {
      setGenerating(false);
    }
  };

  const handleActivate = async () => {
    setActivating(true);
    setError(null);
    try {
      await api.activateAutoQueue();
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("활성화 실패", "Activation failed"));
    } finally {
      setActivating(false);
    }
  };

  const handleSkip = async (entryId: string) => {
    try {
      await api.skipAutoQueueEntry(entryId);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("건너뛰기 실패", "Skip failed"));
    }
  };

  const handleRunAction = async (run: AutoQueueRun, action: "paused" | "active" | "completed") => {
    try {
      await api.updateAutoQueueRun(run.id, action);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("상태 변경 실패", "Status change failed"));
    }
  };

  const run = status?.run ?? null;
  const entries = status?.entries ?? [];
  const agentStats: Record<string, { pending: number; dispatched: number; done: number; skipped: number }> = status?.agents ?? {};

  const pendingCount = entries.filter((e) => e.status === "pending").length;
  const dispatchedCount = entries.filter((e) => e.status === "dispatched").length;
  const doneCount = entries.filter((e) => e.status === "done").length;
  const totalCount = entries.length;

  // Group entries by agent
  const entriesByAgent = new Map<string, DispatchQueueEntryType[]>();
  for (const entry of entries) {
    const list = entriesByAgent.get(entry.agent_id) ?? [];
    list.push(entry);
    entriesByAgent.set(entry.agent_id, list);
  }

  return (
    <section
      className="rounded-2xl border p-3 sm:p-4 space-y-3"
      style={{
        borderColor: run ? "rgba(139,92,246,0.35)" : "rgba(148,163,184,0.22)",
        backgroundColor: "rgba(15,23,42,0.65)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button
          onClick={() => setExpanded((p) => !p)}
          className="flex items-center gap-2 min-w-0"
        >
          <span className="text-sm" style={{ color: "var(--th-text-muted)" }}>
            {expanded ? "▾" : "▸"}
          </span>
          <h3 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {tr("자동 큐", "Auto Queue")}
          </h3>
          {run && (
            <span
              className="text-[11px] px-2 py-0.5 rounded-full"
              style={{
                backgroundColor: run.status === "active" ? "rgba(139,92,246,0.2)" : run.status === "paused" ? "rgba(245,158,11,0.2)" : "rgba(34,197,94,0.2)",
                color: run.status === "active" ? "#a78bfa" : run.status === "paused" ? "#fbbf24" : "#4ade80",
              }}
            >
              {run.status === "active" ? tr("실행 중", "Active") : run.status === "paused" ? tr("일시정지", "Paused") : tr("완료", "Done")}
            </span>
          )}
          {totalCount > 0 && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/8" style={{ color: "var(--th-text-muted)" }}>
              {doneCount}/{totalCount}
            </span>
          )}
        </button>

        <div className="flex items-center gap-2">
          {run?.status === "active" && pendingCount > 0 && (
            <button
              onClick={() => void handleActivate()}
              disabled={activating}
              className="text-[11px] px-2.5 py-1 rounded-lg border font-medium"
              style={{
                borderColor: "rgba(245,158,11,0.4)",
                color: "#fbbf24",
                backgroundColor: "rgba(245,158,11,0.1)",
              }}
            >
              {activating ? "…" : tr("디스패치", "Dispatch")}
            </button>
          )}
          {(!run || run.status === "completed") && (
            <button
              onClick={() => void handleGenerate()}
              disabled={generating}
              className="text-[11px] px-2.5 py-1 rounded-lg border font-medium"
              style={{
                borderColor: "rgba(139,92,246,0.4)",
                color: "#a78bfa",
                backgroundColor: "rgba(139,92,246,0.1)",
              }}
            >
              {generating ? tr("AI 분석 중…", "Analyzing…") : tr("큐 생성", "Generate")}
            </button>
          )}
          {run?.status === "active" && (
            <button
              onClick={() => void handleRunAction(run, "paused")}
              className="text-[11px] px-2 py-1 rounded-lg border"
              style={{ borderColor: "rgba(148,163,184,0.22)", color: "var(--th-text-muted)" }}
            >
              {tr("일시정지", "Pause")}
            </button>
          )}
          {run?.status === "paused" && (
            <button
              onClick={() => void handleRunAction(run, "active")}
              className="text-[11px] px-2 py-1 rounded-lg border"
              style={{ borderColor: "rgba(139,92,246,0.3)", color: "#a78bfa" }}
            >
              {tr("재개", "Resume")}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          className="rounded-lg px-3 py-2 text-xs border"
          style={{ borderColor: "rgba(248,113,113,0.4)", color: "#fecaca", backgroundColor: "rgba(127,29,29,0.2)" }}
        >
          {error}
        </div>
      )}

      {/* Progress bar */}
      {totalCount > 0 && (
        <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden bg-white/5">
          {doneCount > 0 && (
            <div
              className="rounded-full"
              style={{ width: `${(doneCount / totalCount) * 100}%`, backgroundColor: "#4ade80" }}
            />
          )}
          {dispatchedCount > 0 && (
            <div
              className="rounded-full"
              style={{ width: `${(dispatchedCount / totalCount) * 100}%`, backgroundColor: "#fbbf24" }}
            />
          )}
          {entries.filter((e) => e.status === "skipped").length > 0 && (
            <div
              className="rounded-full"
              style={{ width: `${(entries.filter((e) => e.status === "skipped").length / totalCount) * 100}%`, backgroundColor: "#6b7280" }}
            />
          )}
        </div>
      )}

      {/* Expanded: per-agent queue entries */}
      {expanded && (
        <div className="space-y-3">
          {/* Agent summary chips */}
          {Object.keys(agentStats).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(agentStats).map(([agentId, stats]) => (
                <div
                  key={agentId}
                  className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg border"
                  style={{ borderColor: "rgba(148,163,184,0.18)", backgroundColor: "rgba(15,23,42,0.5)" }}
                >
                  <span style={{ color: "var(--th-text-secondary)" }}>{getAgentLabel(agentId)}</span>
                  {stats.dispatched > 0 && <span style={{ color: "#fbbf24" }}>{stats.dispatched}</span>}
                  {stats.pending > 0 && <span style={{ color: "#94a3b8" }}>{stats.pending}</span>}
                  <span style={{ color: "#4ade80" }}>{stats.done}</span>
                  {stats.skipped > 0 && <span style={{ color: "#6b7280" }}>-{stats.skipped}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Entry list grouped by agent */}
          {Array.from(entriesByAgent.entries()).map(([agentId, agentEntries]) => (
            <div key={agentId} className="space-y-1">
              <div className="text-[11px] font-medium px-1" style={{ color: "var(--th-text-muted)" }}>
                {getAgentLabel(agentId)}
              </div>
              {agentEntries.map((entry, idx) => {
                const sty = ENTRY_STATUS_STYLE[entry.status] ?? ENTRY_STATUS_STYLE.pending;
                return (
                  <div
                    key={entry.id}
                    className="flex items-center gap-2 rounded-xl px-3 py-2 border"
                    style={{
                      borderColor: entry.status === "dispatched" ? "rgba(245,158,11,0.3)" : "rgba(148,163,184,0.15)",
                      backgroundColor: entry.status === "dispatched" ? "rgba(245,158,11,0.06)" : "rgba(2,6,23,0.5)",
                    }}
                  >
                    <span className="text-[10px] font-mono shrink-0 w-5 text-center" style={{ color: "var(--th-text-muted)" }}>
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs truncate" style={{ color: "var(--th-text-primary)" }}>
                        {entry.card_title ?? entry.card_id.slice(0, 8)}
                        {entry.github_issue_number && (
                          <span className="ml-1" style={{ color: "var(--th-text-muted)" }}>#{entry.github_issue_number}</span>
                        )}
                      </div>
                      {entry.reason && (
                        <div className="text-[10px] truncate" style={{ color: "var(--th-text-muted)" }}>
                          {entry.reason}
                        </div>
                      )}
                    </div>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                      style={{ backgroundColor: sty.bg, color: sty.text }}
                    >
                      {tr(sty.label, sty.labelEn)}
                    </span>
                    {entry.status === "pending" && (
                      <button
                        onClick={() => void handleSkip(entry.id)}
                        className="text-[10px] px-1.5 py-0.5 rounded border shrink-0"
                        style={{ borderColor: "rgba(148,163,184,0.2)", color: "var(--th-text-muted)" }}
                      >
                        {tr("건너뛰기", "Skip")}
                      </button>
                    )}
                    {entry.dispatched_at && (
                      <span className="text-[10px] shrink-0" style={{ color: "var(--th-text-muted)" }}>
                        {formatTs(entry.dispatched_at, locale)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Run metadata */}
          {run && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] px-1" style={{ color: "var(--th-text-muted)" }}>
              <span>AI: {run.ai_model ?? "-"}</span>
              <span>{tr("생성", "Created")}: {formatTs(run.created_at, locale)}</span>
              <span>{tr("타임아웃", "Timeout")}: {run.timeout_minutes}{tr("분", "m")}</span>
              {run.status !== "completed" && (
                <button
                  onClick={() => void handleRunAction(run, "completed")}
                  className="underline"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  {tr("큐 종료", "End queue")}
                </button>
              )}
            </div>
          )}

          {entries.length === 0 && !run && (
            <div className="text-xs text-center py-3" style={{ color: "var(--th-text-muted)" }}>
              {tr("활성 큐 없음. 준비됨 상태의 카드가 있으면 큐를 생성할 수 있습니다.", "No active queue. Generate one when there are ready cards.")}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
