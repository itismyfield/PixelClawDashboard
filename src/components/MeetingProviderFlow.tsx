const PROVIDER_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  claude: {
    label: "Claude",
    bg: "rgba(245,158,11,0.12)",
    color: "#fbbf24",
    border: "rgba(245,158,11,0.25)",
  },
  codex: {
    label: "Codex",
    bg: "rgba(56,189,248,0.12)",
    color: "#7dd3fc",
    border: "rgba(56,189,248,0.24)",
  },
};

function getProviderMeta(provider: string | null) {
  if (!provider) {
    return {
      label: "Unknown",
      bg: "rgba(148,163,184,0.1)",
      color: "#cbd5e1",
      border: "rgba(148,163,184,0.18)",
    };
  }
  return PROVIDER_META[provider.toLowerCase()] ?? {
    label: provider.toUpperCase(),
    bg: "rgba(148,163,184,0.1)",
    color: "#cbd5e1",
    border: "rgba(148,163,184,0.18)",
  };
}

export function formatProviderFlow(
  primaryProvider: string | null,
  reviewerProvider: string | null,
): string {
  const primary = getProviderMeta(primaryProvider).label;
  const reviewer = getProviderMeta(reviewerProvider).label;
  return `${primary} -> ${reviewer}`;
}

export function providerFlowCaption(
  primaryProvider: string | null,
  reviewerProvider: string | null,
): string {
  const primary = getProviderMeta(primaryProvider).label;
  const reviewer = getProviderMeta(reviewerProvider).label;
  return `초안/최종: ${primary} · 비판 검토: ${reviewer}`;
}

export default function MeetingProviderFlow({
  primaryProvider,
  reviewerProvider,
  compact = false,
}: {
  primaryProvider: string | null;
  reviewerProvider: string | null;
  compact?: boolean;
}) {
  if (!primaryProvider && !reviewerProvider) return null;

  const primary = getProviderMeta(primaryProvider);
  const reviewer = getProviderMeta(reviewerProvider);

  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${compact ? "" : "rounded-xl px-3 py-2"}`} style={compact ? undefined : {
      background: "rgba(148,163,184,0.08)",
      border: "1px solid rgba(148,163,184,0.14)",
    }}>
      {!compact && (
        <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--th-text-muted)" }}>
          Provider Flow
        </span>
      )}
      <ProviderChip label={primary.label} bg={primary.bg} color={primary.color} border={primary.border} />
      <span className="text-[10px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
        draft/final
      </span>
      <span className="text-[10px] font-semibold px-1" style={{ color: "var(--th-text-muted)" }}>
        →
      </span>
      <ProviderChip label={reviewer.label} bg={reviewer.bg} color={reviewer.color} border={reviewer.border} />
      <span className="text-[10px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
        critique
      </span>
    </div>
  );
}

function ProviderChip({
  label,
  bg,
  color,
  border,
}: {
  label: string;
  bg: string;
  color: string;
  border: string;
}) {
  return (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
      style={{ background: bg, color, border: `1px solid ${border}` }}
    >
      {label}
    </span>
  );
}
