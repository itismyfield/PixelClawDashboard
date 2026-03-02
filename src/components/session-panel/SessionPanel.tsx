import { useState } from "react";
import type { Agent, Department, DispatchedSession } from "../../types";
import { Monitor, MapPin, Clock, Wifi, WifiOff } from "lucide-react";

interface Props {
  sessions: DispatchedSession[];
  departments: Department[];
  agents: Agent[];
  onAssign: (id: string, patch: Partial<DispatchedSession>) => Promise<void>;
}

export function SessionPanel({ sessions, departments, agents, onAssign }: Props) {
  const active = sessions.filter((s) => s.status !== "disconnected");
  const disconnected = sessions.filter((s) => s.status === "disconnected");

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Monitor className="text-indigo-400" size={24} />
        <h1 className="text-2xl font-bold">파견 인력</h1>
        <span className="bg-emerald-600 text-white text-xs px-2 py-0.5 rounded-full">
          {active.length} 활성
        </span>
      </div>

      <p className="text-gray-400 text-sm mb-6">
        Claude Code 세션이 감지되면 파견 인력으로 등록됩니다.
        각 세션을 부서에 배치하여 오피스에서 시각화할 수 있습니다.
      </p>

      {active.length === 0 && disconnected.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          <Monitor size={48} className="mx-auto mb-4 opacity-30" />
          <p>현재 활성 세션이 없습니다</p>
          <p className="text-sm mt-1">Claude Code를 실행하면 자동으로 표시됩니다</p>
        </div>
      )}

      {/* Active sessions */}
      {active.length > 0 && (
        <div className="space-y-3 mb-8">
          {active.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              departments={departments}
              agents={agents}
              onAssign={onAssign}
            />
          ))}
        </div>
      )}

      {/* Disconnected sessions */}
      {disconnected.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-gray-500 mb-3 flex items-center gap-2">
            <WifiOff size={14} />
            종료된 세션 ({disconnected.length})
          </h2>
          <div className="space-y-2 opacity-60">
            {disconnected.slice(0, 10).map((s) => (
              <div
                key={s.id}
                className="bg-gray-800/50 rounded-lg px-4 py-3 flex items-center gap-3"
              >
                <span className="text-lg">{s.avatar_emoji}</span>
                <span className="flex-1 text-sm text-gray-400">
                  {s.name || s.session_key.slice(0, 12)}
                </span>
                <span className="text-xs text-gray-600">
                  {s.model || "unknown"}
                </span>
                {s.last_seen_at && (
                  <span className="text-xs text-gray-600">
                    {formatTimeAgo(s.last_seen_at)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SessionCard({
  session: s,
  departments,
  onAssign,
}: {
  session: DispatchedSession;
  departments: Department[];
  agents: Agent[];
  onAssign: (id: string, patch: Partial<DispatchedSession>) => Promise<void>;
}) {
  const [assigning, setAssigning] = useState(false);
  const [selectedDept, setSelectedDept] = useState(s.department_id || "");

  const handleAssign = async () => {
    setAssigning(true);
    try {
      await onAssign(s.id, {
        department_id: selectedDept || null,
      } as Partial<DispatchedSession>);
    } finally {
      setAssigning(false);
    }
  };

  const statusColor = s.status === "working" ? "bg-emerald-500" : "bg-amber-500";

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-start gap-3">
        {/* Avatar + status */}
        <div className="relative">
          <span className="text-3xl">{s.avatar_emoji}</span>
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-gray-800 ${statusColor}`}
          />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">
              {s.name || `Session ${s.session_key.slice(0, 8)}`}
            </span>
            <Wifi size={14} className="text-emerald-400" />
          </div>

          <div className="flex items-center gap-3 text-xs text-gray-400 mt-1">
            {s.model && (
              <span className="bg-gray-700 px-1.5 py-0.5 rounded">
                {s.model}
              </span>
            )}
            {s.session_info && (
              <span className="truncate max-w-[300px]">{s.session_info}</span>
            )}
          </div>

          {s.connected_at && (
            <div className="flex items-center gap-1 text-xs text-gray-500 mt-1">
              <Clock size={10} />
              <span>접속: {formatTimeAgo(s.connected_at)}</span>
            </div>
          )}
        </div>

        {/* Department assignment */}
        <div className="flex items-center gap-2">
          <MapPin size={14} className="text-gray-500" />
          <select
            value={selectedDept}
            onChange={(e) => setSelectedDept(e.target.value)}
            className="bg-gray-700 text-sm rounded px-2 py-1 border border-gray-600 text-gray-200"
          >
            <option value="">미배정</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.icon} {d.name_ko || d.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleAssign}
            disabled={assigning || selectedDept === (s.department_id || "")}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded transition-colors"
          >
            {assigning ? "..." : "배치"}
          </button>
        </div>
      </div>

      {/* Current department badge */}
      {s.department_id && s.department_name_ko && (
        <div className="mt-2 ml-11">
          <span
            className="text-xs px-2 py-0.5 rounded-full text-white"
            style={{ backgroundColor: s.department_color || "#6366f1" }}
          >
            {s.department_name_ko}에 배치됨
          </span>
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}
