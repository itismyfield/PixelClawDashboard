import { useState, useEffect, useCallback, lazy, Suspense, useRef } from "react";
import type {
  Agent,
  AuditLogEntry,
  Department,
  KanbanCard,
  Office,
  DispatchedSession,
  SubAgent,
  DashboardStats,
  CompanySettings,
  TaskDispatch,
  WSEvent,
  RoundTableMeeting,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import * as api from "./api/client";
const OfficeView = lazy(() => import("./components/OfficeView"));
const DashboardPageView = lazy(() => import("./components/DashboardPageView"));
const AgentManagerView = lazy(() => import("./components/AgentManagerView"));
const MeetingMinutesView = lazy(() => import("./components/MeetingMinutesView"));
const SkillCatalogView = lazy(() => import("./components/SkillCatalogView"));
const SettingsView = lazy(() => import("./components/SettingsView"));
import OfficeSelectorBar from "./components/OfficeSelectorBar";
const OfficeManagerModal = lazy(() => import("./components/OfficeManagerModal"));
const AgentInfoCard = lazy(() => import("./components/agent-manager/AgentInfoCard"));
import { useSpriteMap } from "./components/AgentAvatar";
import NotificationCenter, { type Notification, useNotifications } from "./components/NotificationCenter";
import { useDashboardSocket } from "./app/useDashboardSocket";
import {
  Building2,
  LayoutDashboard,
  Users,
  FileText,
  BookOpen,
  Wifi,
  WifiOff,
  Settings,
  MessageCircle,
} from "lucide-react";
const ChatView = lazy(() => import("./components/ChatView"));
const CommandPalette = lazy(() => import("./components/CommandPalette"));

type ViewMode = "office" | "dashboard" | "agents" | "meetings" | "chat" | "skills" | "settings";

function hasUnresolvedMeetingIssues(meeting: RoundTableMeeting): boolean {
  const totalIssues = meeting.proposed_issues?.length ?? 0;
  if (meeting.status !== "completed" || totalIssues === 0) return false;

  const results = meeting.issue_creation_results ?? [];
  if (results.length === 0) {
    return meeting.issues_created < totalIssues;
  }

  const created = results.filter((result) => result.ok && result.discarded !== true).length;
  const failed = results.filter((result) => !result.ok && result.discarded !== true).length;
  const discarded = results.filter((result) => result.discarded === true).length;
  const pending = Math.max(totalIssues - created - failed - discarded, 0);

  return pending > 0 || failed > 0;
}

export default function App() {
  const [view, setView] = useState<ViewMode>("office");
  const [offices, setOffices] = useState<Office[]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [allDepartments, setAllDepartments] = useState<Department[]>([]);
  const [sessions, setSessions] = useState<DispatchedSession[]>([]);
  const [kanbanCards, setKanbanCards] = useState<KanbanCard[]>([]);
  const [taskDispatches, setTaskDispatches] = useState<TaskDispatch[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [settings, setSettings] = useState<CompanySettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [showOfficeManager, setShowOfficeManager] = useState(false);
  const [officeInfoAgent, setOfficeInfoAgent] = useState<Agent | null>(null);
  const [showCmdPalette, setShowCmdPalette] = useState(false);
  const [roundTableMeetings, setRoundTableMeetings] = useState<RoundTableMeeting[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  const spriteMap = useSpriteMap(agents);
  const { notifications, pushNotification, dismissNotification } = useNotifications();
  const allAgentsRef = useRef<Agent[]>([]);

  useEffect(() => {
    allAgentsRef.current = allAgents;
  }, [allAgents]);

  const refreshAuditLogs = useCallback(() => {
    api.getAuditLogs(12).then(setAuditLogs).catch(() => {});
  }, []);

  // Bootstrap
  useEffect(() => {
    (async () => {
      try {
        await api.getSession();
        const [off, ag, dep, ses, st, set, rtm, logs, cards, dispatches] = await Promise.all([
          api.getOffices(),
          api.getAgents(),
          api.getDepartments(),
          api.getDispatchedSessions(true),
          api.getStats(),
          api.getSettings(),
          api.getRoundTableMeetings().catch(() => [] as RoundTableMeeting[]),
          api.getAuditLogs(12).catch(() => [] as AuditLogEntry[]),
          api.getKanbanCards().catch(() => [] as KanbanCard[]),
          api.getTaskDispatches({ limit: 200 }).catch(() => [] as TaskDispatch[]),
        ]);
        setOffices(off);
        setAllAgents(ag);
        setAgents(ag);
        setAllDepartments(dep);
        setDepartments(dep);
        setSessions(ses);
        setKanbanCards(cards);
        setTaskDispatches(dispatches);
        setStats(st);
        setRoundTableMeetings(rtm);
        setAuditLogs(logs);
        if (set.companyName) {
          setSettings((prev) => ({ ...prev, ...set } as CompanySettings));
        }
        // Auto-select first office if any
        if (off.length > 0) {
          setSelectedOfficeId(off[0].id);
        }
      } catch (e) {
        console.error("Bootstrap failed:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Reload scoped data when office selection changes
  useEffect(() => {
    if (loading) return;
    (async () => {
      try {
        const [ag, dep, st] = await Promise.all([
          api.getAgents(selectedOfficeId ?? undefined),
          api.getDepartments(selectedOfficeId ?? undefined),
          api.getStats(selectedOfficeId ?? undefined),
        ]);
        setAgents(ag);
        setDepartments(dep);
        setStats(st);
      } catch (e) {
        console.error("Office scope reload failed:", e);
      }
    })();
  }, [selectedOfficeId, loading]);

  // G3: Auto theme detection from system preference
  useEffect(() => {
    if (settings.theme !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings.theme]);

  // I7: Global command palette (Cmd+K)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowCmdPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const refreshOffices = useCallback(() => {
    api.getOffices().then(setOffices).catch(() => {});
  }, []);

  const refreshStats = useCallback(() => {
    api.getStats(selectedOfficeId ?? undefined).then(setStats).catch(() => {});
  }, [selectedOfficeId]);

  const refreshAgents = useCallback(() => {
    api.getAgents(selectedOfficeId ?? undefined).then(setAgents).catch(() => {});
  }, [selectedOfficeId]);

  const refreshAllAgents = useCallback(() => {
    api.getAgents().then(setAllAgents).catch(() => {});
  }, []);

  const refreshDepartments = useCallback(() => {
    api.getDepartments(selectedOfficeId ?? undefined).then(setDepartments).catch(() => {});
  }, [selectedOfficeId]);

  const refreshAllDepartments = useCallback(() => {
    api.getDepartments().then(setAllDepartments).catch(() => {});
  }, []);

  const upsertKanbanCard = useCallback((card: KanbanCard) => {
    setKanbanCards((prev) => [card, ...prev.filter((p) => p.id !== card.id)]);
  }, []);

  const upsertTaskDispatch = useCallback((dispatch: TaskDispatch) => {
    setTaskDispatches((prev) => [dispatch, ...prev.filter((p) => p.id !== dispatch.id)].slice(0, 200));
  }, []);

  const handleWsEvent = useCallback((event: WSEvent) => {
    switch (event.type) {
      case "agent_status": {
        const a = event.payload as Agent;
        const previous = allAgentsRef.current.find((agent) => agent.id === a.id);
        const label = a.name_ko || a.name || "agent";
        if (previous?.status !== a.status) {
          if (a.status === "working") {
            pushNotification(`${label}: ${a.session_info || "작업 시작"}`, "info");
          } else if (previous?.status === "working") {
            pushNotification(`${label}: 작업 상태 ${a.status}`, "warning");
          }
        } else if (a.status === "working" && a.session_info && previous?.session_info !== a.session_info) {
          pushNotification(`${label}: ${a.session_info}`, "info");
        }
        setAgents((prev) => prev.map((p) => (p.id === a.id ? { ...p, ...a } : p)));
        setAllAgents((prev) => prev.map((p) => (p.id === a.id ? { ...p, ...a } : p)));
        break;
      }
      case "agent_created": {
        const created = event.payload as Agent;
        pushNotification(`새 에이전트: ${created.name_ko || created.name || "unknown"}`, "success");
        refreshAgents();
        refreshAllAgents();
        refreshAuditLogs();
        break;
      }
      case "agent_deleted":
        setAgents((prev) => prev.filter((a) => a.id !== (event.payload as { id: string }).id));
        setAllAgents((prev) => prev.filter((a) => a.id !== (event.payload as { id: string }).id));
        refreshAuditLogs();
        break;
      case "departments_changed":
        refreshDepartments();
        refreshAuditLogs();
        break;
      case "offices_changed":
        refreshOffices();
        refreshAuditLogs();
        break;
      case "kanban_card_created": {
        const card = event.payload as KanbanCard;
        upsertKanbanCard(card);
        refreshStats();
        if (card.status === "requested") {
          pushNotification(`칸반 요청 발사: ${card.title}`, "info");
        }
        refreshAuditLogs();
        break;
      }
      case "kanban_card_updated": {
        const card = event.payload as KanbanCard;
        upsertKanbanCard(card);
        refreshStats();
        if (card.status === "failed" || card.status === "cancelled") {
          pushNotification(`칸반 상태 변경: ${card.title} → ${card.status}`, "warning");
        }
        refreshAuditLogs();
        break;
      }
      case "kanban_card_deleted":
        setKanbanCards((prev) => prev.filter((card) => card.id !== (event.payload as { id: string }).id));
        refreshStats();
        refreshAuditLogs();
        break;
      case "task_dispatch_created":
        upsertTaskDispatch(event.payload as TaskDispatch);
        break;
      case "task_dispatch_updated":
        upsertTaskDispatch(event.payload as TaskDispatch);
        break;
      case "dispatched_session_new": {
        const ns = event.payload as DispatchedSession;
        setSessions((prev) => [ns, ...prev]);
        pushNotification(`파견 세션 연결: ${ns.name || ns.session_key}`, "info");
        break;
      }
      case "dispatched_session_update":
        setSessions((prev) => {
          const s = event.payload as DispatchedSession;
          return prev.map((p) => (p.id === s.id ? { ...p, ...s } : p));
        });
        break;
      case "dispatched_session_disconnect": {
        const { id } = event.payload as { id: string };
        setSessions((prev) => prev.map((p) => p.id === id ? { ...p, status: "disconnected" as const } : p));
        pushNotification("파견 세션 종료", "warning");
        break;
      }
      case "round_table_new": {
        const m = event.payload as RoundTableMeeting;
        setRoundTableMeetings((prev) => [m, ...prev.filter((p) => p.id !== m.id)]);
        pushNotification(`라운드 테이블: ${m.agenda.slice(0, 30)}`, "info");
        break;
      }
      case "round_table_update": {
        const m = event.payload as RoundTableMeeting;
        setRoundTableMeetings((prev) => prev.map((p) => (p.id === m.id ? { ...p, ...m } : p)));
        break;
      }
    }
  }, [
    pushNotification,
    refreshAgents,
    refreshAllAgents,
    refreshDepartments,
    refreshOffices,
    refreshStats,
    refreshAuditLogs,
    upsertKanbanCard,
    upsertTaskDispatch,
  ]);

  const { wsConnected, wsRef } = useDashboardSocket(handleWsEvent);

  const handleOfficeChanged = useCallback(() => {
    refreshOffices();
    refreshAgents();
    refreshAllAgents();
    refreshDepartments();
    refreshAllDepartments();
    refreshAuditLogs();
  }, [refreshOffices, refreshAgents, refreshAllAgents, refreshDepartments, refreshAllDepartments, refreshAuditLogs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-gray-400">
        <div className="text-center">
          <div className="text-4xl mb-4">🐾</div>
          <div>Loading PixelClawDashboard...</div>
        </div>
      </div>
    );
  }

  const visibleDispatchedSessions = sessions.filter(
    (s) => s.status !== "disconnected" && !s.linked_agent_id,
  );
  const activeSessions = visibleDispatchedSessions;
  const subAgents: SubAgent[] = sessions
    .filter((s) => s.status !== "disconnected" && s.linked_agent_id)
    .map((s) => ({
      id: s.id,
      parentAgentId: s.linked_agent_id!,
      task: s.name || s.session_info || "파견 세션",
      status: "working" as const,
    }));

  // Convert dispatched sessions with department_id into Agent-like objects
  // so they appear in department rooms in OfficeView
  const dispatchedAsAgents: Agent[] = visibleDispatchedSessions
    .filter((s) => s.department_id)
    .map((s) => ({
      id: `dispatched:${s.id}`,
      name: s.name || s.session_key,
      name_ko: s.name || s.session_key,
      department_id: s.department_id,
      role: "intern" as const,
      avatar_emoji: s.avatar_emoji || "📡",
      sprite_number: s.sprite_number,
      personality: null,
      status: s.status === "working" ? ("working" as const) : ("idle" as const),
      current_task_id: null,
      stats_tasks_done: 0,
      stats_xp: s.stats_xp,
      created_at: s.connected_at,
      session_info: s.session_info,
      department_name: s.department_name,
      department_name_ko: s.department_name_ko,
      department_color: s.department_color,
    }));
  const agentsWithDispatched = [...agents, ...dispatchedAsAgents];

  const isKo = settings.language === "ko";
  const locale = settings.language;
  const tr = (ko: string, en: string) => (isKo ? ko : en);

  const newMeetingsCount = roundTableMeetings.filter(hasUnresolvedMeetingIssues).length;
  const viewFallbackLabel = {
    office: "Loading Office...",
    dashboard: "Loading Dashboard...",
    agents: "Loading Agents...",
    meetings: "Loading Meetings...",
    chat: "Loading Chat...",
    skills: "Loading Skills...",
    settings: "Loading Settings...",
  } satisfies Record<ViewMode, string>;

  const navItems: Array<{ id: ViewMode; icon: React.ReactNode; label: string; badge?: number; badgeColor?: string }> = [
    { id: "office", icon: <Building2 size={20} />, label: "오피스" },
    { id: "agents", icon: <Users size={20} />, label: "직원" },
    { id: "dashboard", icon: <LayoutDashboard size={20} />, label: "대시보드" },
    { id: "chat", icon: <MessageCircle size={20} />, label: "채팅" },
    { id: "meetings", icon: <FileText size={20} />, label: "회의", badge: newMeetingsCount || undefined, badgeColor: "bg-amber-500" },
    { id: "skills", icon: <BookOpen size={20} />, label: "스킬" },
    { id: "settings", icon: <Settings size={20} />, label: "설정" },
  ];

  return (
    <div className="flex fixed inset-0 bg-gray-900">
      {/* Sidebar (hidden on mobile) */}
      <nav className="hidden sm:flex w-14 bg-gray-950 border-r border-gray-800 flex-col items-center py-4 gap-2">
        <div className="text-2xl mb-4">🐾</div>
        {navItems.map((item) => (
          <NavBtn
            key={item.id}
            icon={item.icon}
            active={view === item.id}
            badge={item.badge}
            badgeColor={item.badgeColor}
            onClick={() => { setView(item.id); if (item.id === "dashboard") refreshStats(); }}
            label={item.label}
          />
        ))}
        <div className="flex-1" />
        <NotificationCenter notifications={notifications} onDismiss={dismissNotification} />
        <div
          className="w-10 h-10 flex items-center justify-center rounded-lg"
          title={wsConnected ? "서버 연결됨" : "서버 연결 끊김"}
        >
          {wsConnected
            ? <Wifi size={16} className="text-emerald-500" />
            : <WifiOff size={16} className="text-red-400 animate-pulse" />}
        </div>
      </nav>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Office selector bar — hide on chat/settings views */}
        {offices.length > 0 && view !== "chat" && view !== "settings" && (
          <OfficeSelectorBar
            offices={offices}
            selectedOfficeId={selectedOfficeId}
            onSelectOffice={setSelectedOfficeId}
            onManageOffices={() => setShowOfficeManager(true)}
            isKo={isKo}
          />
        )}

        <main className="flex-1 min-h-0 flex flex-col overflow-hidden mb-14 sm:mb-0">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-gray-500">
                {viewFallbackLabel[view]}
              </div>
            }
          >
            {view === "office" && (
              <OfficeView
                agents={agentsWithDispatched}
                departments={departments}
                language={settings.language}
                theme={settings.theme === "auto" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : settings.theme}
                subAgents={subAgents}
                notifications={notifications}
                auditLogs={auditLogs}
                onSelectAgent={(agent) => setOfficeInfoAgent(agent)}
                onSelectDepartment={() => { setView("agents"); }}
                customDeptThemes={settings.roomThemes}
              />
            )}
            {view === "dashboard" && (
              <DashboardPageView
                stats={stats}
                agents={agents}
                settings={settings}
                onNavigateToOffice={() => setView("office")}
                onSelectAgent={(agent) => setOfficeInfoAgent(agent)}
              />
            )}
            {view === "agents" && (
              <AgentManagerView
                agents={agents}
                departments={departments}
                kanbanAgents={allAgents}
                kanbanDepartments={allDepartments}
                kanbanCards={kanbanCards}
                taskDispatches={taskDispatches}
                language={settings.language}
                officeId={selectedOfficeId}
                onAgentsChange={() => { refreshAgents(); refreshAllAgents(); refreshOffices(); }}
                onDepartmentsChange={() => { refreshDepartments(); refreshAllDepartments(); refreshOffices(); }}
                onAssignKanbanIssue={async (payload) => {
                  const assigned = await api.assignKanbanIssue(payload);
                  upsertKanbanCard(assigned);
                }}
                sessions={visibleDispatchedSessions}
                onUpdateKanbanCard={async (id, patch) => {
                  const updated = await api.updateKanbanCard(id, patch);
                  upsertKanbanCard(updated);
                }}
                onRetryKanbanCard={async (id, payload) => {
                  const updated = await api.retryKanbanCard(id, payload);
                  upsertKanbanCard(updated);
                }}
                onDeleteKanbanCard={async (id) => {
                  await api.deleteKanbanCard(id);
                  setKanbanCards((prev) => prev.filter((card) => card.id !== id));
                }}
                onAssign={async (id, patch) => {
                  const updated = await api.assignDispatchedSession(id, patch);
                  setSessions((prev) =>
                    prev.map((s) => (s.id === updated.id ? updated : s)),
                  );
                }}
              />
            )}
            {view === "meetings" && (
              <MeetingMinutesView
                meetings={roundTableMeetings}
                onRefresh={() => api.getRoundTableMeetings().then(setRoundTableMeetings).catch(() => {})}
              />
            )}
            {view === "skills" && <SkillCatalogView />}
            {view === "chat" && (
              <ChatView
                agents={allAgents}
                departments={departments}
                notifications={notifications}
                auditLogs={auditLogs}
                isKo={isKo}
                wsRef={wsRef}
                onMessageSent={refreshAuditLogs}
              />
            )}
            {view === "settings" && (
              <SettingsView settings={settings} onSave={async (patch) => {
                await api.saveSettings(patch);
                setSettings((prev) => ({ ...prev, ...patch } as CompanySettings));
                refreshAuditLogs();
              }} isKo={isKo} />
            )}
          </Suspense>
        </main>

      </div>

      {/* G1: Mobile bottom tab bar */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-gray-950 border-t border-gray-800 flex justify-around items-center h-14 z-50">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => { setView(item.id); if (item.id === "dashboard") refreshStats(); }}
            className={`relative flex flex-col items-center justify-center flex-1 h-full text-[10px] ${
              view === item.id ? "text-indigo-400" : "text-gray-500"
            }`}
          >
            {item.icon}
            <span className="mt-0.5">{item.label}</span>
            {item.badge !== undefined && item.badge > 0 && (
              <span className={`absolute top-1 right-1/4 ${item.badgeColor || "bg-emerald-500"} text-white text-[8px] w-3.5 h-3.5 rounded-full flex items-center justify-center`}>
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Agent Info Card (from Office View click) */}
      <Suspense fallback={null}>
        {officeInfoAgent && (
          <AgentInfoCard
            agent={officeInfoAgent}
            spriteMap={spriteMap}
            isKo={isKo}
            locale={locale}
            tr={tr}
            departments={departments}
            onClose={() => setOfficeInfoAgent(null)}
            onAgentUpdated={() => { refreshAgents(); refreshAllAgents(); refreshOffices(); refreshAuditLogs(); }}
          />
        )}
      </Suspense>

      {/* I7: Command Palette */}
      <Suspense fallback={null}>
        {showCmdPalette && (
          <CommandPalette
            agents={allAgents}
            departments={departments}
            isKo={isKo}
            onSelectAgent={(agent) => setOfficeInfoAgent(agent)}
            onNavigate={(v) => setView(v as ViewMode)}
            onClose={() => setShowCmdPalette(false)}
          />
        )}
      </Suspense>

      {/* Office Manager Modal */}
      <Suspense fallback={null}>
        {showOfficeManager && (
          <OfficeManagerModal
            offices={offices}
            allAgents={allAgents}
            isKo={isKo}
            onClose={() => setShowOfficeManager(false)}
            onChanged={handleOfficeChanged}
          />
        )}
      </Suspense>
    </div>
  );
}

function NavBtn({
  icon,
  active,
  badge,
  badgeColor,
  onClick,
  label,
}: {
  icon: React.ReactNode;
  active: boolean;
  badge?: number;
  badgeColor?: string;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`relative w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
        active
          ? "bg-indigo-600 text-white"
          : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
      }`}
    >
      {icon}
      {badge !== undefined && badge > 0 && (
        <span className={`absolute -top-1 -right-1 ${badgeColor || "bg-emerald-500"} text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center`}>
          {badge}
        </span>
      )}
    </button>
  );
}
