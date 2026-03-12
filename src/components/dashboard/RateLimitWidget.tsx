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

interface ProviderPalette {
  accent: string;
  normal: { bar: string; text: string; glow: string };
  warning: { bar: string; text: string; glow: string };
  danger: { bar: string; text: string; glow: string };
}

const PROVIDER_PALETTES: Record<string, ProviderPalette> = {
  Claude: {
    accent: "#f59e0b",
    normal: { bar: "#f59e0b", text: "#fbbf24", glow: "rgba(245,158,11,0.3)" },
    warning: { bar: "#ea580c", text: "#fb923c", glow: "rgba(234,88,12,0.4)" },
    danger: { bar: "#ef4444", text: "#fca5a5", glow: "rgba(239,68,68,0.5)" },
  },
  Codex: {
    accent: "#34d399",
    normal: { bar: "#34d399", text: "#6ee7b7", glow: "rgba(52,211,153,0.3)" },
    warning: { bar: "#fbbf24", text: "#fcd34d", glow: "rgba(251,191,36,0.4)" },
    danger: { bar: "#f87171", text: "#fca5a5", glow: "rgba(248,113,113,0.5)" },
  },
};

const DEFAULT_PALETTE: ProviderPalette = PROVIDER_PALETTES.Codex;

function getColors(provider: string, level: string) {
  const palette = PROVIDER_PALETTES[provider] || DEFAULT_PALETTE;
  if (level === "danger") return palette.danger;
  if (level === "warning") return palette.warning;
  return palette.normal;
}

function getAccent(provider: string) {
  return (PROVIDER_PALETTES[provider] || DEFAULT_PALETTE).accent;
}

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
    <div className="game-panel relative overflow-hidden px-3 py-2.5 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-3">
        {data.providers.map((provider) => {
          const accent = getAccent(provider.provider);
          return (
            <div key={provider.provider} className="flex items-center gap-2 sm:gap-x-4 min-w-0 flex-1">
              {/* Provider label */}
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-sm sm:text-base">
                  {provider.provider === "Claude" ? "🤖" : "⚡"}
                </span>
                <span
                  className="text-[10px] sm:text-xs font-bold uppercase tracking-wider"
                  style={{ color: accent }}
                >
                  {provider.provider}
                </span>
                {provider.stale && (
                  <span
                    className="rounded px-1 py-0.5 text-[8px] sm:text-[9px] font-medium"
                    style={{ color: "#fbbf24", background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)" }}
                  >
                    {t({ ko: "지연", en: "STALE", ja: "遅延", zh: "延迟" })}
                  </span>
                )}
              </div>
              {/* Buckets */}
              <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
                {provider.buckets.filter((b) => b.id !== "7d_sonnet").map((bucket) => {
                  const colors = getColors(provider.provider, bucket.level);
                  const remaining = formatTimeRemaining(bucket.resets_at);
                  return (
                    <div key={bucket.id} className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
                      <span
                        className="text-[9px] sm:text-[10px] font-bold shrink-0"
                        style={{ color: colors.text }}
                      >
                        {bucket.label}
                      </span>
                      <div className="flex-1 min-w-[40px] sm:min-w-[60px]">
                        <div
                          className="relative h-[5px] sm:h-[6px] rounded-full overflow-hidden"
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
                        className="text-[10px] sm:text-[11px] font-mono font-bold shrink-0 text-right"
                        style={{
                          color: colors.text,
                          textShadow: bucket.level === "danger" ? `0 0 6px ${colors.glow}` : "none",
                        }}
                      >
                        {bucket.utilization}%
                      </span>
                      {remaining && (
                        <span
                          className="text-[8px] sm:text-[9px] shrink-0 hidden sm:inline"
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
