import { useState, useEffect } from "react";
import type { RoundTableMeeting } from "../types";
import { createRoundTableIssues, deleteRoundTableMeeting, getRoundTableMeeting, startRoundTableMeeting } from "../api/client";
import { FileText, Plus, Settings2, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import MeetingDetailModal from "./MeetingDetailModal";

const STORAGE_KEY = "pcd_meeting_channel_id";

interface Props {
  meetings: RoundTableMeeting[];
  onRefresh: () => void;
}

export default function MeetingMinutesView({ meetings, onRefresh }: Props) {
  const [detailMeeting, setDetailMeeting] = useState<RoundTableMeeting | null>(null);
  const [creatingIssue, setCreatingIssue] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expandedIssues, setExpandedIssues] = useState<Set<string>>(new Set());
  const [showStartForm, setShowStartForm] = useState(false);
  const [agenda, setAgenda] = useState("");
  const [channelId, setChannelId] = useState(() => localStorage.getItem(STORAGE_KEY) || "");
  const [primaryProvider, setPrimaryProvider] = useState<"claude" | "codex">("claude");
  const [showChannelEdit, setShowChannelEdit] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (channelId) localStorage.setItem(STORAGE_KEY, channelId);
  }, [channelId]);

  const handleOpenDetail = async (m: RoundTableMeeting) => {
    try {
      const full = await getRoundTableMeeting(m.id);
      setDetailMeeting(full);
    } catch {
      setDetailMeeting(m);
    }
  };

  const handleCreateIssues = async (id: string) => {
    setCreatingIssue(id);
    try {
      await createRoundTableIssues(id);
      onRefresh();
    } catch (e) {
      console.error("Issue creation failed:", e);
    } finally {
      setCreatingIssue(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("이 회의록을 삭제하시겠습니까?")) return;
    setDeleting(id);
    try {
      await deleteRoundTableMeeting(id);
      onRefresh();
    } catch (e) {
      console.error("Delete failed:", e);
    } finally {
      setDeleting(null);
    }
  };

  const toggleIssuePreview = (id: string) => {
    setExpandedIssues((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleStartMeeting = async () => {
    if (!agenda.trim() || !channelId.trim()) return;
    setStarting(true);
    setStartError(null);
    try {
      await startRoundTableMeeting(agenda.trim(), channelId.trim(), primaryProvider);
      setAgenda("");
      setShowStartForm(false);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "회의 시작 실패");
    } finally {
      setStarting(false);
    }
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { bg: string; color: string; label: string }> = {
      completed: { bg: "rgba(16,185,129,0.15)", color: "#34d399", label: "완료" },
      in_progress: { bg: "rgba(245,158,11,0.15)", color: "#fbbf24", label: "진행중" },
      cancelled: { bg: "rgba(239,68,68,0.15)", color: "#f87171", label: "취소" },
    };
    const s = map[status] || map.completed;
    return (
      <span
        className="text-[10px] px-2 py-0.5 rounded-full font-medium"
        style={{ background: s.bg, color: s.color }}
      >
        {s.label}
      </span>
    );
  };

  const inputStyle = { background: "var(--th-bg-surface)", border: "1px solid var(--th-border)", color: "var(--th-text)" };

  const getIssueProgress = (meeting: RoundTableMeeting) => {
    const total = meeting.proposed_issues?.length ?? 0;
    const created = Math.min(meeting.issues_created || 0, total);
    const failed = Math.min(
      meeting.issue_creation_results?.filter((result) => !result.ok).length ?? 0,
      Math.max(total - created, 0),
    );
    const pending = Math.max(total - created - failed, 0);
    return {
      total,
      created,
      failed,
      pending,
      allCreated: total > 0 && created === total,
    };
  };

  return (
    <div
      className="p-4 sm:p-6 max-w-4xl mx-auto overflow-auto h-full pb-40"
      style={{ paddingBottom: "max(10rem, calc(10rem + env(safe-area-inset-bottom)))" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className="text-amber-400" size={24} />
          <h1 className="text-xl font-bold" style={{ color: "var(--th-text-heading)" }}>
            라운드 테이블 회의
          </h1>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(245,158,11,0.15)", color: "#fbbf24" }}>
            {meetings.length}건
          </span>
        </div>
        <button
          onClick={() => setShowStartForm((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors"
        >
          <Plus size={14} />
          새 회의
        </button>
      </div>

      {/* Start meeting form */}
      {showStartForm && (
        <div
          className="rounded-2xl border p-4 sm:p-5 mb-6 space-y-3"
          style={{ background: "var(--th-surface)", borderColor: "var(--th-border)" }}
        >
          <h3 className="text-sm font-semibold" style={{ color: "var(--th-text)" }}>
            회의 시작
          </h3>

          {/* Channel ID row */}
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-widest shrink-0 w-20" style={{ color: "var(--th-text-muted)" }}>
              채널 ID
            </label>
            {showChannelEdit || !channelId ? (
              <input
                type="text"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                placeholder="Discord 채널 ID"
                className="flex-1 px-3 py-1.5 rounded-lg text-xs font-mono"
                style={inputStyle}
                onBlur={() => { if (channelId) setShowChannelEdit(false); }}
                autoFocus
              />
            ) : (
              <div className="flex items-center gap-2 flex-1">
                <span className="text-xs font-mono" style={{ color: "var(--th-text-muted)" }}>
                  {channelId}
                </span>
                <button
                  onClick={() => setShowChannelEdit(true)}
                  className="p-1 rounded hover:bg-white/10 transition-colors"
                  title="채널 ID 변경"
                >
                  <Settings2 size={12} style={{ color: "var(--th-text-muted)" }} />
                </button>
              </div>
            )}
          </div>

          {/* Agenda input */}
          <div className="flex items-start gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-widest shrink-0 w-20 pt-2" style={{ color: "var(--th-text-muted)" }}>
              안건
            </label>
            <input
              type="text"
              value={agenda}
              onChange={(e) => setAgenda(e.target.value)}
              placeholder="회의 안건을 입력하세요"
              className="flex-1 px-3 py-1.5 rounded-lg text-sm"
              style={inputStyle}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) handleStartMeeting(); }}
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-widest shrink-0 w-20" style={{ color: "var(--th-text-muted)" }}>
              진행 모델
            </label>
            <select
              value={primaryProvider}
              onChange={(e) => setPrimaryProvider(e.target.value as "claude" | "codex")}
              className="px-3 py-1.5 rounded-lg text-xs"
              style={inputStyle}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <span className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
              반대 모델이 자동 교차검증
            </span>
          </div>

          {startError && (
            <div className="text-xs px-3 py-1.5 rounded-lg" style={{ background: "rgba(239,68,68,0.1)", color: "#f87171" }}>
              {startError}
            </div>
          )}

          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={() => setShowStartForm(false)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-white/5"
              style={{ borderColor: "var(--th-border)", color: "var(--th-text-muted)" }}
            >
              취소
            </button>
            <button
              onClick={handleStartMeeting}
              disabled={starting || !agenda.trim() || !channelId.trim()}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-40"
            >
              {starting ? "시작 중..." : "회의 시작"}
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {meetings.length === 0 && !showStartForm && (
        <div className="text-center py-16" style={{ color: "var(--th-text-muted)" }}>
          <FileText size={48} className="mx-auto mb-4 opacity-30" />
          <p>회의 기록이 없습니다</p>
          <p className="text-sm mt-1">"새 회의" 버튼으로 라운드 테이블을 시작하세요</p>
        </div>
      )}

      {/* Meeting list */}
      <div className="space-y-4">
        {meetings.map((m) => {
          const hasProposedIssues = m.proposed_issues && m.proposed_issues.length > 0;
          const issuesExpanded = expandedIssues.has(m.id);
          const issueProgress = getIssueProgress(m);
          const canRetryIssues = hasProposedIssues && !issueProgress.allCreated;

          return (
            <div
              key={m.id}
              className="rounded-2xl border p-4 sm:p-5 space-y-3"
              style={{ background: "var(--th-surface)", borderColor: "var(--th-border)" }}
            >
              {/* Top row */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-base" style={{ color: "var(--th-text)" }}>
                    {m.agenda}
                  </h3>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {statusBadge(m.status)}
                    {(m.primary_provider || m.reviewer_provider) && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: "rgba(59,130,246,0.12)", color: "#93c5fd" }}>
                        {`${(m.primary_provider || "unknown").toUpperCase()} -> ${(m.reviewer_provider || "unknown").toUpperCase()}`}
                      </span>
                    )}
                    <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                      {new Date(m.started_at).toLocaleDateString("ko-KR")}
                    </span>
                    {m.total_rounds > 0 && (
                      <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                        {m.total_rounds}R
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(m.id)}
                  disabled={deleting === m.id}
                  className="p-1.5 rounded-lg transition-colors hover:bg-red-500/10 shrink-0"
                  title="삭제"
                >
                  <Trash2 size={14} style={{ color: deleting === m.id ? "var(--th-text-muted)" : "#f87171" }} />
                </button>
              </div>

              {/* Participants */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {m.participant_names.map((name) => (
                  <span
                    key={name}
                    className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                    style={{ background: "rgba(99,102,241,0.15)", color: "#818cf8" }}
                  >
                    {name}
                  </span>
                ))}
              </div>

              {/* PMD Summary bubble */}
              {m.summary && (
                <div className="flex items-start gap-2.5">
                  <div className="w-7 h-7 rounded-lg overflow-hidden shrink-0" style={{ background: "var(--th-bg-surface)" }}>
                    <img
                      src="/sprites/7-D-1.png"
                      alt="PMD"
                      className="w-full h-full object-cover"
                      style={{ imageRendering: "pixelated" }}
                    />
                  </div>
                  <div
                    className="rounded-xl rounded-tl-sm px-3 py-2 text-sm flex-1"
                    style={{
                      background: "rgba(99,102,241,0.08)",
                      border: "1px solid rgba(99,102,241,0.15)",
                      color: "var(--th-text)",
                    }}
                  >
                    <div className="text-[10px] font-semibold mb-1" style={{ color: "#818cf8" }}>PMD 요약</div>
                    <div className="whitespace-pre-wrap">{m.summary}</div>
                  </div>
                </div>
              )}

              {/* Proposed issues preview */}
              {hasProposedIssues && !issueProgress.allCreated && (
                <div>
                  <button
                    onClick={() => toggleIssuePreview(m.id)}
                    className="flex items-center gap-1.5 text-xs font-medium transition-colors hover:opacity-80"
                    style={{ color: "#34d399" }}
                  >
                    {issuesExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    생성될 일감 미리보기 ({m.proposed_issues!.length}건)
                  </button>
                  {issuesExpanded && (
                    <div className="mt-2 space-y-1.5">
                      {m.proposed_issues!.map((issue, i) => (
                        <div
                          key={i}
                          className="rounded-lg px-3 py-2 text-xs"
                          style={{
                            background: "rgba(16,185,129,0.06)",
                            border: "1px solid rgba(16,185,129,0.12)",
                          }}
                        >
                          <div className="font-medium" style={{ color: "var(--th-text)" }}>
                            [RT] {issue.title}
                          </div>
                          <div className="mt-0.5" style={{ color: "var(--th-text-muted)" }}>
                            담당: {issue.assignee}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {hasProposedIssues && (
                <div className="text-xs" style={{ color: issueProgress.failed > 0 ? "#fbbf24" : "var(--th-text-muted)" }}>
                  {issueProgress.allCreated
                    ? `일감 생성 완료 ${issueProgress.created}/${issueProgress.total}`
                    : issueProgress.failed > 0
                      ? `생성 성공 ${issueProgress.created}/${issueProgress.total}, 실패 ${issueProgress.failed}건`
                      : `생성 대기 ${issueProgress.pending}건`}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => handleOpenDetail(m)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-white/5"
                  style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                >
                  상세 보기
                </button>
                {hasProposedIssues ? (
                  <button
                    onClick={() => handleCreateIssues(m.id)}
                    disabled={!canRetryIssues || creatingIssue === m.id}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
                    style={{
                      background: issueProgress.allCreated
                        ? "transparent"
                        : issueProgress.failed > 0
                          ? "rgba(245,158,11,0.15)"
                          : "rgba(16,185,129,0.15)",
                      color: issueProgress.allCreated
                        ? "var(--th-text-muted)"
                        : issueProgress.failed > 0
                          ? "#fbbf24"
                          : "#34d399",
                      border: `1px solid ${issueProgress.allCreated
                        ? "var(--th-border)"
                        : issueProgress.failed > 0
                          ? "rgba(245,158,11,0.3)"
                          : "rgba(16,185,129,0.3)"}`,
                    }}
                  >
                    {issueProgress.allCreated
                      ? `일감 생성 완료 (${issueProgress.created}/${issueProgress.total})`
                      : creatingIssue === m.id
                        ? "생성 중..."
                        : issueProgress.failed > 0
                          ? `실패분 재시도 (${issueProgress.created}/${issueProgress.total})`
                          : `일감 생성 (${issueProgress.total}건)`}
                  </button>
                ) : (
                  m.issues_created ? (
                    <span className="px-3 py-1.5 text-xs font-medium" style={{ color: "var(--th-text-muted)" }}>
                      일감 생성 완료
                    </span>
                  ) : null
                )}
              </div>
            </div>
          );
        })}
      </div>

      {detailMeeting && (
        <MeetingDetailModal
          meeting={detailMeeting}
          onClose={() => setDetailMeeting(null)}
        />
      )}
    </div>
  );
}
