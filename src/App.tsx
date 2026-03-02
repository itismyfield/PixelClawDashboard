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
      <main className="flex-1 overflow-auto">
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
          <div className="p-8 text-center text-gray-500">
            <div className="text-6xl mb-4">🏢</div>
            <p>Pixi.js 오피스 뷰 (준비 중)</p>
            <p className="text-sm mt-2">에이전트 {agents.length}명 | 부서 {departments.length}개 | 파견 {activeSessions.length}명</p>
          </div>
        )}
        {view === "dashboard" && (
          <DashboardView stats={stats} settings={settings} />
        )}
        {view === "agents" && (
          <AgentListView agents={agents} departments={departments} />
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

function DashboardView({
  stats,
  settings,
}: {
  stats: DashboardStats | null;
  settings: CompanySettings;
}) {
  if (!stats) return <div className="p-8 text-gray-500">Loading stats...</div>;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">{settings.companyName}</h1>

      {/* Agent stats */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard label="전체" value={stats.agents.total} color="text-white" />
        <StatCard label="근무 중" value={stats.agents.working} color="text-emerald-400" />
        <StatCard label="대기" value={stats.agents.idle} color="text-gray-400" />
        <StatCard label="파견" value={stats.dispatched_count} color="text-amber-400" />
      </div>

      {/* Department stats */}
      <h2 className="text-lg font-semibold mb-3">부서별 현황</h2>
      <div className="space-y-2 mb-8">
        {stats.departments.map((d) => (
          <div key={d.id} className="bg-gray-800 rounded-lg p-3 flex items-center gap-3">
            <span className="text-xl">{d.icon}</span>
            <span className="flex-1 font-medium">{d.name_ko || d.name}</span>
            <span className="text-sm text-gray-400">
              {d.working_agents}/{d.total_agents} 근무중
            </span>
            <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${d.total_agents ? (d.working_agents / d.total_agents) * 100 : 0}%`,
                  backgroundColor: d.color,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Top agents */}
      <h2 className="text-lg font-semibold mb-3">랭킹</h2>
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        {stats.top_agents.map((a, i) => (
          <div key={a.id} className="flex items-center gap-3 px-4 py-3 border-b border-gray-700 last:border-0">
            <span className="text-gray-500 w-6 text-center font-bold">{i + 1}</span>
            <span className="text-xl">{a.avatar_emoji}</span>
            <span className="flex-1">{a.name_ko || a.name}</span>
            <span className="text-amber-400 text-sm font-medium">{a.stats_xp} XP</span>
            <span className="text-gray-500 text-sm">{a.stats_tasks_done} tasks</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 text-center">
      <div className={`text-3xl font-bold ${color}`}>{value}</div>
      <div className="text-sm text-gray-400 mt-1">{label}</div>
    </div>
  );
}

function AgentListView({
  agents,
  departments,
}: {
  agents: Agent[];
  departments: Department[];
}) {
  const deptMap = new Map(departments.map((d) => [d.id, d]));
  const statusColor: Record<string, string> = {
    working: "bg-emerald-500",
    idle: "bg-gray-500",
    break: "bg-amber-500",
    offline: "bg-red-500",
  };
  const roleLabel: Record<string, string> = {
    team_leader: "팀장",
    senior: "시니어",
    junior: "주니어",
    intern: "인턴",
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">직원 관리 ({agents.length}명)</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((a) => {
          const dept = a.department_id ? deptMap.get(a.department_id) : null;
          return (
            <div key={a.id} className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-2xl">{a.avatar_emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{a.name_ko || a.name}</div>
                  <div className="text-xs text-gray-400">{roleLabel[a.role] || a.role}</div>
                </div>
                <span className={`w-2.5 h-2.5 rounded-full ${statusColor[a.status] || "bg-gray-500"}`} />
              </div>
              {dept && (
                <div className="text-xs text-gray-400 flex items-center gap-1">
                  <span>{dept.icon}</span>
                  <span>{dept.name_ko || dept.name}</span>
                </div>
              )}
              {a.session_info && (
                <div className="text-xs text-indigo-400 mt-1 truncate">
                  {a.session_info}
                </div>
              )}
              {a.personality && (
                <div className="text-xs text-gray-500 mt-1 truncate">
                  {a.personality}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
