import { useEffect, useMemo, useState, type DragEvent } from "react";
import * as api from "../../api";
import type { GitHubIssue, GitHubRepoOption, KanbanRepoSource } from "../../api";
import AutoQueuePanel from "./AutoQueuePanel";
import PipelineEditor from "./PipelineEditor";
import PipelineProgress from "./PipelineProgress";
import MarkdownContent from "../common/MarkdownContent";
import type {
  Agent,
  Department,
  KanbanCard,
  KanbanCardMetadata,
  KanbanCardPriority,
  KanbanCardStatus,
  KanbanReviewChecklistItem,
  TaskDispatch,
  UiLanguage,
} from "../../types";
import type { KanbanReview } from "../../api";
import { localeName } from "../../i18n";

const COLUMN_DEFS: Array<{
  status: KanbanCardStatus;
  labelKo: string;
  labelEn: string;
  accent: string;
}> = [
  { status: "backlog", labelKo: "백로그", labelEn: "Backlog", accent: "#64748b" },
  { status: "ready", labelKo: "준비됨", labelEn: "Ready", accent: "#0ea5e9" },
  { status: "requested", labelKo: "요청됨", labelEn: "Requested", accent: "#8b5cf6" },
  { status: "in_progress", labelKo: "진행 중", labelEn: "In Progress", accent: "#f59e0b" },
  { status: "review", labelKo: "검토", labelEn: "Review", accent: "#14b8a6" },
  { status: "blocked", labelKo: "막힘", labelEn: "Blocked", accent: "#ef4444" },
  { status: "done", labelKo: "완료", labelEn: "Done", accent: "#22c55e" },
  { status: "failed", labelKo: "실패", labelEn: "Failed", accent: "#f97316" },
  { status: "cancelled", labelKo: "취소", labelEn: "Cancelled", accent: "#6b7280" },
];

const TERMINAL_STATUSES = new Set<KanbanCardStatus>(["done", "failed", "cancelled"]);
const PRIORITY_OPTIONS: KanbanCardPriority[] = ["low", "medium", "high", "urgent"];

/** Quick-transition targets per status. Order = button order (primary first). */
const STATUS_TRANSITIONS: Record<KanbanCardStatus, KanbanCardStatus[]> = {
  backlog: ["ready"],
  ready: ["requested", "backlog"],
  requested: ["in_progress", "cancelled"],
  in_progress: ["review", "blocked"],
  review: ["done", "in_progress"],
  blocked: ["in_progress", "cancelled"],
  done: ["backlog"],
  failed: ["backlog"],
  cancelled: ["backlog"],
};

const TRANSITION_STYLE: Record<string, { bg: string; text: string }> = {
  ready: { bg: "rgba(14,165,233,0.18)", text: "#38bdf8" },
  requested: { bg: "rgba(139,92,246,0.18)", text: "#a78bfa" },
  in_progress: { bg: "rgba(245,158,11,0.18)", text: "#fbbf24" },
  review: { bg: "rgba(20,184,166,0.18)", text: "#2dd4bf" },
  done: { bg: "rgba(34,197,94,0.22)", text: "#4ade80" },
  blocked: { bg: "rgba(239,68,68,0.18)", text: "#f87171" },
  backlog: { bg: "rgba(100,116,139,0.18)", text: "#94a3b8" },
  cancelled: { bg: "rgba(107,114,128,0.18)", text: "#9ca3af" },
  failed: { bg: "rgba(249,115,22,0.18)", text: "#fb923c" },
};

interface KanbanTabProps {
  tr: (ko: string, en: string) => string;
  locale: UiLanguage;
  cards: KanbanCard[];
  dispatches: TaskDispatch[];
  agents: Agent[];
  departments: Department[];
  onAssignIssue: (payload: {
    github_repo: string;
    github_issue_number: number;
    github_issue_url?: string | null;
    title: string;
    description?: string | null;
    assignee_agent_id: string;
  }) => Promise<void>;
  onUpdateCard: (
    id: string,
    patch: Partial<KanbanCard> & { before_card_id?: string | null },
  ) => Promise<void>;
  onRetryCard: (
    id: string,
    payload?: { assignee_agent_id?: string | null; request_now?: boolean },
  ) => Promise<void>;
  onDeleteCard: (id: string) => Promise<void>;
}

interface EditorState {
  title: string;
  description: string;
  assignee_agent_id: string;
  priority: KanbanCardPriority;
  status: KanbanCardStatus;
  blocked_reason: string;
  review_notes: string;
  review_checklist: KanbanReviewChecklistItem[];
}

const EMPTY_EDITOR: EditorState = {
  title: "",
  description: "",
  assignee_agent_id: "",
  priority: "medium",
  status: "ready",
  blocked_reason: "",
  review_notes: "",
  review_checklist: [],
};

const REQUEST_TIMEOUT_MS = 45 * 60 * 1000;
const IN_PROGRESS_STALE_MS = 60 * 60 * 1000;

function priorityLabel(priority: KanbanCardPriority, tr: (ko: string, en: string) => string): string {
  switch (priority) {
    case "low":
      return tr("낮음", "Low");
    case "medium":
      return tr("보통", "Medium");
    case "high":
      return tr("높음", "High");
    case "urgent":
      return tr("긴급", "Urgent");
  }
}

function formatTs(value: number | null | undefined, locale: UiLanguage): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatIso(value: string | null | undefined, locale: UiLanguage): string {
  if (!value) return "-";
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return value;
  return formatTs(parsed, locale);
}

function createChecklistItem(label: string, index = 0): KanbanReviewChecklistItem {
  return {
    id: `check-${Date.now()}-${index}`,
    label: label.trim(),
    done: false,
  };
}

function parseCardMetadata(value: string | null | undefined): KanbanCardMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as KanbanCardMetadata;
    return {
      ...parsed,
      review_checklist: Array.isArray(parsed.review_checklist)
        ? parsed.review_checklist.filter((item): item is KanbanReviewChecklistItem => Boolean(item?.label))
        : [],
    };
  } catch {
    return {};
  }
}

function stringifyCardMetadata(metadata: KanbanCardMetadata): string | null {
  const payload: KanbanCardMetadata = {};
  if (metadata.retry_count) payload.retry_count = metadata.retry_count;
  if (metadata.failover_count) payload.failover_count = metadata.failover_count;
  if (metadata.timed_out_stage) payload.timed_out_stage = metadata.timed_out_stage;
  if (metadata.timed_out_at) payload.timed_out_at = metadata.timed_out_at;
  if (metadata.timed_out_reason) payload.timed_out_reason = metadata.timed_out_reason;
  if (metadata.review_checklist && metadata.review_checklist.length > 0) {
    payload.review_checklist = metadata.review_checklist
      .map((item, index) => ({
        id: item.id || `check-${index}`,
        label: item.label.trim(),
        done: item.done === true,
      }))
      .filter((item) => item.label);
  }
  if (metadata.reward) payload.reward = metadata.reward;
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;
}

function formatAgeLabel(ms: number, tr: (ko: string, en: string) => string): string {
  if (ms < 60 * 1000) {
    return tr("방금", "just now");
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return tr(`${minutes}분`, `${minutes}m`);
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return tr(`${hours}시간`, `${hours}h`);
  }
  const days = Math.round(hours / 24);
  return tr(`${days}일`, `${days}d`);
}

// ---------------------------------------------------------------------------
// PMD Issue Format Parser
// ---------------------------------------------------------------------------

interface ParsedIssueSections {
  background: string | null;
  content: string | null;
  dodItems: string[];
  dependencies: string | null;
  risks: string | null;
}

function parseIssueSections(desc: string | null | undefined): ParsedIssueSections | null {
  if (!desc || !desc.includes("## DoD")) return null;

  const sections: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentLines: string[] = [];

  for (const line of desc.split("\n")) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (currentKey) sections[currentKey] = currentLines.join("\n").trim();
      currentKey = heading[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentKey) sections[currentKey] = currentLines.join("\n").trim();

  const dodText = sections["DoD"] ?? "";
  const dodItems = dodText
    .split("\n")
    .map((line) => line.replace(/^-\s*\[[ x]\]\s*/, "").trim())
    .filter(Boolean);

  return {
    background: sections["배경"] || null,
    content: sections["내용"] || null,
    dodItems,
    dependencies: sections["의존성"] || null,
    risks: sections["리스크"] || null,
  };
}

/** Sync DoD items from parsed issue body into review_checklist, preserving existing done states. */
function syncDodToChecklist(
  dodItems: string[],
  existingChecklist: KanbanReviewChecklistItem[],
): KanbanReviewChecklistItem[] {
  const existing = new Map(existingChecklist.map((item) => [item.label, item]));
  return dodItems.map((label, i) => {
    const match = existing.get(label);
    return match ?? createChecklistItem(label, i);
  });
}

function coerceEditor(card: KanbanCard | null): EditorState {
  if (!card) return EMPTY_EDITOR;
  const metadata = parseCardMetadata(card.metadata_json);
  const parsed = parseIssueSections(card.description);
  const checklist = parsed
    ? syncDodToChecklist(parsed.dodItems, metadata.review_checklist ?? [])
    : metadata.review_checklist ?? [];
  return {
    title: card.title,
    description: card.description ?? "",
    assignee_agent_id: card.assignee_agent_id ?? "",
    priority: card.priority,
    status: card.status,
    blocked_reason: card.blocked_reason ?? "",
    review_notes: card.review_notes ?? "",
    review_checklist: checklist,
  };
}

