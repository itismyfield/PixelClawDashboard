import { useState, type ReactNode } from "react";
import type { Notification } from "../NotificationCenter";
import type { Agent, AuditLogEntry } from "../../types";
import { getAgentWarnings } from "../../agent-insights";

interface OfficeInsightPanelProps {
  agents: Agent[];
  notifications: Notification[];
  auditLogs: AuditLogEntry[];
  isKo: boolean;
  onSelectAgent?: (agent: Agent) => void;
  docked?: boolean;
}

function timeAgo(ts: number, isKo: boolean): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return isKo ? "방금" : "just now";
  if (mins < 60) return isKo ? `${mins}분 전` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return isKo ? `${hrs}시간 전` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return isKo ? `${days}일 전` : `${days}d ago`;
}

export default function OfficeInsightPanel({
  agents,
  notifications,
  auditLogs,
  isKo,
  onSelectAgent,
  docked = false,
}: OfficeInsightPanelProps) {
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const workingCount = agents.filter((agent) => agent.status === "working").length;
  const remoteCcCount = agents.filter(
    (agent) => agent.activity_source === "remotecc" || agent.activity_source === "both",
  ).length;
  const warningCount = agents.filter((agent) => getAgentWarnings(agent).length > 0).length;
  const warningAgents = agents
    .map((agent) => ({ agent, warnings: getAgentWarnings(agent) }))
    .filter((entry) => entry.warnings.length > 0);
  const recentNotifications = notifications.slice(0, 4);
  const recentChanges = auditLogs.slice(0, 4);
  const rootClassName = docked
    ? "relative z-20 w-full pointer-events-auto"
    : "relative z-20 mb-3 px-3 pt-3 pointer-events-auto sm:absolute sm:left-auto sm:right-3 sm:top-3 sm:mb-0 sm:w-[min(22rem,calc(100vw-1.5rem))] sm:px-0 sm:pt-0";

  return (
    <div className={rootClassName}>
      <div className="sm:hidden">
        <section
          className="rounded-2xl p-3 shadow-xl"
          style={{
            background: "color-mix(in srgb, var(--th-card-bg) 86%, transparent)",
            border: "1px solid var(--th-card-border)",
            backdropFilter: "blur(18px)",
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.24em]" style={{ color: "var(--th-text-muted)" }}>
              {isKo ? "상황판" : "Situation"}
            </div>
            <button
              type="button"
              onClick={() => setMobileExpanded((value) => !value)}
              className="rounded-full px-2 py-1 text-[10px] font-medium"
              style={{
                color: "var(--th-text)",
                background: "var(--th-bg-surface)",
                border: "1px solid var(--th-card-border)",
              }}
            >
              {mobileExpanded ? (isKo ? "접기" : "Hide") : (isKo ? "더보기" : "Details")}
            </button>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <StatChip label={isKo ? "작업중" : "Working"} value={String(workingCount)} color="#34d399" />
            <StatChip label="RemoteCC" value={String(remoteCcCount)} color="#a78bfa" />
            <StatChip
              label={isKo ? "경고" : "Alerts"}
              value={String(warningCount)}
              color="#fbbf24"
              interactive={warningCount > 0}
              onClick={() => setShowWarnings((value) => !value)}
            />
          </div>
          {showWarnings ? (
            <WarningList
              items={warningAgents}
              isKo={isKo}
              onSelectAgent={(agent) => {
                onSelectAgent?.(agent);
                setShowWarnings(false);
              }}
            />
          ) : null}

          {mobileExpanded ? (
            <div className="mt-3 max-h-[38vh] space-y-3 overflow-y-auto pr-1">
              <InsightCard title={isKo ? "최근 이벤트" : "Recent Activity"} count={recentNotifications.length}>
                {recentNotifications.length === 0 ? (
                  <div className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {isKo ? "표시할 런타임 이벤트가 없습니다" : "No runtime events"}
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    {recentNotifications.map((item) => (
                      <EventRow
                        key={item.id}
                        title={item.message}
                        ts={item.ts}
                        isKo={isKo}
                        accent={
                          item.type === "success"
                            ? "#34d399"
                            : item.type === "warning"
                              ? "#fbbf24"
                              : item.type === "error"
                                ? "#f87171"
                                : "#60a5fa"
                        }
                      />
                    ))}
                  </div>
                )}
              </InsightCard>

              <InsightCard title={isKo ? "최근 변경" : "Recent Changes"} count={recentChanges.length}>
                {recentChanges.length === 0 ? (
                  <div className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {isKo ? "표시할 변경 로그가 없습니다" : "No recent changes"}
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    {recentChanges.map((item) => (
                      <EventRow
                        key={item.id}
                        title={item.summary}
                        ts={item.created_at}
                        isKo={isKo}
                        accent="#f59e0b"
                        subtitle={`${item.entity_type}:${item.entity_id}`}
                      />
                    ))}
                  </div>
                )}
              </InsightCard>
            </div>
          ) : null}
        </section>
      </div>

      <div className="hidden sm:flex sm:flex-col sm:gap-3">
        <section
          className="rounded-2xl p-3 shadow-xl"
          style={{
            background: "color-mix(in srgb, var(--th-card-bg) 86%, transparent)",
            border: "1px solid var(--th-card-border)",
            backdropFilter: "blur(18px)",
          }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-[0.24em]" style={{ color: "var(--th-text-muted)" }}>
            {isKo ? "상황판" : "Situation"}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <StatChip label={isKo ? "작업중" : "Working"} value={String(workingCount)} color="#34d399" />
            <StatChip label="RemoteCC" value={String(remoteCcCount)} color="#a78bfa" />
            <StatChip
              label={isKo ? "경고" : "Alerts"}
              value={String(warningCount)}
              color="#fbbf24"
              interactive={warningCount > 0}
              onClick={() => setShowWarnings((value) => !value)}
            />
          </div>
          {showWarnings ? (
            <WarningList
              items={warningAgents}
              isKo={isKo}
              onSelectAgent={(agent) => {
                onSelectAgent?.(agent);
                setShowWarnings(false);
              }}
            />
          ) : null}
        </section>

        <InsightCard title={isKo ? "최근 이벤트" : "Recent Activity"} count={recentNotifications.length}>
          {recentNotifications.length === 0 ? (
            <div className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
              {isKo ? "표시할 런타임 이벤트가 없습니다" : "No runtime events"}
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              {recentNotifications.map((item) => (
                <EventRow
                  key={item.id}
                  title={item.message}
                  ts={item.ts}
                  isKo={isKo}
                  accent={
                    item.type === "success"
                      ? "#34d399"
                      : item.type === "warning"
                        ? "#fbbf24"
                        : item.type === "error"
                          ? "#f87171"
                          : "#60a5fa"
                  }
                />
              ))}
            </div>
          )}
        </InsightCard>

        <InsightCard title={isKo ? "최근 변경" : "Recent Changes"} count={recentChanges.length}>
          {recentChanges.length === 0 ? (
            <div className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
              {isKo ? "표시할 변경 로그가 없습니다" : "No recent changes"}
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              {recentChanges.map((item) => (
                <EventRow
                  key={item.id}
                  title={item.summary}
                  ts={item.created_at}
                  isKo={isKo}
                  accent="#f59e0b"
                  subtitle={`${item.entity_type}:${item.entity_id}`}
                />
              ))}
            </div>
          )}
        </InsightCard>
      </div>
    </div>
  );
}

function InsightCard({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      className="rounded-2xl p-3 shadow-xl"
      style={{
        background: "color-mix(in srgb, var(--th-card-bg) 84%, transparent)",
        border: "1px solid var(--th-card-border)",
        backdropFilter: "blur(18px)",
      }}
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.24em]" style={{ color: "var(--th-text-muted)" }}>
          {title}
        </div>
        <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}

function StatChip({
  label,
  value,
  color,
  interactive = false,
  onClick,
}: {
  label: string;
  value: string;
  color: string;
  interactive?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      className="rounded-xl px-2 py-2 text-left"
      disabled={!interactive}
      style={{
        background: "var(--th-bg-surface)",
        border: "1px solid var(--th-card-border)",
        cursor: interactive ? "pointer" : "default",
        opacity: interactive ? 1 : 1,
      }}
    >
      <div className="text-[9px] uppercase tracking-[0.18em]" style={{ color: "var(--th-text-muted)" }}>
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold" style={{ color }}>
        {value}
      </div>
    </button>
  );
}

function WarningList({
  items,
  isKo,
  onSelectAgent,
}: {
  items: Array<{ agent: Agent; warnings: ReturnType<typeof getAgentWarnings> }>;
  isKo: boolean;
  onSelectAgent?: (agent: Agent) => void;
}) {
  return (
    <div
      className="mt-3 rounded-xl border p-2"
      style={{
        background: "var(--th-bg-surface)",
        borderColor: "var(--th-card-border)",
      }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--th-text-muted)" }}>
        {isKo ? "문제 agent" : "Warning agents"}
      </div>
      {items.length === 0 ? (
        <div className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
          {isKo ? "현재 경고가 없습니다" : "No warnings right now"}
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {items.map(({ agent, warnings }) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelectAgent?.(agent)}
              className="w-full rounded-lg px-2 py-2 text-left"
              style={{ background: "rgba(148,163,184,0.08)" }}
            >
              <div className="text-xs font-medium" style={{ color: "var(--th-text)" }}>
                {agent.avatar_emoji} {agent.alias || agent.name_ko || agent.name}
              </div>
              <div className="mt-0.5 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                {(isKo ? warnings.map((warning) => warning.ko) : warnings.map((warning) => warning.en)).join(", ")}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({
  title,
  subtitle,
  ts,
  isKo,
  accent,
}: {
  title: string;
  subtitle?: string;
  ts: number;
  isKo: boolean;
  accent: string;
}) {
  return (
    <div
      className="rounded-xl px-2.5 py-2"
      style={{ background: "var(--th-bg-surface)" }}
    >
      <div className="flex items-start gap-2">
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
        <div className="min-w-0 flex-1">
          <div className="text-xs leading-relaxed" style={{ color: "var(--th-text-primary)" }}>
            {title}
          </div>
          {subtitle ? (
            <div className="mt-0.5 text-[10px]" style={{ color: "var(--th-text-muted)" }}>
              {subtitle}
            </div>
          ) : null}
          <div className="mt-0.5 text-[10px]" style={{ color: "var(--th-text-muted)" }}>
            {timeAgo(ts, isKo)}
          </div>
        </div>
      </div>
    </div>
  );
}
