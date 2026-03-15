import { useCallback, useEffect, useRef, useState } from "react";
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

type ViewMode = "all" | "agent";

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

// ── Draggable Entry Row ──

function EntryRow({
  entry,
  idx,
  tr,
  locale,
  onSkip,
  isDragging,
  isDropTarget,
  dragHandlers,
}: {
  entry: DispatchQueueEntryType;
  idx: number;
  tr: (ko: string, en: string) => string;
  locale: UiLanguage;
  onSkip: (id: string) => void;
  isDragging?: boolean;
  isDropTarget?: boolean;
  dragHandlers?: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
}) {
  const sty = ENTRY_STATUS_STYLE[entry.status] ?? ENTRY_STATUS_STYLE.pending;
  const isPending = entry.status === "pending";

  return (
    <div
      className="flex items-center gap-2 rounded-xl px-3 py-2 border transition-all"
      style={{
        borderColor: isDropTarget
          ? "rgba(139,92,246,0.6)"
          : entry.status === "dispatched"
            ? "rgba(245,158,11,0.3)"
            : "rgba(148,163,184,0.15)",
        backgroundColor: isDragging
          ? "rgba(139,92,246,0.12)"
          : isDropTarget
            ? "rgba(139,92,246,0.08)"
            : entry.status === "dispatched"
              ? "rgba(245,158,11,0.06)"
              : "rgba(2,6,23,0.5)",
        opacity: isDragging ? 0.5 : 1,
        cursor: isPending && dragHandlers?.draggable ? "grab" : undefined,
      }}
      {...(dragHandlers ?? {})}
    >
      {/* Drag handle for pending items */}
      {isPending && dragHandlers?.draggable && (
        <span className="text-[10px] shrink-0 select-none" style={{ color: "var(--th-text-muted)", cursor: "grab" }}>
          ⠿
        </span>
      )}
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
      {isPending && (
        <button
          onClick={() => onSkip(entry.id)}
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
}

// ── Drag & drop hook for a list of entries ──

function useDragReorder(
  entries: DispatchQueueEntryType[],
  onReorder: (orderedIds: string[], agentId?: string | null) => Promise<void>,
  agentId?: string | null,
) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  const pendingEntries = entries.filter((e) => e.status === "pending");

  const makeDragHandlers = (entry: DispatchQueueEntryType) => {
    if (entry.status !== "pending") return undefined;

    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", entry.id);
        dragIdRef.current = entry.id;
        setDragId(entry.id);
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (entry.status === "pending" && entry.id !== dragIdRef.current) {
          setDropTargetId(entry.id);
        }
      },
      onDragLeave: (e: React.DragEvent) => {
        // Only clear if leaving this element entirely
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const { clientX, clientY } = e;
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
          setDropTargetId((prev) => (prev === entry.id ? null : prev));
        }
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const fromId = e.dataTransfer.getData("text/plain");
        const toId = entry.id;
        if (!fromId || fromId === toId || entry.status !== "pending") {
          setDragId(null);
          setDropTargetId(null);
          dragIdRef.current = null;
          return;
        }

        // Compute new order
        const ids = pendingEntries.map((pe) => pe.id);
        const fromIdx = ids.indexOf(fromId);
        const toIdx = ids.indexOf(toId);
        if (fromIdx === -1 || toIdx === -1) {
          setDragId(null);
          setDropTargetId(null);
          dragIdRef.current = null;
          return;
        }

        // Move fromIdx to toIdx
        ids.splice(fromIdx, 1);
        ids.splice(toIdx, 0, fromId);

        setDragId(null);
        setDropTargetId(null);
        dragIdRef.current = null;

        void onReorder(ids, agentId);
      },
      onDragEnd: () => {
        setDragId(null);
        setDropTargetId(null);
        dragIdRef.current = null;
      },
    };
  };

  return { dragId, dropTargetId, makeDragHandlers };
}

// ── Main Panel ──

