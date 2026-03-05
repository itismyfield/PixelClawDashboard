import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import type {
  Agent,
  Department,
  Office,
  DispatchedSession,
  SubAgent,
  DashboardStats,
  CompanySettings,
  WSEvent,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import * as api from "./api/client";
import { SessionPanel } from "./components/session-panel/SessionPanel";
const OfficeView = lazy(() => import("./components/OfficeView"));
import DashboardPageView from "./components/DashboardPageView";
import AgentManagerView from "./components/AgentManagerView";
import OfficeSelectorBar from "./components/OfficeSelectorBar";
import OfficeManagerModal from "./components/OfficeManagerModal";
import AgentInfoCard from "./components/agent-manager/AgentInfoCard";
import { useSpriteMap } from "./components/AgentAvatar";
import NotificationCenter, { type Notification, useNotifications } from "./components/NotificationCenter";
import {
  Building2,
  LayoutDashboard,
  Users,
  Zap,
  Wifi,
  WifiOff,
  Settings,
  MessageCircle,
} from "lucide-react";
import ChatView from "./components/ChatView";
import CommandPalette from "./components/CommandPalette";

type ViewMode = "office" | "dashboard" | "agents" | "sessions" | "chat" | "settings";

export default function App() {
  const [view, setView] = useState<ViewMode>("office");
  const [offices, setOffices] = useState<Office[]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [sessions, setSessions] = useState<DispatchedSession[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [settings, setSettings] = useState<CompanySettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [showOfficeManager, setShowOfficeManager] = useState(false);
  const [officeInfoAgent, setOfficeInfoAgent] = useState<Agent | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [showCmdPalette, setShowCmdPalette] = useState(false);

  const spriteMap = useSpriteMap(agents);
  const wsRef = useRef<WebSocket | null>(null);
  const wsRetryRef = useRef(0);
  const wsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { notifications, pushNotification, dismissNotification } = useNotifications();

  // Bootstrap
  useEffect(() => {
    (async () => {
      try {
        await api.getSession();
        const [off, ag, dep, ses, st, set] = await Promise.all([
          api.getOffices(),
          api.getAgents(),
          api.getDepartments(),
          api.getDispatchedSessions(true),
          api.getStats(),
          api.getSettings(),
        ]);
        setOffices(off);
        setAllAgents(ag);
        setAgents(ag);
        setDepartments(dep);
        setSessions(ses);
        setStats(st);
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

  // WebSocket with exponential backoff reconnect
  useEffect(() => {
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        wsRetryRef.current = 0;
        setWsConnected(true);
      };

      ws.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data) as WSEvent;
          handleWsEvent(event);
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        setWsConnected(false);
        wsRef.current = null;
        if (destroyed) return;
        const delay = Math.min(1000 * 2 ** wsRetryRef.current, 30000);
        wsRetryRef.current += 1;
        wsTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (wsTimerRef.current) clearTimeout(wsTimerRef.current);
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleWsEvent = useCallback((event: WSEvent) => {
    switch (event.type) {
      case "agent_status": {
        const a = event.payload as Agent;
        setAgents((prev) => prev.map((p) => (p.id === a.id ? { ...p, ...a } : p)));
        setAllAgents((prev) => prev.map((p) => (p.id === a.id ? { ...p, ...a } : p)));
        break;
      }
      case "agent_created": {
        const created = event.payload as Agent;
        pushNotification(`새 에이전트: ${created.name_ko || created.name || "unknown"}`, "success");
        refreshAgents();
        refreshAllAgents();
        break;
      }
      case "agent_deleted":
        setAgents((prev) => prev.filter((a) => a.id !== (event.payload as { id: string }).id));
        setAllAgents((prev) => prev.filter((a) => a.id !== (event.payload as { id: string }).id));
        break;
      case "departments_changed":
        refreshDepartments();
        break;
      case "offices_changed":
        refreshOffices();
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
    }
  }, [pushNotification]);

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

  const handleOfficeChanged = useCallback(() => {
    refreshOffices();
    refreshAgents();
    refreshAllAgents();
    refreshDepartments();
  }, [refreshOffices, refreshAgents, refreshAllAgents, refreshDepartments]);

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

  const isKo = settings.language === "ko";
  const locale = settings.language;
  const tr = (ko: string, en: string) => (isKo ? ko : en);

  const navItems: Array<{ id: ViewMode; icon: React.ReactNode; label: string; badge?: number }> = [
    { id: "office", icon: <Building2 size={20} />, label: "오피스" },
    { id: "agents", icon: <Users size={20} />, label: "직원" },
    { id: "dashboard", icon: <LayoutDashboard size={20} />, label: "대시보드" },
    { id: "chat", icon: <MessageCircle size={20} />, label: "채팅" },
    { id: "sessions", icon: <Zap size={20} />, label: "파견", badge: activeSessions.length },
    { id: "settings", icon: <Settings size={20} />, label: "설정" },
  ];

  return (
    <div className="flex h-screen bg-gray-900">
      {/* Sidebar (hidden on mobile) */}
      <nav className="hidden sm:flex w-14 bg-gray-950 border-r border-gray-800 flex-col items-center py-4 gap-2">
        <div className="text-2xl mb-4">🐾</div>
        {navItems.map((item) => (
          <NavBtn
            key={item.id}
            icon={item.icon}
            active={view === item.id}
            badge={item.badge}
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
        {/* Office selector bar */}
        {offices.length > 0 && (
          <OfficeSelectorBar
            offices={offices}
            selectedOfficeId={selectedOfficeId}
            onSelectOffice={setSelectedOfficeId}
            onManageOffices={() => setShowOfficeManager(true)}
            isKo={isKo}
          />
        )}

        <main className="flex-1 overflow-hidden mb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:mb-0">
          {view === "sessions" && (
            <SessionPanel
              sessions={visibleDispatchedSessions}
              departments={departments}
              agents={agents}
              onAssign={async (id, patch) => {
                const updated = await api.assignDispatchedSession(id, patch);
                setSessions((prev) =>
                  prev.map((s) => (s.id === updated.id ? updated : s)),
                );
              }}
            />
          )}
          {view === "office" && (
            <Suspense fallback={<div className="flex items-center justify-center h-full text-gray-500">Loading Office...</div>}>
              <OfficeView
                agents={agents}
                departments={departments}
                language={settings.language}
                theme={settings.theme === "auto" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : settings.theme}
                subAgents={subAgents}
                onSelectAgent={(agent) => setOfficeInfoAgent(agent)}
                onSelectDepartment={() => { setView("agents"); }}
                customDeptThemes={settings.roomThemes}
              />
            </Suspense>
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
              language={settings.language}
              officeId={selectedOfficeId}
              onAgentsChange={() => { refreshAgents(); refreshAllAgents(); refreshOffices(); }}
              onDepartmentsChange={() => { refreshDepartments(); refreshOffices(); }}
            />
          )}
          {view === "chat" && (
            <ChatView agents={allAgents} isKo={isKo} wsRef={wsRef} />
          )}
          {view === "settings" && (
            <SettingsView settings={settings} onSave={async (patch) => {
              await api.saveSettings(patch);
              setSettings((prev) => ({ ...prev, ...patch } as CompanySettings));
            }} isKo={isKo} />
          )}
        </main>
      </div>

      {/* Agent Info Card (from Office View click) */}
      {officeInfoAgent && (
        <AgentInfoCard
          agent={officeInfoAgent}
          spriteMap={spriteMap}
          isKo={isKo}
          locale={locale}
          tr={tr}
          departments={departments}
          onClose={() => setOfficeInfoAgent(null)}
          onAgentUpdated={() => { refreshAgents(); refreshAllAgents(); }}
        />
      )}

      {/* I7: Command Palette */}
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

      {/* G1: Mobile bottom tab bar */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-gray-950 border-t border-gray-800 flex justify-around items-center h-14 z-50"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
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
              <span className="absolute top-1 right-1/4 bg-emerald-500 text-white text-[8px] w-3.5 h-3.5 rounded-full flex items-center justify-center">
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Office Manager Modal */}
      {showOfficeManager && (
        <OfficeManagerModal
          offices={offices}
          allAgents={allAgents}
          isKo={isKo}
          onClose={() => setShowOfficeManager(false)}
          onChanged={handleOfficeChanged}
        />
      )}
    </div>
  );
}

function NavBtn({
  icon,
  active,
  badge,
  onClick,
  label,
}: {
  icon: React.ReactNode;
  active: boolean;
  badge?: number;
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
        <span className="absolute -top-1 -right-1 bg-emerald-500 text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center">
          {badge}
        </span>
      )}
    </button>
  );
}

function SettingsView({
  settings,
  onSave,
  isKo,
}: {
  settings: CompanySettings;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  isKo: boolean;
}) {
  const [companyName, setCompanyName] = useState(settings.companyName);
  const [ceoName, setCeoName] = useState(settings.ceoName);
  const [language, setLanguage] = useState(settings.language);
  const [theme, setTheme] = useState(settings.theme);
  const [autoAssign, setAutoAssign] = useState(settings.autoAssign);
  const [yoloMode, setYoloMode] = useState(settings.yoloMode ?? false);
  const [defaultProvider, setDefaultProvider] = useState(settings.defaultProvider);
  const [saving, setSaving] = useState(false);
  const tr = (ko: string, en: string) => (isKo ? ko : en);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ companyName, ceoName, language, theme, autoAssign, yoloMode, defaultProvider });
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = { background: "var(--th-bg-surface)", border: "1px solid var(--th-border)", color: "var(--th-text)" };
  const cardStyle = { background: "var(--th-surface)", border: "1px solid var(--th-border)" };

  return (
    <div
      className="p-6 max-w-2xl mx-auto space-y-6 overflow-auto h-full pb-40"
      style={{ paddingBottom: "max(10rem, calc(10rem + env(safe-area-inset-bottom)))" }}
    >
      <h2 className="text-xl font-bold" style={{ color: "var(--th-text)" }}>
        {tr("설정", "Settings")}
      </h2>

      {/* General */}
      <div>
        <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: "var(--th-text-muted)" }}>
          {tr("일반", "General")}
        </h3>
        <div className="space-y-3">
          <div className="rounded-xl p-4" style={cardStyle}>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
              {tr("회사 이름", "Company Name")}
            </label>
            <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm" style={inputStyle} />
          </div>

          <div className="rounded-xl p-4" style={cardStyle}>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
              {tr("CEO 이름", "CEO Name")}
            </label>
            <input type="text" value={ceoName} onChange={(e) => setCeoName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm" style={inputStyle} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl p-4" style={cardStyle}>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
                {tr("언어", "Language")}
              </label>
              <select value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}
                className="w-full px-3 py-2 rounded-lg text-sm" style={inputStyle}>
                <option value="ko">한국어</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="zh">中文</option>
              </select>
            </div>

            <div className="rounded-xl p-4" style={cardStyle}>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
                {tr("테마", "Theme")}
              </label>
              <select value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}
                className="w-full px-3 py-2 rounded-lg text-sm" style={inputStyle}>
                <option value="dark">{tr("다크", "Dark")}</option>
                <option value="light">{tr("라이트", "Light")}</option>
                <option value="auto">{tr("자동 (시스템)", "Auto (System)")}</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Automation */}
      <div>
        <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: "var(--th-text-muted)" }}>
          {tr("자동화", "Automation")}
        </h3>
        <div className="space-y-3">
          <div className="rounded-xl p-4" style={cardStyle}>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
              {tr("기본 CLI Provider", "Default CLI Provider")}
            </label>
            <select value={defaultProvider} onChange={(e) => setDefaultProvider(e.target.value as typeof defaultProvider)}
              className="w-full px-3 py-2 rounded-lg text-sm" style={inputStyle}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="gemini">Gemini</option>
              <option value="opencode">OpenCode</option>
              <option value="copilot">Copilot</option>
            </select>
          </div>

          <div className="rounded-xl p-4 flex items-center justify-between" style={cardStyle}>
            <div>
              <div className="text-sm font-medium" style={{ color: "var(--th-text)" }}>
                {tr("자동 배정", "Auto Assign")}
              </div>
              <div className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                {tr("새 작업을 자동으로 에이전트에 배정", "Auto-assign new tasks to agents")}
              </div>
            </div>
            <button
              onClick={() => setAutoAssign(!autoAssign)}
              className={`w-11 h-6 rounded-full transition-colors relative ${autoAssign ? "bg-indigo-600" : "bg-gray-600"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${autoAssign ? "left-[22px]" : "left-0.5"}`} />
            </button>
          </div>

          <div className="rounded-xl p-4 flex items-center justify-between" style={cardStyle}>
            <div>
              <div className="text-sm font-medium" style={{ color: "var(--th-text)" }}>
                YOLO {tr("모드", "Mode")}
              </div>
              <div className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                {tr("확인 없이 자동 실행 (위험)", "Execute without confirmation (dangerous)")}
              </div>
            </div>
            <button
              onClick={() => setYoloMode(!yoloMode)}
              className={`w-11 h-6 rounded-full transition-colors relative ${yoloMode ? "bg-red-600" : "bg-gray-600"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${yoloMode ? "left-[22px]" : "left-0.5"}`} />
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-6 py-2.5 rounded-xl text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
      >
        {saving ? tr("저장 중...", "Saving...") : tr("저장", "Save")}
      </button>
    </div>
  );
}
