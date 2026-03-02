import { useState, useEffect, useCallback, useRef } from "react";
import type {
  Agent,
  Department,
  DispatchedSession,
  DashboardStats,
  CompanySettings,
  WSEvent,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import * as api from "./api/client";
import { SessionPanel } from "./components/session-panel/SessionPanel";
import OfficeView from "./components/OfficeView";
import DashboardPageView from "./components/DashboardPageView";
import AgentManagerView from "./components/AgentManagerView";
import {
  Building2,
  LayoutDashboard,
  Users,
  Zap,
} from "lucide-react";

type ViewMode = "office" | "dashboard" | "agents" | "sessions";

export default function App() {
  const [view, setView] = useState<ViewMode>("sessions");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [sessions, setSessions] = useState<DispatchedSession[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [settings, setSettings] = useState<CompanySettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);

  // Bootstrap
  useEffect(() => {
    (async () => {
      try {
        await api.getSession();
        const [ag, dep, ses, st, set] = await Promise.all([
          api.getAgents(),
          api.getDepartments(),
          api.getDispatchedSessions(),
          api.getStats(),
          api.getSettings(),
        ]);
        setAgents(ag);
        setDepartments(dep);
        setSessions(ses);
        setStats(st);
        if (set.companyName) {
          setSettings((prev) => ({ ...prev, ...set } as CompanySettings));
        }
      } catch (e) {
        console.error("Bootstrap failed:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // WebSocket
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as WSEvent;
        handleWsEvent(event);
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      setTimeout(() => {
        // Reconnect
        wsRef.current = null;
      }, 3000);
    };

    return () => ws.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleWsEvent = useCallback((event: WSEvent) => {
    switch (event.type) {
      case "agent_status":
        setAgents((prev) => {
          const a = event.payload as Agent;
          return prev.map((p) => (p.id === a.id ? { ...p, ...a } : p));
        });
        break;
      case "agent_created":
        api.getAgents().then(setAgents).catch(() => {});
        break;
      case "agent_deleted":
        setAgents((prev) =>
          prev.filter((a) => a.id !== (event.payload as { id: string }).id),
        );
        break;
      case "departments_changed":
        api.getDepartments().then(setDepartments).catch(() => {});
        break;
      case "dispatched_session_new":
        setSessions((prev) => [event.payload as DispatchedSession, ...prev]);
        break;
      case "dispatched_session_update":
        setSessions((prev) => {
          const s = event.payload as DispatchedSession;
          return prev.map((p) => (p.id === s.id ? { ...p, ...s } : p));
        });
        break;
      case "dispatched_session_disconnect":
        setSessions((prev) => {
          const { id } = event.payload as { id: string };
          return prev.map((p) =>
            p.id === id ? { ...p, status: "disconnected" as const } : p,
          );
        });
        break;
    }
  }, []);

  const refreshStats = useCallback(() => {
    api.getStats().then(setStats).catch(() => {});
  }, []);

  const refreshAgents = useCallback(() => {
    api.getAgents().then(setAgents).catch(() => {});
  }, []);

  const refreshDepartments = useCallback(() => {
    api.getDepartments().then(setDepartments).catch(() => {});
  }, []);

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

  const activeSessions = sessions.filter((s) => s.status !== "disconnected");

  return (
    <div className="flex h-screen bg-gray-900">
      {/* Sidebar */}
      <nav className="w-14 bg-gray-950 border-r border-gray-800 flex flex-col items-center py-4 gap-2">
        <div className="text-2xl mb-4">🐾</div>
        <NavBtn
          icon={<Zap size={20} />}
          active={view === "sessions"}
          badge={activeSessions.length}
          onClick={() => setView("sessions")}
          label="파견"
        />
        <NavBtn
          icon={<Building2 size={20} />}
          active={view === "office"}
          onClick={() => setView("office")}
          label="오피스"
        />
        <NavBtn
          icon={<LayoutDashboard size={20} />}
          active={view === "dashboard"}
          onClick={() => { setView("dashboard"); refreshStats(); }}
          label="대시보드"
        />
        <NavBtn
          icon={<Users size={20} />}
          active={view === "agents"}
          onClick={() => setView("agents")}
          label="직원"
        />
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {view === "sessions" && (
          <SessionPanel
            sessions={sessions}
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
          <OfficeView
            agents={agents}
            departments={departments}
            language={settings.language}
            theme={settings.theme}
            onSelectAgent={(agent) => console.log("Select agent:", agent.name)}
            onSelectDepartment={(dept) => console.log("Select dept:", dept.name)}
            customDeptThemes={settings.roomThemes}
          />
        )}
        {view === "dashboard" && (
          <DashboardPageView
            stats={stats}
            agents={agents}
            settings={settings}
            onNavigateToOffice={() => setView("office")}
          />
        )}
        {view === "agents" && (
          <AgentManagerView
            agents={agents}
            departments={departments}
            language={settings.language}
            onAgentsChange={refreshAgents}
            onDepartmentsChange={refreshDepartments}
          />
        )}
      </main>
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