export default function AutoQueuePanel({ tr, locale, agents, selectedRepo }: Props) {
  const [status, setStatus] = useState<AutoQueueStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("agent");
  const [dryRunning, setDryRunning] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<api.DryRunEntry[] | null>(null);

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const fetchStatus = useCallback(async () => {
    try {
      const s = await api.getAutoQueueStatus(selectedRepo || null);
      setStatus(s);
    } catch {
      // silent
    }
  }, [selectedRepo]);

  useEffect(() => {
    void fetchStatus();
    const timer = setInterval(() => void fetchStatus(), 30_000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  const getAgentLabel = (agentId: string) => {
    const agent = agentMap.get(agentId);
    return agent ? localeName(locale, agent) : agentId.slice(0, 8);
  };

  const handleDryRun = async () => {
    setDryRunning(true);
    setError(null);
    setDryRunResult(null);
    try {
      const result = await api.dryRunAutoQueue(selectedRepo || null);
      setDryRunResult(result.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("미리보기 실패", "Dry run failed"));
    } finally {
      setDryRunning(false);
    }
  };

  const handleConfirmGenerate = async () => {
    if (!dryRunResult) return;
    setGenerating(true);
    setError(null);
    try {
      await api.confirmAutoQueue(selectedRepo || null, dryRunResult);
      setDryRunResult(null);
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
      await api.activateAutoQueue(selectedRepo || null);
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

  const handleReorder = async (orderedIds: string[], agentId?: string | null) => {
    try {
      await api.reorderAutoQueueEntries(orderedIds, agentId);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("순서 변경 실패", "Reorder failed"));
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

  // All-queue view: merge all entries sorted by status then rank
  const allEntriesSorted = [...entries].sort((a, b) => {
    const statusOrder: Record<string, number> = { dispatched: 0, pending: 1, done: 2, skipped: 3 };
    const sa = statusOrder[a.status] ?? 1;
    const sb = statusOrder[b.status] ?? 1;
    if (sa !== sb) return sa - sb;
    return a.priority_rank - b.priority_rank;
  });

  // Drag & drop for "all" view (pending only, no agent scope)
  const allDrag = useDragReorder(allEntriesSorted, handleReorder);

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
          {(!run || run.status === "completed") && !dryRunResult && (
            <button
              onClick={() => void handleDryRun()}
              disabled={dryRunning}
              className="text-[11px] px-2.5 py-1 rounded-lg border font-medium"
              style={{
                borderColor: "rgba(139,92,246,0.4)",
                color: "#a78bfa",
                backgroundColor: "rgba(139,92,246,0.1)",
              }}
            >
              {dryRunning ? tr("AI 분석 중…", "Analyzing…") : tr("미리보기", "Preview")}
            </button>
          )}
          {dryRunResult && (
            <>
              <button
                onClick={() => void handleConfirmGenerate()}
                disabled={generating}
                className="text-[11px] px-2.5 py-1 rounded-lg border font-medium"
                style={{
                  borderColor: "rgba(34,197,94,0.4)",
                  color: "#4ade80",
                  backgroundColor: "rgba(34,197,94,0.1)",
                }}
              >
                {generating ? "…" : tr("확정", "Confirm")}
              </button>
              <button
                onClick={() => setDryRunResult(null)}
                className="text-[11px] px-2 py-1 rounded-lg border"
                style={{ borderColor: "rgba(148,163,184,0.22)", color: "var(--th-text-muted)" }}
              >
                {tr("취소", "Cancel")}
              </button>
            </>
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

      {/* Dry-run preview */}
      {dryRunResult && (
        <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: "rgba(139,92,246,0.3)", backgroundColor: "rgba(139,92,246,0.05)" }}>
          <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "#a78bfa" }}>
            {tr("미리보기", "Preview")} — {dryRunResult.length}{tr("건", " items")}
          </div>
          {(() => {
            const byAgent = new Map<string, typeof dryRunResult>();
            for (const e of dryRunResult) {
              const list = byAgent.get(e.agent_id) ?? [];
              list.push(e);
              byAgent.set(e.agent_id, list);
            }
            return Array.from(byAgent.entries()).map(([agentId, items]) => (
              <div key={agentId} className="space-y-1">
                <div className="text-[10px] font-medium" style={{ color: "var(--th-text-secondary)" }}>
                  {items[0].agent_name ?? getAgentLabel(agentId)}
                </div>
                {items.sort((a, b) => a.rank - b.rank).map((e) => (
                  <div key={e.card_id} className="flex items-start gap-2 text-[11px]" style={{ color: "var(--th-text-primary)" }}>
                    <span className="shrink-0 w-4 text-right" style={{ color: "#a78bfa" }}>{e.rank}.</span>
                    <div className="flex-1">
                      <div>{e.github_issue_number ? `#${e.github_issue_number} ` : ""}{e.card_title}</div>
                      {e.reason && (
                        <div className="text-[10px] mt-0.5" style={{ color: "var(--th-text-muted)" }}>{e.reason}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ));
          })()}
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

      {/* Expanded: queue entries */}
      {expanded && (
        <div className="space-y-3">
          {/* View mode toggle + Agent summary chips */}
          {totalCount > 0 && (
            <div className="flex items-center justify-between gap-2 flex-wrap">
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

              {/* View mode toggle */}
              {Object.keys(agentStats).length > 1 && (
                <div
                  className="inline-flex rounded-lg border overflow-hidden"
                  style={{ borderColor: "rgba(148,163,184,0.22)" }}
                >
                  <button
                    onClick={() => setViewMode("all")}
                    className="text-[10px] px-2 py-1 transition-colors"
                    style={{
                      backgroundColor: viewMode === "all" ? "rgba(139,92,246,0.2)" : "transparent",
                      color: viewMode === "all" ? "#a78bfa" : "var(--th-text-muted)",
                    }}
                  >
                    {tr("전체", "All")}
                  </button>
                  <button
                    onClick={() => setViewMode("agent")}
                    className="text-[10px] px-2 py-1 transition-colors"
                    style={{
                      backgroundColor: viewMode === "agent" ? "rgba(139,92,246,0.2)" : "transparent",
                      color: viewMode === "agent" ? "#a78bfa" : "var(--th-text-muted)",
                    }}
                  >
                    {tr("에이전트별", "By Agent")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── All view: merged list with drag & drop ── */}
          {viewMode === "all" && (
            <div className="space-y-1">
              {allEntriesSorted.map((entry, idx) => (
                <div key={entry.id} className="flex items-center gap-1">
                  <span
                    className="text-[9px] px-1.5 py-0.5 rounded shrink-0 max-w-[60px] truncate"
                    style={{ backgroundColor: "rgba(139,92,246,0.12)", color: "#a78bfa" }}
                  >
                    {getAgentLabel(entry.agent_id)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <EntryRow
                      entry={entry}
                      idx={idx}
                      tr={tr}
                      locale={locale}
                      onSkip={handleSkip}
                      isDragging={allDrag.dragId === entry.id}
                      isDropTarget={allDrag.dropTargetId === entry.id}
                      dragHandlers={allDrag.makeDragHandlers(entry)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Agent view: grouped by agent with per-agent drag & drop ── */}
          {viewMode === "agent" && Array.from(entriesByAgent.entries()).map(([agentId, agentEntries]) => (
            <AgentSubQueue
              key={agentId}
              agentId={agentId}
              agentEntries={agentEntries}
              getAgentLabel={getAgentLabel}
              tr={tr}
              locale={locale}
              onSkip={handleSkip}
              onReorder={handleReorder}
            />
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

// ── Agent sub-queue with its own drag & drop scope ──

function AgentSubQueue({
  agentId,
  agentEntries,
  getAgentLabel,
  tr,
  locale,
  onSkip,
  onReorder,
}: {
  agentId: string;
  agentEntries: DispatchQueueEntryType[];
  getAgentLabel: (id: string) => string;
  tr: (ko: string, en: string) => string;
  locale: UiLanguage;
  onSkip: (id: string) => void;
  onReorder: (orderedIds: string[], agentId?: string | null) => Promise<void>;
}) {
  const drag = useDragReorder(agentEntries, onReorder, agentId);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 px-1">
        <div className="text-[11px] font-medium" style={{ color: "var(--th-text-muted)" }}>
          {getAgentLabel(agentId)}
        </div>
        <div className="flex-1 h-px" style={{ backgroundColor: "rgba(148,163,184,0.15)" }} />
        <div className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
          {agentEntries.filter((e) => e.status === "done").length}/{agentEntries.length}
        </div>
      </div>
      {/* Per-agent progress bar */}
      {agentEntries.length > 1 && (
        <div className="flex gap-0.5 h-1 rounded-full overflow-hidden bg-white/5 mx-1">
          {(() => {
            const ad = agentEntries.filter((e) => e.status === "done").length;
            const aa = agentEntries.filter((e) => e.status === "dispatched").length;
            const as_ = agentEntries.filter((e) => e.status === "skipped").length;
            const at = agentEntries.length;
            return (
              <>
                {ad > 0 && <div className="rounded-full" style={{ width: `${(ad / at) * 100}%`, backgroundColor: "#4ade80" }} />}
                {aa > 0 && <div className="rounded-full" style={{ width: `${(aa / at) * 100}%`, backgroundColor: "#fbbf24" }} />}
                {as_ > 0 && <div className="rounded-full" style={{ width: `${(as_ / at) * 100}%`, backgroundColor: "#6b7280" }} />}
              </>
            );
          })()}
        </div>
      )}
      {agentEntries.map((entry, idx) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          idx={idx}
          tr={tr}
          locale={locale}
          onSkip={onSkip}
          isDragging={drag.dragId === entry.id}
          isDropTarget={drag.dropTargetId === entry.id}
          dragHandlers={drag.makeDragHandlers(entry)}
        />
      ))}
    </div>
  );
}