export default function KanbanTab({
  tr,
  locale,
  cards,
  dispatches,
  agents,
  departments,
  onAssignIssue,
  onUpdateCard,
  onRetryCard,
  onDeleteCard,
}: KanbanTabProps) {
  const [repoSources, setRepoSources] = useState<KanbanRepoSource[]>([]);
  const [repoInput, setRepoInput] = useState("");
  const [selectedRepo, setSelectedRepo] = useState("");
  const [availableRepos, setAvailableRepos] = useState<GitHubRepoOption[]>([]);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [agentFilter, setAgentFilter] = useState("all");
  const [deptFilter, setDeptFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [assignIssue, setAssignIssue] = useState<GitHubIssue | null>(null);
  const [assignAssigneeId, setAssignAssigneeId] = useState("");
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [savingCard, setSavingCard] = useState(false);
  const [retryingCard, setRetryingCard] = useState(false);
  const [assigningIssue, setAssigningIssue] = useState(false);
  const [repoBusy, setRepoBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<KanbanCardStatus | null>(null);
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);
  const [compactBoard, setCompactBoard] = useState(false);
  const [mobileColumnStatus, setMobileColumnStatus] = useState<KanbanCardStatus>("backlog");
  const [retryAssigneeId, setRetryAssigneeId] = useState("");
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [closingIssueNumber, setClosingIssueNumber] = useState<number | null>(null);
  const [selectedBacklogIssue, setSelectedBacklogIssue] = useState<GitHubIssue | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reviewData, setReviewData] = useState<KanbanReview | null>(null);
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, "accept" | "reject">>({});
  const [reviewBusy, setReviewBusy] = useState(false);
  const [recentDonePage, setRecentDonePage] = useState(0);
  const [recentDoneOpen, setRecentDoneOpen] = useState(false);

  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const cardsById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const dispatchMap = useMemo(() => new Map(dispatches.map((dispatch) => [dispatch.id, dispatch])), [dispatches]);

  /** Resolve agent from `agent:*` GitHub labels by matching role_id. */
  const resolveAgentFromLabels = useMemo(() => {
    const roleIdMap = new Map<string, Agent>();
    const suffixMap = new Map<string, Agent>();
    for (const agent of agents) {
      if (agent.role_id) {
        roleIdMap.set(agent.role_id, agent);
        // Also map the suffix after last hyphen (e.g. "ch-dd" → "dd")
        const lastDash = agent.role_id.lastIndexOf("-");
        if (lastDash >= 0) {
          const suffix = agent.role_id.slice(lastDash + 1);
          if (!suffixMap.has(suffix)) suffixMap.set(suffix, agent);
        }
      }
    }
    return (labels: Array<{ name: string; color: string }>): Agent | null => {
      for (const label of labels) {
        if (label.name.startsWith("agent:")) {
          const roleId = label.name.slice("agent:".length).trim();
          const matched = roleIdMap.get(roleId) ?? suffixMap.get(roleId);
          if (matched) return matched;
        }
      }
      return null;
    };
  }, [agents]);

  const selectedCard = selectedCardId ? cardsById.get(selectedCardId) ?? null : null;

  useEffect(() => {
    setEditor(coerceEditor(selectedCard));
    setRetryAssigneeId(selectedCard?.assignee_agent_id ?? "");
    setNewChecklistItem("");
    setReviewData(null);
    setReviewDecisions({});
    // Fetch review data for dilemma_pending cards
    if (selectedCard?.review_status === "dilemma_pending" || selectedCard?.review_status === "decided") {
      api.getKanbanReviews(selectedCard.id).then((reviews) => {
        const latest = reviews.filter((r) => r.verdict === "dilemma" || r.verdict === "mixed" || r.verdict === "decided")
          .sort((a, b) => b.round - a.round)[0];
        if (latest) {
          setReviewData(latest);
          // Restore existing decisions
          try {
            const items = latest.items_json ? JSON.parse(latest.items_json) as Array<{ id: string; category: string; decision?: string }> : [];
            const existing: Record<string, "accept" | "reject"> = {};
            for (const item of items) {
              if (item.decision === "accept" || item.decision === "reject") {
                existing[item.id] = item.decision;
              }
            }
            setReviewDecisions(existing);
          } catch { /* ignore */ }
        }
      }).catch(() => {});
    }
  }, [selectedCard]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const apply = () => setCompactBoard(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    Promise.all([
      api.getKanbanRepoSources().catch(() => [] as KanbanRepoSource[]),
      api.getGitHubRepos().then((result) => result.repos).catch(() => [] as GitHubRepoOption[]),
    ]).then(([sources, repos]) => {
      setRepoSources(sources);
      setAvailableRepos(repos);
      if (!selectedRepo && sources[0]?.repo) {
        setSelectedRepo(sources[0].repo);
      }
    }).finally(() => setInitialLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedRepo && repoSources[0]?.repo) {
      setSelectedRepo(repoSources[0].repo);
      return;
    }
    if (selectedRepo && !repoSources.some((source) => source.repo === selectedRepo)) {
      setSelectedRepo(repoSources[0]?.repo ?? "");
    }
  }, [repoSources, selectedRepo]);

  useEffect(() => {
    if (!selectedRepo) {
      setIssues([]);
      setLoadingIssues(false);
      return;
    }

    let stale = false;
    setIssues([]);
    setLoadingIssues(true);
    setActionError(null);
    api.getGitHubIssues(selectedRepo, "open", 100)
      .then((result) => {
        if (stale) return;
        setIssues(result.issues);
        if (result.error) {
          setActionError(result.error);
        }
      })
      .catch((error) => {
        if (stale) return;
        setIssues([]);
        setActionError(error instanceof Error ? error.message : "Failed to load GitHub issues.");
      })
      .finally(() => { if (!stale) setLoadingIssues(false); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo]);

  useEffect(() => {
    if (!showClosed && TERMINAL_STATUSES.has(mobileColumnStatus)) {
      setMobileColumnStatus("backlog");
    }
  }, [mobileColumnStatus, showClosed]);

  const labelForStatus = (status: KanbanCardStatus) =>
    COLUMN_DEFS.find((column) => column.status === status)
      ? tr(
        COLUMN_DEFS.find((column) => column.status === status)!.labelKo,
        COLUMN_DEFS.find((column) => column.status === status)!.labelEn,
      )
      : status;

  const getAgentLabel = (agentId: string | null | undefined) => {
    if (!agentId) return tr("미할당", "Unassigned");
    const agent = agentMap.get(agentId);
    if (!agent) return agentId;
    return localeName(locale, agent);
  };

  const repoCards = useMemo(() => {
    if (!selectedRepo) return [] as KanbanCard[];
    return cards.filter((card) => card.github_repo === selectedRepo);
  }, [cards, selectedRepo]);

  const filteredCards = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return repoCards.filter((card) => {
      if (!showClosed && TERMINAL_STATUSES.has(card.status)) {
        return false;
      }
      if (agentFilter !== "all" && card.assignee_agent_id !== agentFilter) {
        return false;
      }
      if (deptFilter !== "all" && agentMap.get(card.assignee_agent_id ?? "")?.department_id !== deptFilter) {
        return false;
      }
      if (!needle) return true;
      return (
        card.title.toLowerCase().includes(needle) ||
        (card.description ?? "").toLowerCase().includes(needle) ||
        getAgentLabel(card.assignee_agent_id).toLowerCase().includes(needle)
      );
    });
  }, [agentFilter, agentMap, deptFilter, getAgentLabel, repoCards, search, showClosed]);

  const recentDoneCards = useMemo(() => {
    return repoCards
      .filter((c) => c.status === "done" || c.status === "cancelled")
      .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
  }, [repoCards]);

  useEffect(() => { setRecentDonePage(0); }, [selectedRepo]);

  const cardsByStatus = useMemo(() => {
    const grouped = new Map<KanbanCardStatus, KanbanCard[]>();
    for (const column of COLUMN_DEFS) {
      grouped.set(column.status, []);
    }
    for (const card of filteredCards) {
      grouped.get(card.status)?.push(card);
    }
    for (const column of COLUMN_DEFS) {
      grouped.get(column.status)?.sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return b.updated_at - a.updated_at;
      });
    }
    return grouped;
  }, [filteredCards]);

  // Include ALL cards (including terminal) to prevent done/failed issues
  // from reappearing in the backlog when the done column is hidden.
  const activeIssueNumbers = useMemo(() => {
    const set = new Set<number>();
    for (const card of repoCards) {
      if (card.github_issue_number) {
        set.add(card.github_issue_number);
      }
    }
    return set;
  }, [repoCards]);

  const backlogIssues = useMemo(() => issues.filter((issue) => !activeIssueNumbers.has(issue.number)), [issues, activeIssueNumbers]);

  const totalVisible = filteredCards.length + backlogIssues.length;
  const openCount = filteredCards.filter((card) => !TERMINAL_STATUSES.has(card.status)).length + backlogIssues.length;
  const visibleColumns = compactBoard
    ? COLUMN_DEFS.filter((column) => column.status === mobileColumnStatus)
    : COLUMN_DEFS.filter((column) => showClosed || !TERMINAL_STATUSES.has(column.status));

  const getCardMetadata = (card: KanbanCard) => parseCardMetadata(card.metadata_json);

  const getChecklistSummary = (card: KanbanCard) => {
    const checklist = getCardMetadata(card).review_checklist ?? [];
    if (checklist.length === 0) return null;
    const done = checklist.filter((item) => item.done).length;
    return `${done}/${checklist.length}`;
  };

  const getCardDelayBadge = (card: KanbanCard) => {
    const now = Date.now();
    if (card.status === "requested" && card.requested_at) {
      const age = now - card.requested_at;
      if (age >= REQUEST_TIMEOUT_MS) {
        return { label: tr("수락 지연", "Ack delay"), tone: "#f97316", detail: formatAgeLabel(age, tr) };
      }
    }
    if (card.status === "in_progress" && card.started_at) {
      const age = now - card.started_at;
      if (age >= IN_PROGRESS_STALE_MS) {
        return { label: tr("정체", "Stalled"), tone: "#f59e0b", detail: formatAgeLabel(age, tr) };
      }
    }
    return null;
  };

  const canRetryCard = (card: KanbanCard | null) =>
    Boolean(card && ["failed", "blocked", "requested", "in_progress", "cancelled"].includes(card.status));

  const handleAddRepo = async () => {
    const repo = repoInput.trim();
    if (!repo) return;
    setRepoBusy(true);
    setActionError(null);
    try {
      const created = await api.addKanbanRepoSource(repo);
      setRepoSources((prev) => prev.some((source) => source.id === created.id) ? prev : [...prev, created]);
      setSelectedRepo(created.repo);
      setRepoInput("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr("repo 추가에 실패했습니다.", "Failed to add repo."));
    } finally {
      setRepoBusy(false);
    }
  };

  const handleRemoveRepo = async (source: KanbanRepoSource) => {
    const confirmed = window.confirm(tr(
      `이 backlog source를 제거할까요? 저장된 카드 자체는 남습니다.\n${source.repo}`,
      `Remove this backlog source? Existing cards stay intact.\n${source.repo}`,
    ));
    if (!confirmed) return;
    setRepoBusy(true);
    setActionError(null);
    try {
      await api.deleteKanbanRepoSource(source.id);
      setRepoSources((prev) => prev.filter((item) => item.id !== source.id));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr("repo 제거에 실패했습니다.", "Failed to remove repo."));
    } finally {
      setRepoBusy(false);
    }
  };

  /** Assign a backlog issue directly (auto-assign from agent:* label). */
  const handleDirectAssignIssue = async (issue: GitHubIssue, agentId: string) => {
    if (!selectedRepo) return;
    setAssigningIssue(true);
    setActionError(null);
    try {
      await onAssignIssue({
        github_repo: selectedRepo,
        github_issue_number: issue.number,
        github_issue_url: issue.url,
        title: issue.title,
        description: issue.body || null,
        assignee_agent_id: agentId,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr("이슈 할당에 실패했습니다.", "Failed to assign issue."));
    } finally {
      setAssigningIssue(false);
    }
  };

  const handleDrop = async (
    targetStatus: KanbanCardStatus,
    beforeCardId: string | null,
    event: DragEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    setDragOverStatus(null);
    setDragOverCardId(null);
    setActionError(null);

    // --- Backlog issue drop ---
    const issueJson = event.dataTransfer.getData("application/x-backlog-issue");
    if (issueJson) {
      setDraggingCardId(null);
      if (targetStatus === "backlog") return; // no-op: dropped back on backlog
      try {
        const issue = JSON.parse(issueJson) as GitHubIssue;
        const autoAgent = resolveAgentFromLabels(issue.labels);
        if (autoAgent) {
          await handleDirectAssignIssue(issue, autoAgent.id);
        } else {
          // Open modal for manual agent selection
          setAssignIssue(issue);
          const repoSource = repoSources.find((s) => s.repo === selectedRepo);
          setAssignAssigneeId(repoSource?.default_agent_id ?? "");
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : tr("이슈 할당에 실패했습니다.", "Failed to assign issue."));
      }
      return;
    }

    // --- Existing card drag ---
    const draggedId = draggingCardId;
    setDraggingCardId(null);
    if (!draggedId) return;
    if (beforeCardId === draggedId) return;
    try {
      await onUpdateCard(draggedId, {
        status: targetStatus,
        before_card_id: beforeCardId,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr("카드 이동에 실패했습니다.", "Failed to move card."));
    }
  };

  const handleSaveCard = async () => {
    if (!selectedCard) return;
    setSavingCard(true);
    setActionError(null);
    try {
      const metadata = {
        ...parseCardMetadata(selectedCard.metadata_json),
        review_checklist: editor.review_checklist
          .map((item, index) => ({
            id: item.id || `check-${index}`,
            label: item.label.trim(),
            done: item.done,
          }))
          .filter((item) => item.label),
      } satisfies KanbanCardMetadata;

      // Status is managed by quick-transition buttons, not by save.
      // Only send content fields here to avoid race conditions.
      await onUpdateCard(selectedCard.id, {
        title: editor.title.trim(),
        description: editor.description.trim() || null,
        assignee_agent_id: editor.assignee_agent_id || null,
        priority: editor.priority,
        metadata_json: stringifyCardMetadata(metadata),
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr("카드 저장에 실패했습니다.", "Failed to save card."));
    } finally {
      setSavingCard(false);
    }
  };

  const handleRetryCard = async () => {
    if (!selectedCard) return;
    setRetryingCard(true);
    setActionError(null);
    try {
      await onRetryCard(selectedCard.id, {
        assignee_agent_id: retryAssigneeId || selectedCard.assignee_agent_id,
        request_now: true,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr("재시도에 실패했습니다.", "Failed to retry card."));
    } finally {
      setRetryingCard(false);
    }
  };

  const addChecklistItem = () => {
    const label = newChecklistItem.trim();
    if (!label) return;
    setEditor((prev) => ({
      ...prev,
      review_checklist: [...prev.review_checklist, createChecklistItem(label, prev.review_checklist.length)],
    }));
    setNewChecklistItem("");
  };

  const handleDeleteCard = async () => {
    if (!selectedCard) return;
    const confirmed = window.confirm(tr("이 카드를 삭제할까요?", "Delete this card?"));
    if (!confirmed) return;
    setSavingCard(true);
    setActionError(null);
    try {
      await onDeleteCard(selectedCard.id);
      setSelectedCardId(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr("카드 삭제에 실패했습니다.", "Failed to delete card."));
    } finally {
      setSavingCard(false);
    }
  };

  const handleCloseIssue = async (issue: GitHubIssue) => {
    if (!selectedRepo) return;
    setClosingIssueNumber(issue.number);
    setActionError(null);
    try {
      await api.closeGitHubIssue(selectedRepo, issue.number);
      setIssues((prev) => prev.filter((i) => i.number !== issue.number));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr("이슈 닫기에 실패했습니다.", "Failed to close issue."));
    } finally {
      setClosingIssueNumber(null);
    }
  };

  const handleAssignIssue = async () => {
    if (!assignIssue || !selectedRepo || !assignAssigneeId) return;
    setAssigningIssue(true);
    setActionError(null);
    try {
      await onAssignIssue({
        github_repo: selectedRepo,
        github_issue_number: assignIssue.number,
        github_issue_url: assignIssue.url,
        title: assignIssue.title,
        description: assignIssue.body || null,
        assignee_agent_id: assignAssigneeId,
      });
      setAssignIssue(null);
      setAssignAssigneeId("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr("issue 할당에 실패했습니다.", "Failed to assign issue."));
    } finally {
      setAssigningIssue(false);
    }
  };

  return (
    <div className="space-y-4 pb-24 md:pb-0 min-w-0 overflow-x-hidden" style={{ paddingBottom: "max(6rem, calc(6rem + env(safe-area-inset-bottom)))" }}>
      <section
        className="rounded-2xl border p-4 sm:p-5 space-y-4 min-w-0 overflow-hidden"
        style={{
          background: "linear-gradient(135deg, rgba(15,23,42,0.92), rgba(30,41,59,0.78))",
          borderColor: "rgba(148,163,184,0.28)",
        }}
      >
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            <h2 className="text-base font-semibold shrink-0" style={{ color: "var(--th-text-heading)" }}>
              {tr("칸반", "Kanban")}
            </h2>
            <span className="text-xs shrink-0 px-2 py-0.5 rounded-full bg-white/8" style={{ color: "var(--th-text-muted)" }}>
              {initialLoading ? "…" : `${openCount}${tr("건", "")}`}
            </span>
            {repoSources.length > 1 && (
              <div className="flex gap-1 overflow-x-auto min-w-0">
                {repoSources.map((source) => (
                  <button
                    key={source.id}
                    onClick={() => setSelectedRepo(source.repo)}
                    className="shrink-0 text-[11px] px-2 py-0.5 rounded-full border truncate max-w-[140px]"
                    style={{
                      borderColor: selectedRepo === source.repo ? "rgba(96,165,250,0.5)" : "rgba(148,163,184,0.22)",
                      backgroundColor: selectedRepo === source.repo ? "rgba(59,130,246,0.18)" : "transparent",
                      color: selectedRepo === source.repo ? "#bfdbfe" : "var(--th-text-muted)",
                    }}
                  >
                    {source.repo.split("/")[1] ?? source.repo}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setSettingsOpen((prev) => !prev)}
            className="shrink-0 rounded-lg px-2 py-1.5 text-xs border"
            style={{
              borderColor: settingsOpen ? "rgba(96,165,250,0.5)" : "rgba(148,163,184,0.22)",
              color: settingsOpen ? "#93c5fd" : "var(--th-text-muted)",
              backgroundColor: settingsOpen ? "rgba(59,130,246,0.12)" : "transparent",
            }}
          >
            {settingsOpen ? tr("접기", "Close") : tr("설정", "Settings")}
          </button>
        </div>

        {settingsOpen && (
          <div className="space-y-3 min-w-0 overflow-hidden">
            <div className="flex flex-wrap gap-2">
              {repoSources.length === 0 && (
                <span className="px-3 py-2 rounded-xl text-sm border border-dashed" style={{ borderColor: "rgba(148,163,184,0.28)", color: "var(--th-text-muted)" }}>
                  {tr("먼저 backlog repo를 추가하세요.", "Add a backlog repo first.")}
                </span>
              )}
              {repoSources.map((source) => (
                <div
                  key={source.id}
                  className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 border text-sm ${selectedRepo === source.repo ? "bg-blue-500/20" : "bg-white/6"}`}
                  style={{ borderColor: selectedRepo === source.repo ? "rgba(96,165,250,0.45)" : "rgba(148,163,184,0.22)" }}
                >
                  <button
                    onClick={() => setSelectedRepo(source.repo)}
                    className="text-left truncate"
                    style={{ color: selectedRepo === source.repo ? "#dbeafe" : "var(--th-text-primary)" }}
                  >
                    {source.repo}
                  </button>
                  <button
                    onClick={() => void handleRemoveRepo(source)}
                    disabled={repoBusy}
                    className="text-xs"
                    style={{ color: "var(--th-text-muted)" }}
                  >
                    {tr("삭제", "Remove")}
                  </button>
                </div>
              ))}
            </div>

            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <input
                list="kanban-repo-options"
                value={repoInput}
                onChange={(event) => setRepoInput(event.target.value)}
                placeholder={tr("owner/repo 입력 또는 선택", "Type or pick owner/repo")}
                className="min-w-0 rounded-xl px-3 py-2 text-sm bg-black/20 border"
                style={{ borderColor: "rgba(148,163,184,0.28)", color: "var(--th-text-primary)" }}
              />
              <datalist id="kanban-repo-options">
                {availableRepos.map((repo) => (
                  <option key={repo.nameWithOwner} value={repo.nameWithOwner} />
                ))}
              </datalist>
              <button
                onClick={() => void handleAddRepo()}
                disabled={repoBusy || !repoInput.trim()}
                className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-50 w-full sm:w-auto"
                style={{ backgroundColor: "#2563eb" }}
              >
                {repoBusy ? tr("처리 중", "Working") : tr("Repo 추가", "Add repo")}
              </button>
            </div>

            <div className="flex flex-col gap-2 w-full">
              <label className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm border bg-black/20" style={{ borderColor: "rgba(148,163,184,0.28)", color: "var(--th-text-secondary)" }}>
                <input
                  type="checkbox"
                  checked={showClosed}
                  onChange={(event) => setShowClosed(event.target.checked)}
                />
                {tr("닫힌 컬럼 표시", "Show closed columns")}
              </label>
              {selectedRepo && (() => {
                const currentSource = repoSources.find((s) => s.repo === selectedRepo);
                if (!currentSource) return null;
                return (
                  <label className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm border bg-black/20" style={{ borderColor: "rgba(148,163,184,0.28)", color: "var(--th-text-secondary)" }}>
                    <span className="shrink-0">{tr("기본 담당자", "Default agent")}</span>
                    <select
                      value={currentSource.default_agent_id ?? ""}
                      onChange={(event) => {
                        const value = event.target.value || null;
                        void api.updateKanbanRepoSource(currentSource.id, { default_agent_id: value });
                        setRepoSources((prev) => prev.map((s) => s.id === currentSource.id ? { ...s, default_agent_id: value } : s));
                      }}
                      className="min-w-0 flex-1 rounded-lg px-2 py-1 text-xs bg-white/6 border"
                      style={{ borderColor: "rgba(148,163,184,0.2)", color: "var(--th-text-primary)" }}
                    >
                      <option value="">{tr("없음", "None")}</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>{getAgentLabel(agent.id)}</option>
                      ))}
                    </select>
                  </label>
                );
              })()}
            </div>

            <div className="grid gap-2 md:grid-cols-3">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={tr("제목 / 설명 / 담당자 검색", "Search title / description / assignee")}
                className="rounded-xl px-3 py-2 text-sm bg-black/20 border"
                style={{ borderColor: "rgba(148,163,184,0.28)", color: "var(--th-text-primary)" }}
              />
              <select
                value={agentFilter}
                onChange={(event) => setAgentFilter(event.target.value)}
                className="rounded-xl px-3 py-2 text-sm bg-black/20 border"
                style={{ borderColor: "rgba(148,163,184,0.28)", color: "var(--th-text-primary)" }}
              >
                <option value="all">{tr("전체 에이전트", "All agents")}</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{getAgentLabel(agent.id)}</option>
                ))}
              </select>
              <select
                value={deptFilter}
                onChange={(event) => setDeptFilter(event.target.value)}
                className="rounded-xl px-3 py-2 text-sm bg-black/20 border"
                style={{ borderColor: "rgba(148,163,184,0.28)", color: "var(--th-text-primary)" }}
              >
                <option value="all">{tr("전체 부서", "All departments")}</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>{localeName(locale, department)}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {actionError && (
          <div className="rounded-xl px-3 py-2 text-sm border" style={{ borderColor: "rgba(248,113,113,0.45)", color: "#fecaca", backgroundColor: "rgba(127,29,29,0.22)" }}>
            {actionError}
          </div>
        )}
      </section>

      {selectedRepo && (
        <>
          <AutoQueuePanel
            tr={tr}
            locale={locale}
            agents={agents}
            selectedRepo={selectedRepo}
          />
          <PipelineEditor
            tr={tr}
            locale={locale}
            repo={selectedRepo}
            agents={agents}
          />
        </>
      )}

      {/* ── Recent completions ── */}
      {selectedRepo && recentDoneCards.length > 0 && (() => {
        const PAGE_SIZE = 10;
        const totalPages = Math.ceil(recentDoneCards.length / PAGE_SIZE);
        const page = Math.min(recentDonePage, totalPages - 1);
        const pageCards = recentDoneCards.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        return (
          <section className="rounded-2xl border px-4 py-3" style={{ borderColor: "rgba(148,163,184,0.18)", background: "rgba(34,197,94,0.04)" }}>
            <button
              onClick={() => setRecentDoneOpen((v) => !v)}
              className="flex w-full items-center gap-2 text-left"
            >
              <span className="text-xs font-semibold uppercase" style={{ color: "var(--th-text-muted)" }}>
                {tr("최근 완료", "Recent Completions")}
              </span>
              <span className="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style={{ background: "rgba(34,197,94,0.18)", color: "#4ade80" }}>
                {recentDoneCards.length}
              </span>
              <span className="ml-auto text-xs" style={{ color: "var(--th-text-muted)" }}>
                {recentDoneOpen ? "▲" : "▼"}
              </span>
            </button>
            {recentDoneOpen && (
              <div className="mt-2 space-y-1.5">
                {pageCards.map((card) => {
                  const statusDef = COLUMN_DEFS.find((c) => c.status === card.status);
                  const agentName = getAgentLabel(card.assignee_agent_id);
                  const completedDate = card.completed_at
                    ? new Date(card.completed_at).toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric" })
                    : "";
                  return (
                    <button
                      key={card.id}
                      onClick={() => setSelectedCardId(card.id)}
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:brightness-125"
                      style={{ background: "rgba(148,163,184,0.06)" }}
                    >
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ background: `${statusDef?.accent ?? "#22c55e"}22`, color: statusDef?.accent ?? "#22c55e" }}
                      >
                        {card.status === "done" ? tr("완료", "Done") : tr("취소", "Cancelled")}
                      </span>
                      {card.github_issue_number && (
                        <span className="shrink-0 text-xs" style={{ color: "var(--th-text-muted)" }}>#{card.github_issue_number}</span>
                      )}
                      <span className="min-w-0 flex-1 truncate" style={{ color: "var(--th-text-primary)" }}>{card.title}</span>
                      <span className="shrink-0 text-[11px]" style={{ color: "var(--th-text-muted)" }}>{agentName}</span>
                      <span className="shrink-0 text-[11px]" style={{ color: "var(--th-text-muted)" }}>{completedDate}</span>
                    </button>
                  );
                })}
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-3 pt-1">
                    <button
                      disabled={page === 0}
                      onClick={() => setRecentDonePage((p) => Math.max(0, p - 1))}
                      className="rounded px-2 py-0.5 text-xs disabled:opacity-30"
                      style={{ color: "var(--th-text-muted)" }}
                    >
                      ← {tr("이전", "Prev")}
                    </button>
                    <span className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                      {page + 1} / {totalPages}
                    </span>
                    <button
                      disabled={page >= totalPages - 1}
                      onClick={() => setRecentDonePage((p) => Math.min(totalPages - 1, p + 1))}
                      className="rounded px-2 py-0.5 text-xs disabled:opacity-30"
                      style={{ color: "var(--th-text-muted)" }}
                    >
                      {tr("다음", "Next")} →
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })()}

      {!selectedRepo ? (
        <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm" style={{ borderColor: "rgba(148,163,184,0.22)", color: "var(--th-text-muted)" }}>
          {tr("repo를 추가하면 repo별 backlog와 칸반을 볼 수 있습니다.", "Add a repo to view its backlog and board.")}
        </div>
      ) : (
        <div className="space-y-3">
          {compactBoard && (
            <>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {COLUMN_DEFS.filter((column) => showClosed || !TERMINAL_STATUSES.has(column.status)).map((column) => (
                  <button
                    key={column.status}
                    onClick={() => setMobileColumnStatus(column.status)}
                    className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border"
                    style={{
                      borderColor: mobileColumnStatus === column.status ? `${column.accent}88` : "rgba(148,163,184,0.24)",
                      backgroundColor: mobileColumnStatus === column.status ? `${column.accent}22` : "rgba(255,255,255,0.04)",
                      color: mobileColumnStatus === column.status ? "white" : "var(--th-text-secondary)",
                    }}
                  >
                    {tr(column.labelKo, column.labelEn)}
                  </button>
                ))}
              </div>
              <div className="rounded-xl border px-3 py-2 text-xs" style={{ borderColor: "rgba(148,163,184,0.18)", color: "var(--th-text-muted)", backgroundColor: "rgba(15,23,42,0.35)" }}>
                {tr("모바일에서는 카드를 탭해 상세 패널에서 상태를 변경하세요.", "On mobile, tap a card and change status in the detail sheet.")}
              </div>
            </>
          )}

          <div className={compactBoard ? "" : "overflow-x-auto pb-2"}>
            <div className={compactBoard ? "space-y-4" : "flex items-start gap-4 min-w-max"}>
              {visibleColumns.map((column) => {
              const columnCards = cardsByStatus.get(column.status) ?? [];
              const backlogCount = column.status === "backlog" ? columnCards.length + backlogIssues.length : columnCards.length;
              return (
                <section
                  key={column.status}
                  className={`${compactBoard ? "w-full" : "w-[320px] shrink-0"} rounded-2xl border p-3 space-y-3`}
                  style={{
                    borderColor: dragOverStatus === column.status ? column.accent : "rgba(148,163,184,0.24)",
                    backgroundColor: "rgba(15,23,42,0.55)",
                  }}
                  onDragOver={(event) => {
                    if (compactBoard) return;
                    event.preventDefault();
                    setDragOverStatus(column.status);
                    setDragOverCardId(null);
                  }}
                  onDrop={(event) => {
                    if (compactBoard) return;
                    void handleDrop(column.status, null, event);
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: column.accent }} />
                      <h3 className="font-semibold" style={{ color: "var(--th-text-heading)" }}>
                        {tr(column.labelKo, column.labelEn)}
                      </h3>
                    </div>
                    <span className="px-2 py-0.5 rounded-full text-xs bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                      {(initialLoading || (column.status === "backlog" && loadingIssues)) ? "…" : backlogCount}
                    </span>
                  </div>

                  <div className="space-y-2 min-h-12">
                    {column.status === "backlog" && loadingIssues && (
                      <div className="rounded-xl border border-dashed px-3 py-4 text-xs text-center" style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-muted)" }}>
                        {tr("GitHub backlog 로딩 중...", "Loading GitHub backlog...")}
                      </div>
                    )}

                    {column.status === "backlog" && backlogIssues.map((issue) => (
                      <article
                        key={`issue-${issue.number}`}
                        className="rounded-2xl border p-3 cursor-pointer transition-colors hover:border-[rgba(148,163,184,0.4)]"
                        style={{ borderColor: "rgba(148,163,184,0.2)", backgroundColor: "rgba(2,6,23,0.82)" }}
                        onClick={() => setSelectedBacklogIssue(issue)}
                        draggable={!compactBoard}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("application/x-backlog-issue", JSON.stringify(issue));
                          event.dataTransfer.effectAllowed = "move";
                        }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="px-2 py-0.5 rounded-full text-[11px] bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                                #{issue.number}
                              </span>
                              {issue.labels.slice(0, 2).map((label) => (
                                <span
                                  key={label.name}
                                  className="px-2 py-0.5 rounded-full text-[11px]"
                                  style={{ backgroundColor: `#${label.color}22`, color: `#${label.color}` }}
                                >
                                  {label.name}
                                </span>
                              ))}
                            </div>
                            <h4 className="mt-2 text-sm font-semibold leading-snug" style={{ color: "var(--th-text-heading)" }}>
                              {issue.title}
                            </h4>
                          </div>
                          <a
                            href={issue.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs hover:underline"
                            style={{ color: "#93c5fd" }}
                            onClick={(event) => event.stopPropagation()}
                          >
                            GH
                          </a>
                        </div>
                        <div className="mt-3 flex flex-col items-start gap-2 text-xs sm:flex-row sm:items-center sm:justify-between" style={{ color: "var(--th-text-muted)" }}>
                          <span>{tr("업데이트", "Updated")}: {formatIso(issue.updatedAt, locale)}</span>
                          <div className="flex gap-2">
                            <button
                              onClick={(event) => { event.stopPropagation(); void handleCloseIssue(issue); }}
                              disabled={closingIssueNumber === issue.number}
                              className="rounded-lg px-3 py-1.5 border disabled:opacity-50"
                              style={{ borderColor: "rgba(148,163,184,0.28)", color: "var(--th-text-muted)" }}
                            >
                              {closingIssueNumber === issue.number ? tr("닫는 중", "Closing") : tr("닫기", "Close")}
                            </button>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                const autoAgent = resolveAgentFromLabels(issue.labels);
                                if (autoAgent) {
                                  void handleDirectAssignIssue(issue, autoAgent.id);
                                } else {
                                  setAssignIssue(issue);
                                  const repoSource = repoSources.find((s) => s.repo === selectedRepo);
                                  setAssignAssigneeId(repoSource?.default_agent_id ?? "");
                                }
                              }}
                              disabled={assigningIssue}
                              className="rounded-lg px-3 py-1.5 text-white disabled:opacity-50"
                              style={{ backgroundColor: column.accent }}
                            >
                              {(() => {
                                const autoAgent = resolveAgentFromLabels(issue.labels);
                                if (autoAgent) return `→ ${getAgentLabel(autoAgent.id)}`;
                                return tr("할당", "Assign");
                              })()}
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}

                    {backlogCount === 0 && !initialLoading && !(column.status === "backlog" && loadingIssues) && (
                      <div className="rounded-xl border border-dashed px-3 py-4 text-xs text-center" style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-muted)" }}>
                        {column.status === "backlog"
                          ? tr("repo backlog가 비어 있습니다.", "This repo backlog is empty.")
                          : tr("여기에 드롭", "Drop here")}
                      </div>
                    )}

                    {columnCards.map((card) => {
                      const latestDispatch = card.latest_dispatch_id ? dispatchMap.get(card.latest_dispatch_id) : undefined;
                      const metadata = getCardMetadata(card);
                      const checklistSummary = getChecklistSummary(card);
                      const delayBadge = getCardDelayBadge(card);
                      return (
                        <article
                          key={card.id}
                          draggable={!compactBoard}
                          onDragStart={(event) => {
                            if (compactBoard) return;
                            setDraggingCardId(card.id);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", card.id);
                          }}
                          onDragEnd={() => {
                            setDraggingCardId(null);
                            setDragOverStatus(null);
                            setDragOverCardId(null);
                          }}
                          onDragOver={(event) => {
                            if (compactBoard) return;
                            event.preventDefault();
                            setDragOverStatus(column.status);
                            setDragOverCardId(card.id);
                          }}
                          onDrop={(event) => {
                            if (compactBoard) return;
                            void handleDrop(column.status, card.id, event);
                          }}
                          onClick={() => setSelectedCardId(card.id)}
                          className="rounded-2xl border p-3 cursor-pointer transition-transform hover:-translate-y-0.5"
                          style={{
                            borderColor: dragOverCardId === card.id ? column.accent : "rgba(148,163,184,0.2)",
                            backgroundColor: "rgba(2,6,23,0.82)",
                            opacity: draggingCardId === card.id ? 0.45 : 1,
                          }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="px-2 py-0.5 rounded-full text-[11px]" style={{ color: "white", backgroundColor: column.accent }}>
                                  {priorityLabel(card.priority, tr)}
                                </span>
                                {card.github_issue_number && (
                                  <span className="px-2 py-0.5 rounded-full text-[11px] bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                                    #{card.github_issue_number}
                                  </span>
                                )}
                                {card.depth > 0 && (
                                  <span className="px-2 py-0.5 rounded-full text-[11px] bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                                    {tr("체인", "Chain")} {card.depth}
                                  </span>
                                )}
                                {metadata.retry_count ? (
                                  <span className="px-2 py-0.5 rounded-full text-[11px] bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                                    {tr("재시도", "Retry")} {metadata.retry_count}
                                  </span>
                                ) : null}
                                {metadata.failover_count ? (
                                  <span className="px-2 py-0.5 rounded-full text-[11px] bg-white/8" style={{ color: "#fca5a5" }}>
                                    {tr("Failover", "Failover")} {metadata.failover_count}
                                  </span>
                                ) : null}
                                {checklistSummary && (
                                  <span className="px-2 py-0.5 rounded-full text-[11px] bg-white/8" style={{ color: "#99f6e4" }}>
                                    {tr("리뷰", "Review")} {checklistSummary}
                                  </span>
                                )}
                                {delayBadge && (
                                  <span className="px-2 py-0.5 rounded-full text-[11px]" style={{ color: "white", backgroundColor: delayBadge.tone }}>
                                    {delayBadge.label} {delayBadge.detail}
                                  </span>
                                )}
                              </div>
                              <h4 className="mt-2 text-sm font-semibold leading-snug" style={{ color: "var(--th-text-heading)" }}>
                                {card.title}
                              </h4>
                            </div>
                            <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                              {card.github_issue_number ? `#${card.github_issue_number}` : `#${card.id.slice(0, 6)}`}
                            </span>
                          </div>

                          {card.description && (() => {
                            const sections = parseIssueSections(card.description);
                            const displayText = sections?.content ?? card.description;
                            return (
                              <div className="mt-2 text-xs" style={{ color: "var(--th-text-secondary)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                <MarkdownContent content={displayText} />
                              </div>
                            );
                          })()}

                          {card.status === "blocked" && card.blocked_reason && (
                            <div className="mt-2 rounded-md px-2.5 py-2 text-xs" style={{ backgroundColor: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", color: "#fca5a5" }}>
                              <span className="font-semibold">{tr("차단 사유", "Blocked reason")}:</span>{" "}
                              {card.blocked_reason}
                            </div>
                          )}

                          {card.status === "review" && card.review_status && (
                            <div className="mt-2 rounded-md px-2.5 py-2 text-xs" style={{
                              backgroundColor: card.review_status === "dilemma_pending" ? "rgba(234,179,8,0.12)" : card.review_status === "improve_rework" ? "rgba(249,115,22,0.12)" : "rgba(20,184,166,0.12)",
                              border: `1px solid ${card.review_status === "dilemma_pending" ? "rgba(234,179,8,0.3)" : card.review_status === "improve_rework" ? "rgba(249,115,22,0.3)" : "rgba(20,184,166,0.3)"}`,
                              color: card.review_status === "dilemma_pending" ? "#fde047" : card.review_status === "improve_rework" ? "#fdba74" : "#5eead4",
                            }}>
                              {card.review_status === "reviewing" && tr("카운터 모델 리뷰 중", "Counter-model reviewing")}
                              {card.review_status === "awaiting_dod" && tr("DoD 완료 대기", "Awaiting DoD completion")}
                              {card.review_status === "improve_rework" && tr("개선 재작업 중", "Improvement rework")}
                              {card.review_status === "dilemma_pending" && tr("판단 대기 (딜레마)", "Dilemma pending")}
                              {card.review_status === "decided" && tr("결정됨", "Decided")}
                            </div>
                          )}

                          <div className="mt-3 space-y-1.5 text-xs" style={{ color: "var(--th-text-muted)" }}>
                            <div>{tr("담당자", "Assignee")}: {getAgentLabel(card.assignee_agent_id)}</div>
                            {latestDispatch && <div>{tr("디스패치", "Dispatch")}: {latestDispatch.status}</div>}
                            {metadata.reward && (
                              <div>{tr("완료 보상", "Completion reward")}: +{metadata.reward.xp} XP</div>
                            )}
                            {card.github_issue_url && (
                              <a
                                href={card.github_issue_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex hover:underline"
                                onClick={(event) => event.stopPropagation()}
                                style={{ color: "#93c5fd" }}
                              >
                                {tr("GitHub 이슈", "GitHub issue")}
                              </a>
                            )}
                          </div>

                          {/* Mobile-only quick transition buttons (PC uses drag & drop) */}
                          {(STATUS_TRANSITIONS[card.status] ?? []).length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5 sm:hidden">
                              {(STATUS_TRANSITIONS[card.status] ?? []).map((target) => {
                                const style = TRANSITION_STYLE[target] ?? TRANSITION_STYLE.backlog;
                                return (
                                  <button
                                    key={target}
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void (async () => {
                                        setActionError(null);
                                        try {
                                          await onUpdateCard(card.id, { status: target });
                                        } catch (error) {
                                          setActionError(error instanceof Error ? error.message : tr("상태 전환에 실패했습니다.", "Failed to change status."));
                                        }
                                      })();
                                    }}
                                    className="rounded-lg px-2.5 py-1 text-[11px] font-medium border"
                                    style={{
                                      backgroundColor: style.bg,
                                      borderColor: style.text,
                                      color: style.text,
                                    }}
                                  >
                                    → {labelForStatus(target)}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            </div>
          </div>
        </div>
      )}

      {assignIssue && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end justify-center sm:items-center p-0 sm:p-4">
          <div
            className="w-full max-w-lg rounded-t-3xl border p-5 sm:rounded-3xl sm:p-6 space-y-4"
            style={{
              backgroundColor: "rgba(2,6,23,0.96)",
              borderColor: "rgba(148,163,184,0.24)",
              paddingBottom: "max(6rem, calc(6rem + env(safe-area-inset-bottom)))",
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                  {selectedRepo} #{assignIssue.number}
                </div>
                <h3 className="mt-1 text-lg font-semibold" style={{ color: "var(--th-text-heading)" }}>
                  {assignIssue.title}
                </h3>
              </div>
              <button
                onClick={() => setAssignIssue(null)}
                className="shrink-0 whitespace-nowrap rounded-xl px-3 py-2 text-sm bg-white/8"
                style={{ color: "var(--th-text-secondary)" }}
              >
                {tr("닫기", "Close")}
              </button>
            </div>

            <label className="space-y-1 block">
              <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("담당자", "Assignee")}</span>
              <select
                value={assignAssigneeId}
                onChange={(event) => setAssignAssigneeId(event.target.value)}
                className="w-full rounded-xl px-3 py-2 text-sm bg-white/6 border"
                style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-primary)" }}
              >
                <option value="">{tr("에이전트 선택", "Select an agent")}</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{getAgentLabel(agent.id)}</option>
                ))}
              </select>
            </label>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                onClick={() => setAssignIssue(null)}
                className="rounded-xl px-4 py-2 text-sm bg-white/8"
                style={{ color: "var(--th-text-secondary)" }}
              >
                {tr("취소", "Cancel")}
              </button>
              <button
                onClick={() => void handleAssignIssue()}
                disabled={assigningIssue || !assignAssigneeId}
                className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: "#2563eb" }}
              >
                {assigningIssue ? tr("할당 중", "Assigning") : tr("ready로 할당", "Assign to ready")}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedCard && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end justify-center sm:items-center p-0 sm:p-4" onClick={() => setSelectedCardId(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl max-h-[88svh] overflow-y-auto rounded-t-3xl border p-5 sm:max-h-[90vh] sm:rounded-3xl sm:p-6 space-y-4"
            style={{
              backgroundColor: "rgba(2,6,23,0.96)",
              borderColor: "rgba(148,163,184,0.24)",
              paddingBottom: "max(6rem, calc(6rem + env(safe-area-inset-bottom)))",
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full text-xs bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                    {labelForStatus(selectedCard.status)}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-xs bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                    {priorityLabel(selectedCard.priority, tr)}
                  </span>
                  {selectedCard.github_repo && (
                    <span className="px-2 py-0.5 rounded-full text-xs bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                      {selectedCard.github_repo}
                    </span>
                  )}
                </div>
                <h3 className="mt-2 text-xl font-semibold" style={{ color: "var(--th-text-heading)" }}>
                  {selectedCard.title}
                </h3>
              </div>
              <button
                onClick={() => setSelectedCardId(null)}
                className="shrink-0 whitespace-nowrap rounded-xl px-3 py-2 text-sm bg-white/8"
                style={{ color: "var(--th-text-secondary)" }}
              >
                {tr("닫기", "Close")}
              </button>
            </div>

            {/* Pipeline progress visualization */}
            {selectedCard.pipeline_stage_id && (
              <PipelineProgress
                tr={tr}
                locale={locale}
                cardId={selectedCard.id}
                currentStageId={selectedCard.pipeline_stage_id}
              />
            )}

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("제목", "Title")}</span>
                <input
                  value={editor.title}
                  onChange={(event) => setEditor((prev) => ({ ...prev, title: event.target.value }))}
                  className="w-full rounded-xl px-3 py-2 text-sm bg-white/6 border"
                  style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-primary)" }}
                />
              </label>
              <div className="space-y-1">
                <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("상태 전환", "Status")}</span>
                <div className="flex flex-wrap gap-1.5">
                  {(STATUS_TRANSITIONS[selectedCard.status] ?? []).map((target) => {
                    const style = TRANSITION_STYLE[target] ?? TRANSITION_STYLE.backlog;
                    return (
                      <button
                        key={target}
                        type="button"
                        disabled={savingCard}
                        onClick={async () => {
                          if (target === "done" && editor.review_checklist.some((item) => !item.done)) {
                            setActionError(tr("review checklist를 모두 완료해야 done으로 이동할 수 있습니다.", "Complete the review checklist before moving to done."));
                            return;
                          }
                          setSavingCard(true);
                          setActionError(null);
                          try {
                            await onUpdateCard(selectedCard.id, { status: target });
                            setEditor((prev) => ({ ...prev, status: target }));
                          } catch (error) {
                            setActionError(error instanceof Error ? error.message : tr("상태 전환에 실패했습니다.", "Failed to change status."));
                          } finally {
                            setSavingCard(false);
                          }
                        }}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium border transition-opacity hover:opacity-80 disabled:opacity-40"
                        style={{
                          backgroundColor: style.bg,
                          borderColor: style.text,
                          color: style.text,
                        }}
                      >
                        → {labelForStatus(target)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <label className="space-y-1">
                <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("담당자", "Assignee")}</span>
                <select
                  value={editor.assignee_agent_id}
                  onChange={(event) => setEditor((prev) => ({ ...prev, assignee_agent_id: event.target.value }))}
                  className="w-full rounded-xl px-3 py-2 text-sm bg-white/6 border"
                  style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-primary)" }}
                >
                  <option value="">{tr("없음", "None")}</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{getAgentLabel(agent.id)}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("우선순위", "Priority")}</span>
                <select
                  value={editor.priority}
                  onChange={(event) => setEditor((prev) => ({ ...prev, priority: event.target.value as KanbanCardPriority }))}
                  className="w-full rounded-xl px-3 py-2 text-sm bg-white/6 border"
                  style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-primary)" }}
                >
                  {PRIORITY_OPTIONS.map((priority) => (
                    <option key={priority} value={priority}>{priorityLabel(priority, tr)}</option>
                  ))}
                </select>
              </label>
              <div className="rounded-2xl border p-3 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("GitHub", "GitHub")}</div>
                <div style={{ color: "var(--th-text-primary)" }}>
                  {selectedCard.github_issue_url ? (
                    <a href={selectedCard.github_issue_url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "#93c5fd" }}>
                      #{selectedCard.github_issue_number ?? "-"}
                    </a>
                  ) : (
                    selectedCard.github_issue_number ? `#${selectedCard.github_issue_number}` : "-"
                  )}
                </div>
              </div>
            </div>

            {/* Blocked reason */}
            {selectedCard.status === "blocked" && selectedCard.blocked_reason && (
              <div className="rounded-2xl border p-4" style={{ backgroundColor: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.3)" }}>
                <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "#ef4444" }}>
                  {tr("차단 사유", "Blocked Reason")}
                </div>
                <div className="text-sm" style={{ color: "#fca5a5" }}>
                  {selectedCard.blocked_reason}
                </div>
              </div>
            )}

            {/* Review status */}
            {selectedCard.status === "review" && selectedCard.review_status && (
              <div className="rounded-2xl border p-4" style={{
                backgroundColor: selectedCard.review_status === "dilemma_pending" ? "rgba(234,179,8,0.08)" : selectedCard.review_status === "improve_rework" ? "rgba(249,115,22,0.08)" : "rgba(20,184,166,0.08)",
                borderColor: selectedCard.review_status === "dilemma_pending" ? "rgba(234,179,8,0.3)" : selectedCard.review_status === "improve_rework" ? "rgba(249,115,22,0.3)" : "rgba(20,184,166,0.3)",
              }}>
                <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{
                  color: selectedCard.review_status === "dilemma_pending" ? "#eab308" : selectedCard.review_status === "improve_rework" ? "#f97316" : "#14b8a6",
                }}>
                  {tr("카운터 모델 리뷰", "Counter-Model Review")}
                </div>
                <div className="text-sm" style={{
                  color: selectedCard.review_status === "dilemma_pending" ? "#fde047" : selectedCard.review_status === "improve_rework" ? "#fdba74" : "#5eead4",
                }}>
                  {selectedCard.review_status === "reviewing" && tr("카운터 모델이 코드를 리뷰하고 있습니다...", "Counter model is reviewing...")}
                  {selectedCard.review_status === "awaiting_dod" && tr("DoD 항목이 모두 완료되면 자동 리뷰가 시작됩니다.", "Auto review starts when all DoD items are complete.")}
                  {selectedCard.review_status === "improve_rework" && tr("개선 사항이 발견되어 원본 모델에 재작업을 요청했습니다.", "Improvements needed — rework dispatched to original model.")}
                  {selectedCard.review_status === "dilemma_pending" && tr("판단이 어려운 항목이 있습니다. 수동으로 결정해 주세요.", "Dilemma items found — manual decision needed.")}
                  {selectedCard.review_status === "decided" && tr("리뷰 결정이 완료되었습니다.", "Review decision completed.")}
                </div>
              </div>
            )}

            {/* Dilemma decision UI */}
            {selectedCard.review_status === "dilemma_pending" && reviewData && (() => {
              const items: Array<{ id: string; category: string; summary: string; detail?: string; suggestion?: string; pros?: string; cons?: string; decision?: string }> =
                reviewData.items_json ? JSON.parse(reviewData.items_json) : [];
              const dilemmaItems = items.filter((i) => i.category === "dilemma");
              if (dilemmaItems.length === 0) return null;
              const allDecided = dilemmaItems.every((i) => reviewDecisions[i.id]);
              return (
                <div className="rounded-2xl border p-4 space-y-4" style={{
                  borderColor: "rgba(234,179,8,0.35)",
                  backgroundColor: "rgba(234,179,8,0.06)",
                }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "#eab308" }}>
                      {tr("리뷰 제안 사항", "Review Suggestions")}
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{
                      backgroundColor: allDecided ? "rgba(34,197,94,0.18)" : "rgba(234,179,8,0.18)",
                      color: allDecided ? "#4ade80" : "#fde047",
                    }}>
                      {Object.keys(reviewDecisions).filter((k) => dilemmaItems.some((d) => d.id === k)).length}/{dilemmaItems.length}
                    </span>
                  </div>
                  <div className="space-y-3">
                    {dilemmaItems.map((item) => {
                      const decision = reviewDecisions[item.id];
                      return (
                        <div key={item.id} className="rounded-xl border p-3 space-y-2" style={{
                          borderColor: decision === "accept" ? "rgba(34,197,94,0.35)" : decision === "reject" ? "rgba(239,68,68,0.35)" : "rgba(148,163,184,0.22)",
                          backgroundColor: decision === "accept" ? "rgba(34,197,94,0.06)" : decision === "reject" ? "rgba(239,68,68,0.06)" : "rgba(255,255,255,0.03)",
                        }}>
                          <div className="text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
                            {item.summary}
                          </div>
                          {item.detail && (
                            <div className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                              {item.detail}
                            </div>
                          )}
                          {item.suggestion && (
                            <div className="text-xs px-2 py-1 rounded-lg" style={{ backgroundColor: "rgba(96,165,250,0.08)", color: "#93c5fd" }}>
                              {tr("제안", "Suggestion")}: {item.suggestion}
                            </div>
                          )}
                          {(item.pros || item.cons) && (
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              {item.pros && (
                                <div className="px-2 py-1 rounded-lg" style={{ backgroundColor: "rgba(34,197,94,0.08)", color: "#86efac" }}>
                                  {tr("장점", "Pros")}: {item.pros}
                                </div>
                              )}
                              {item.cons && (
                                <div className="px-2 py-1 rounded-lg" style={{ backgroundColor: "rgba(239,68,68,0.08)", color: "#fca5a5" }}>
                                  {tr("단점", "Cons")}: {item.cons}
                                </div>
                              )}
                            </div>
                          )}
                          <div className="flex gap-2 pt-1">
                            <button
                              onClick={() => {
                                setReviewDecisions((prev) => ({ ...prev, [item.id]: "accept" }));
                                void api.saveReviewDecisions(reviewData.id, [{ item_id: item.id, decision: "accept" }]).catch(() => {});
                              }}
                              className="flex-1 rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors"
                              style={{
                                borderColor: decision === "accept" ? "rgba(34,197,94,0.6)" : "rgba(148,163,184,0.28)",
                                backgroundColor: decision === "accept" ? "rgba(34,197,94,0.2)" : "transparent",
                                color: decision === "accept" ? "#4ade80" : "var(--th-text-secondary)",
                              }}
                            >
                              {tr("수용", "Accept")}
                            </button>
                            <button
                              onClick={() => {
                                setReviewDecisions((prev) => ({ ...prev, [item.id]: "reject" }));
                                void api.saveReviewDecisions(reviewData.id, [{ item_id: item.id, decision: "reject" }]).catch(() => {});
                              }}
                              className="flex-1 rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors"
                              style={{
                                borderColor: decision === "reject" ? "rgba(239,68,68,0.6)" : "rgba(148,163,184,0.28)",
                                backgroundColor: decision === "reject" ? "rgba(239,68,68,0.2)" : "transparent",
                                color: decision === "reject" ? "#f87171" : "var(--th-text-secondary)",
                              }}
                            >
                              {tr("불수용", "Reject")}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    disabled={!allDecided || reviewBusy}
                    onClick={async () => {
                      setReviewBusy(true);
                      setActionError(null);
                      try {
                        await api.triggerDecidedRework(reviewData.id);
                        setReviewData(null);
                        setReviewDecisions({});
                      } catch (error) {
                        setActionError(error instanceof Error ? error.message : tr("재디스패치에 실패했습니다.", "Failed to trigger rework."));
                      } finally {
                        setReviewBusy(false);
                      }
                    }}
                    className="w-full rounded-xl px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 transition-colors"
                    style={{
                      backgroundColor: allDecided ? "#eab308" : "rgba(234,179,8,0.3)",
                    }}
                  >
                    {reviewBusy
                      ? tr("재디스패치 중...", "Dispatching rework...")
                      : allDecided
                        ? tr("결정 완료 → 재디스패치", "Decisions Complete → Dispatch Rework")
                        : tr("모든 항목에 결정을 내려주세요", "Decide all items first")}
                  </button>
                </div>
              );
            })()}

            {/* Description / Issue Sections */}
            {(() => {
              const parsed = parseIssueSections(editor.description);
              if (!parsed) {
                // Fallback: non-PMD format → show as markdown
                return (
                  <div className="space-y-1">
                    <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("설명", "Description")}</span>
                    {editor.description ? (
                      <div
                        className="rounded-2xl border p-4 bg-white/5 text-sm"
                        style={{ borderColor: "rgba(148,163,184,0.18)", color: "var(--th-text-primary)" }}
                      >
                        <MarkdownContent content={editor.description} />
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed px-3 py-4 text-xs text-center" style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-muted)" }}>
                        {tr("설명이 없습니다.", "No description.")}
                      </div>
                    )}
                  </div>
                );
              }

              // Structured view for PMD-format issues
              return (
                <div className="space-y-3">
                  {/* 배경 */}
                  {parsed.background && (
                    <div className="rounded-2xl border p-4 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                      <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--th-text-muted)" }}>
                        {tr("배경", "Background")}
                      </div>
                      <div className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                        <MarkdownContent content={parsed.background} />
                      </div>
                    </div>
                  )}

                  {/* 내용 */}
                  {parsed.content && (
                    <div className="rounded-2xl border p-4 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                      <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--th-text-muted)" }}>
                        {tr("내용", "Content")}
                      </div>
                      <div className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                        <MarkdownContent content={parsed.content} />
                      </div>
                    </div>
                  )}

                  {/* DoD Checklist */}
                  {editor.review_checklist.length > 0 && (() => {
                    const isGitHubLinked = Boolean(selectedCard.github_issue_number);
                    return (
                    <div className="rounded-2xl border p-4 bg-white/5 space-y-3" style={{ borderColor: "rgba(20,184,166,0.3)" }}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "#2dd4bf" }}>
                          DoD (Definition of Done)
                          {isGitHubLinked && (
                            <span className="ml-2 text-[9px] font-normal normal-case tracking-normal" style={{ color: "var(--th-text-muted)" }}>
                              {tr("(GitHub 정본)", "(synced from GitHub)")}
                            </span>
                          )}
                        </div>
                        <span className="text-xs px-2 py-1 rounded-full bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                          {editor.review_checklist.filter((item) => item.done).length}/{editor.review_checklist.length}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {editor.review_checklist.map((item) => (
                          <label
                            key={item.id}
                            className="flex items-center gap-3 rounded-xl px-3 py-2"
                            style={{ backgroundColor: "rgba(255,255,255,0.04)", opacity: isGitHubLinked ? 0.85 : 1 }}
                          >
                            <input
                              type="checkbox"
                              checked={item.done}
                              disabled={isGitHubLinked}
                              onChange={isGitHubLinked ? undefined : (event) => setEditor((prev) => ({
                                ...prev,
                                review_checklist: prev.review_checklist.map((current) =>
                                  current.id === item.id ? { ...current, done: event.target.checked } : current,
                                ),
                              }))}
                            />
                            <span
                              className="min-w-0 flex-1 text-sm"
                              style={{
                                color: item.done ? "var(--th-text-secondary)" : "var(--th-text-primary)",
                                textDecoration: item.done ? "line-through" : "none",
                              }}
                            >
                              {item.label}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                    );
                  })()}

                  {/* 의존성 */}
                  {parsed.dependencies && (
                    <div className="rounded-2xl border p-3 bg-white/5" style={{ borderColor: "rgba(96,165,250,0.25)" }}>
                      <div className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: "#93c5fd" }}>
                        {tr("의존성", "Dependencies")}
                      </div>
                      <div className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                        <MarkdownContent content={parsed.dependencies} />
                      </div>
                    </div>
                  )}

                  {/* 리스크 */}
                  {parsed.risks && (
                    <div className="rounded-2xl border p-3" style={{ borderColor: "rgba(239,68,68,0.25)", backgroundColor: "rgba(127,29,29,0.12)" }}>
                      <div className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: "#fca5a5" }}>
                        {tr("리스크", "Risks")}
                      </div>
                      <div className="text-sm" style={{ color: "#fecaca" }}>
                        <MarkdownContent content={parsed.risks} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {canRetryCard(selectedCard) && (
              <div className="rounded-2xl border p-4 bg-white/5 space-y-3" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                <div>
                  <h4 className="font-medium" style={{ color: "var(--th-text-heading)" }}>
                    {tr("Retry / Failover", "Retry / Failover")}
                  </h4>
                  <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {tr("같은 담당자에게 재요청하거나 다른 담당자로 failover할 수 있습니다.", "Retry with the same assignee or fail over to another agent.")}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <select
                    value={retryAssigneeId}
                    onChange={(event) => setRetryAssigneeId(event.target.value)}
                    className="w-full rounded-xl px-3 py-2 text-sm bg-white/6 border"
                    style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-primary)" }}
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{getAgentLabel(agent.id)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void handleRetryCard()}
                    disabled={retryingCard || !(retryAssigneeId || selectedCard.assignee_agent_id)}
                    className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                    style={{ backgroundColor: "#7c3aed" }}
                  >
                    {retryingCard ? tr("재요청 중", "Retrying") : tr("즉시 재요청", "Retry now")}
                  </button>
                </div>
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 text-sm">
              <div className="rounded-2xl border p-3 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("생성", "Created")}</div>
                <div style={{ color: "var(--th-text-primary)" }}>{formatTs(selectedCard.created_at, locale)}</div>
              </div>
              <div className="rounded-2xl border p-3 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("요청", "Requested")}</div>
                <div style={{ color: "var(--th-text-primary)" }}>{formatTs(selectedCard.requested_at, locale)}</div>
              </div>
              <div className="rounded-2xl border p-3 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("시작", "Started")}</div>
                <div style={{ color: "var(--th-text-primary)" }}>{formatTs(selectedCard.started_at, locale)}</div>
              </div>
              <div className="rounded-2xl border p-3 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("완료", "Completed")}</div>
                <div style={{ color: "var(--th-text-primary)" }}>{formatTs(selectedCard.completed_at, locale)}</div>
              </div>
            </div>

            {(selectedCard.latest_dispatch_status || dispatchMap.get(selectedCard.latest_dispatch_id ?? "")?.status) && (
              <div className="rounded-2xl border p-4 bg-white/5 space-y-2" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                <h4 className="font-medium" style={{ color: "var(--th-text-heading)" }}>
                  {tr("실행 상태", "Execution state")}
                </h4>
                <div className="grid gap-2 md:grid-cols-2 text-sm">
                  <div>{tr("dispatch 상태", "Dispatch status")}: {selectedCard.latest_dispatch_status ?? dispatchMap.get(selectedCard.latest_dispatch_id ?? "")?.status ?? "-"}</div>
                  <div>{tr("최신 dispatch", "Latest dispatch")}: {selectedCard.latest_dispatch_id ? `#${selectedCard.latest_dispatch_id.slice(0, 8)}` : "-"}</div>
                </div>
                {(selectedCard.latest_dispatch_result_summary || dispatchMap.get(selectedCard.latest_dispatch_id ?? "")?.result_summary) && (
                  <div className="rounded-xl px-3 py-2 text-sm bg-black/20" style={{ color: "var(--th-text-secondary)" }}>
                    {selectedCard.latest_dispatch_result_summary || dispatchMap.get(selectedCard.latest_dispatch_id ?? "")?.result_summary}
                  </div>
                )}
                {parseCardMetadata(selectedCard.metadata_json).timed_out_reason && (
                  <div className="rounded-xl px-3 py-2 text-sm" style={{ color: "#fdba74", backgroundColor: "rgba(154,52,18,0.18)" }}>
                    {parseCardMetadata(selectedCard.metadata_json).timed_out_reason}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button
                onClick={handleDeleteCard}
                disabled={savingCard}
                className="rounded-xl px-4 py-2 text-sm font-medium"
                style={{ color: "#fecaca", backgroundColor: "rgba(127,29,29,0.32)" }}
              >
                {tr("카드 삭제", "Delete card")}
              </button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <button
                  onClick={() => setSelectedCardId(null)}
                  className="rounded-xl px-4 py-2 text-sm bg-white/8"
                  style={{ color: "var(--th-text-secondary)" }}
                >
                  {tr("취소", "Cancel")}
                </button>
                <button
                  onClick={() => void handleSaveCard()}
                  disabled={savingCard || !editor.title.trim()}
                  className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  style={{ backgroundColor: "#2563eb" }}
                >
                  {savingCard ? tr("저장 중", "Saving") : tr("저장", "Save")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedBacklogIssue && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end justify-center sm:items-center p-0 sm:p-4" onClick={() => setSelectedBacklogIssue(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl max-h-[88svh] overflow-y-auto rounded-t-3xl border p-5 sm:max-h-[90vh] sm:rounded-3xl sm:p-6 space-y-4"
            style={{
              backgroundColor: "rgba(2,6,23,0.96)",
              borderColor: "rgba(148,163,184,0.24)",
              paddingBottom: "max(6rem, calc(6rem + env(safe-area-inset-bottom)))",
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full text-xs bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                    #{selectedBacklogIssue.number}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-xs" style={{ backgroundColor: "#64748b33", color: "#64748b" }}>
                    {tr("백로그", "Backlog")}
                  </span>
                  {selectedBacklogIssue.labels.map((label) => (
                    <span
                      key={label.name}
                      className="px-2 py-0.5 rounded-full text-xs"
                      style={{ backgroundColor: `#${label.color}22`, color: `#${label.color}` }}
                    >
                      {label.name}
                    </span>
                  ))}
                </div>
                <h3 className="mt-2 text-xl font-semibold" style={{ color: "var(--th-text-heading)" }}>
                  {selectedBacklogIssue.title}
                </h3>
              </div>
              <button
                onClick={() => setSelectedBacklogIssue(null)}
                className="rounded-xl px-3 py-2 text-sm bg-white/8 shrink-0"
                style={{ color: "var(--th-text-secondary)" }}
              >
                {tr("닫기", "Close")}
              </button>
            </div>

            {selectedBacklogIssue.assignees.length > 0 && (
              <div className="flex items-center gap-2 text-sm" style={{ color: "var(--th-text-secondary)" }}>
                <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("담당자", "Assignees")}:</span>
                {selectedBacklogIssue.assignees.map((a) => (
                  <span key={a.login} className="px-2 py-0.5 rounded-full text-xs bg-white/8">{a.login}</span>
                ))}
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-2 text-sm">
              <div className="rounded-2xl border p-3 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("생성", "Created")}</div>
                <div style={{ color: "var(--th-text-primary)" }}>{formatIso(selectedBacklogIssue.createdAt, locale)}</div>
              </div>
              <div className="rounded-2xl border p-3 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("업데이트", "Updated")}</div>
                <div style={{ color: "var(--th-text-primary)" }}>{formatIso(selectedBacklogIssue.updatedAt, locale)}</div>
              </div>
            </div>

            {(() => {
              const parsed = parseIssueSections(selectedBacklogIssue.body);
              if (!parsed) {
                // Fallback: non-PMD format
                return selectedBacklogIssue.body ? (
                  <div
                    className="rounded-2xl border p-4 bg-white/5 text-sm"
                    style={{ borderColor: "rgba(148,163,184,0.18)", color: "var(--th-text-primary)" }}
                  >
                    <MarkdownContent content={selectedBacklogIssue.body} />
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed px-3 py-4 text-xs text-center" style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-muted)" }}>
                    {tr("이슈 본문이 없습니다.", "No issue body.")}
                  </div>
                );
              }
              // Structured view for PMD-format issues
              return (
                <div className="space-y-3">
                  {parsed.background && (
                    <div className="rounded-2xl border p-4 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                      <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--th-text-muted)" }}>
                        {tr("배경", "Background")}
                      </div>
                      <div className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                        <MarkdownContent content={parsed.background} />
                      </div>
                    </div>
                  )}
                  {parsed.content && (
                    <div className="rounded-2xl border p-4 bg-white/5" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
                      <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--th-text-muted)" }}>
                        {tr("내용", "Content")}
                      </div>
                      <div className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                        <MarkdownContent content={parsed.content} />
                      </div>
                    </div>
                  )}
                  {parsed.dodItems.length > 0 && (
                    <div className="rounded-2xl border p-4 bg-white/5 space-y-2" style={{ borderColor: "rgba(20,184,166,0.3)" }}>
                      <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "#2dd4bf" }}>
                        DoD (Definition of Done)
                      </div>
                      <div className="space-y-1.5">
                        {parsed.dodItems.map((item, idx) => (
                          <div key={idx} className="flex items-center gap-2 text-sm" style={{ color: "var(--th-text-primary)" }}>
                            <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>☐</span>
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {parsed.dependencies && (
                    <div className="rounded-2xl border p-3 bg-white/5" style={{ borderColor: "rgba(96,165,250,0.25)" }}>
                      <div className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: "#93c5fd" }}>
                        {tr("의존성", "Dependencies")}
                      </div>
                      <div className="text-sm" style={{ color: "var(--th-text-primary)" }}>
                        <MarkdownContent content={parsed.dependencies} />
                      </div>
                    </div>
                  )}
                  {parsed.risks && (
                    <div className="rounded-2xl border p-3" style={{ borderColor: "rgba(239,68,68,0.25)", backgroundColor: "rgba(127,29,29,0.12)" }}>
                      <div className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: "#fca5a5" }}>
                        {tr("리스크", "Risks")}
                      </div>
                      <div className="text-sm" style={{ color: "#fecaca" }}>
                        <MarkdownContent content={parsed.risks} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <a
                href={selectedBacklogIssue.url}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl px-4 py-2 text-sm text-center hover:underline"
                style={{ color: "#93c5fd" }}
              >
                {tr("GitHub에서 보기", "View on GitHub")}
              </a>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <button
                  onClick={() => {
                    setSelectedBacklogIssue(null);
                    void handleCloseIssue(selectedBacklogIssue);
                  }}
                  disabled={closingIssueNumber === selectedBacklogIssue.number}
                  className="rounded-xl px-4 py-2 text-sm border disabled:opacity-50"
                  style={{ borderColor: "rgba(148,163,184,0.28)", color: "var(--th-text-muted)" }}
                >
                  {closingIssueNumber === selectedBacklogIssue.number ? tr("닫는 중", "Closing") : tr("이슈 닫기", "Close issue")}
                </button>
                <button
                  onClick={() => {
                    setSelectedBacklogIssue(null);
                    setAssignIssue(selectedBacklogIssue);
                    const repoSource = repoSources.find((s) => s.repo === selectedRepo);
                    setAssignAssigneeId(repoSource?.default_agent_id ?? "");
                  }}
                  className="rounded-xl px-4 py-2 text-sm font-medium text-white"
                  style={{ backgroundColor: "#2563eb" }}
                >
                  {tr("할당", "Assign")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
