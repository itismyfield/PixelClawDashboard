import { useEffect, useState } from "react";
import type { TFunction } from "./model";

interface RateLimitBucket {
  id: string;
  label: string;
  utilization: number;
  resets_at: string | null;
  level: "normal" | "warning" | "danger";
}

interface RateLimitProvider {
  provider: string;
  buckets: RateLimitBucket[];
  fetched_at: number;
  stale: boolean;
}

interface RateLimitData {
  providers: RateLimitProvider[];
}

const LEVEL_COLORS: Record<string, { bar: string; text: string; glow: string }> = {
  normal: { bar: "#34d399", text: "#6ee7b7", glow: "rgba(52,211,153,0.3)" },
  warning: { bar: "#fbbf24", text: "#fcd34d", glow: "rgba(251,191,36,0.4)" },
  danger: { bar: "#f87171", text: "#fca5a5", glow: "rgba(248,113,113,0.5)" },
};

function formatTimeRemaining(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (diff <= 0) return "now";
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

interface RateLimitWidgetProps {
  t: TFunction;
}

export default function RateLimitWidget({ t }: RateLimitWidgetProps) {
  const [data, setData] = useState<RateLimitData | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const res = await fetch("/api/rate-limits", { credentials: "include" });
        if (!res.ok) return;
        const json = (await res.json()) as RateLimitData;
        if (mounted) setData(json);
      } catch { /* ignore */ }
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  if (!data || data.providers.length === 0) return null;

  return (
    <div className="game-panel relative overflow-hidden p-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {data.providers.map((provider) => (
          <div key={provider.provider} className="flex flex-wrap items-center gap-x-4 gap-y-2 min-w-0 flex-1">
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-base">
                {provider.provider === "Claude" ? "🤖" : "⚡"}
              </span>
              <span
                className="text-xs font-bold uppercase tracking-wider"
                style={{ color: "var(--th-text-muted)" }}
              >
                {provider.provider}
              </span>
              {provider.stale && (
                <span
                  className="rounded px-1.5 py-0.5 text-[9px] font-medium"
                  style={{ color: "#fbbf24", background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)" }}
                >
                  {t({ ko: "지연", en: "STALE", ja: "遅延", zh: "延迟" })}
                </span>
              )}
            </div>
            {provider.buckets.map((bucket) => {
              const colors = LEVEL_COLORS[bucket.level] || LEVEL_COLORS.normal;
              const remaining = formatTimeRemaining(bucket.resets_at);
              return (
                <div key={bucket.id} className="flex items-center gap-2 min-w-[140px] flex-1 max-w-[260px]">
                  <span
                    className="text-[10px] font-bold shrink-0 w-[52px]"
                    style={{ color: colors.text }}
                  >
                    {bucket.label}
                  </span>
                  <div className="flex-1 min-w-[60px]">
                    <div
                      className="relative h-[6px] rounded-full overflow-hidden"
                      style={{ background: "rgba(255,255,255,0.06)" }}
                    >
                      <div
                        className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.min(bucket.utilization, 100)}%`,
                          background: colors.bar,
                          boxShadow: bucket.level !== "normal" ? `0 0 8px ${colors.glow}` : "none",
                        }}
                      />
                    </div>
                  </div>
                  <span
                    className="text-[11px] font-mono font-bold shrink-0 w-[32px] text-right"
                    style={{
                      color: colors.text,
                      textShadow: bucket.level === "danger" ? `0 0 6px ${colors.glow}` : "none",
                    }}
                  >
                    {bucket.utilization}%
                  </span>
                  {remaining && (
                    <span
                      className="text-[9px] shrink-0"
                      style={{ color: "var(--th-text-muted)" }}
                      title={t({ ko: "리셋까지", en: "Resets in", ja: "リセットまで", zh: "重置" })}
                    >
                      ⏱{remaining}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
