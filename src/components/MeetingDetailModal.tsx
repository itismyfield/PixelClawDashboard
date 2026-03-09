import { useEffect, useRef } from "react";
import type { RoundTableMeeting, RoundTableEntry } from "../types";
import MeetingProviderFlow, { formatProviderFlow, providerFlowCaption } from "./MeetingProviderFlow";
import MarkdownContent from "./common/MarkdownContent";

const ROLE_SPRITE_MAP: Record<string, number> = {
  "ch-td": 5,
  "ch-qad": 8,
  "ch-dd": 3,
  "ch-pmd": 7,
  "ch-sd": 2,
  "ch-uxd": 6,
  "ch-devops": 4,
  "ch-sec": 9,
  "ch-data": 10,
};

interface Props {
  meeting: RoundTableMeeting;
  onClose: () => void;
}

export default function MeetingDetailModal({ meeting, onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const entries = meeting.entries || [];
  const rounds = new Set(entries.map((e) => e.round));
  const sortedRounds = Array.from(rounds).sort((a, b) => a - b);

  const spriteNum = (roleId: string | null) => {
    if (!roleId) return 1;
    return ROLE_SPRITE_MAP[roleId] || 1;
  };

  const statusLabel =
    meeting.status === "completed"
      ? "완료"
      : meeting.status === "cancelled"
        ? "취소"
        : "진행중";

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] rounded-2xl border shadow-2xl overflow-hidden flex flex-col"
        style={{ background: "var(--th-surface)", borderColor: "var(--th-border)" }}
      >
        {/* Header */}
        <div className="p-5 border-b flex items-start justify-between gap-3" style={{ borderColor: "var(--th-border)" }}>
          <div className="min-w-0">
            <h2 className="text-lg font-bold" style={{ color: "var(--th-text)" }}>
              {meeting.agenda}
            </h2>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {meeting.participant_names.map((name) => (
                <span
                  key={name}
                  className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                  style={{ background: "rgba(99,102,241,0.15)", color: "#818cf8" }}
                >
                  {name}
                </span>
              ))}
              <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                {new Date(meeting.started_at).toLocaleDateString("ko-KR")}
              </span>
              {(meeting.primary_provider || meeting.reviewer_provider) && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: "rgba(59,130,246,0.12)", color: "#93c5fd" }}>
                  {formatProviderFlow(meeting.primary_provider, meeting.reviewer_provider)}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors shrink-0"
            style={{ color: "var(--th-text-muted)" }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {(meeting.primary_provider || meeting.reviewer_provider) && (
            <div className="rounded-2xl p-4 space-y-2" style={{ background: "rgba(148,163,184,0.08)", border: "1px solid rgba(148,163,184,0.14)" }}>
              <MeetingProviderFlow
                primaryProvider={meeting.primary_provider}
                reviewerProvider={meeting.reviewer_provider}
              />
              <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                {providerFlowCaption(meeting.primary_provider, meeting.reviewer_provider)}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <MetaCard label="상태" value={statusLabel} />
            <MetaCard label="라운드" value={`${meeting.total_rounds}R`} />
            <MetaCard label="참여자" value={`${meeting.participant_names.length}명`} />
            <MetaCard
              label="시작"
              value={new Date(meeting.started_at).toLocaleString("ko-KR", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            />
          </div>

          {meeting.summary ? (
            <div
              className="rounded-2xl p-4 space-y-2"
              style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.18)" }}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#818cf8" }}>
                  Summary
                </div>
                {(meeting.primary_provider || meeting.reviewer_provider) && (
                  <div className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                    {providerFlowCaption(meeting.primary_provider, meeting.reviewer_provider)}
                  </div>
                )}
              </div>
              <MarkdownContent content={meeting.summary} className="text-sm" />
            </div>
          ) : (
            <div
              className="rounded-2xl p-4 text-sm"
              style={{ background: "rgba(148,163,184,0.08)", border: "1px solid rgba(148,163,184,0.14)", color: "var(--th-text-muted)" }}
            >
              {meeting.status === "cancelled"
                ? "취소된 회의라 요약이 생성되지 않았습니다."
                : "아직 요약이 저장되지 않았습니다."}
            </div>
          )}

          {sortedRounds.map((round) => {
            const roundEntries = entries.filter((e) => e.round === round && !e.is_summary);
            const summaryEntries = entries.filter((e) => e.round === round && e.is_summary);

            return (
              <div key={round}>
                {/* Round divider */}
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-1 h-px" style={{ background: "var(--th-border)" }} />
                  <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--th-text-muted)" }}>
                    Round {round}
                  </span>
                  <div className="flex-1 h-px" style={{ background: "var(--th-border)" }} />
                </div>

                {/* Entries */}
                <div className="space-y-3">
                  {roundEntries.map((entry) => (
                    <EntryBubble key={entry.id ?? entry.seq} entry={entry} spriteNum={spriteNum(entry.speaker_role_id)} />
                  ))}
                </div>

                {/* Summary */}
                {summaryEntries.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {summaryEntries.map((entry) => (
                      <div
                        key={entry.id ?? `s-${entry.seq}`}
                        className="rounded-xl p-3 text-sm"
                        style={{ background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)" }}
                      >
                        <div className="text-[10px] font-semibold mb-1" style={{ color: "#818cf8" }}>
                          {entry.speaker_name}
                        </div>
                        <MarkdownContent content={entry.content} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex justify-end p-4 border-t" style={{ borderColor: "var(--th-border)" }}>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-white/5"
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-muted)" }}
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-xl px-3 py-2"
      style={{ background: "var(--th-bg-surface)", border: "1px solid var(--th-border)" }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--th-text-muted)" }}>
        {label}
      </div>
      <div className="text-sm font-medium mt-1" style={{ color: "var(--th-text)" }}>
        {value}
      </div>
    </div>
  );
}

function EntryBubble({ entry, spriteNum }: { entry: RoundTableEntry; spriteNum: number }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="w-8 h-8 rounded-lg overflow-hidden shrink-0" style={{ background: "var(--th-bg-surface)" }}>
        <img
          src={`/sprites/${spriteNum}-D-1.png`}
          alt={entry.speaker_name}
          className="w-full h-full object-cover"
          style={{ imageRendering: "pixelated" }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-semibold mb-0.5" style={{ color: "var(--th-text-muted)" }}>
          {entry.speaker_name}
        </div>
        <div
          className="rounded-xl rounded-tl-sm px-3 py-2 text-sm"
          style={{
            background: "var(--th-bg-surface)",
            border: "1px solid var(--th-border)",
            color: "var(--th-text)",
          }}
        >
          <MarkdownContent content={entry.content} />
        </div>
      </div>
    </div>
  );
}
