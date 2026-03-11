import { useEffect, useMemo, useState, type DragEvent } from "react";
import * as api from "../../api";
import type { GitHubIssue, GitHubRepoOption, KanbanRepoSource } from "../../api";
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
const IN_PROGRESS_STALE_MS = 8 * 60 * 60 * 1000;

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

function coerceEditor(card: KanbanCard | null): EditorState {
  if (!card) return EMPTY_EDITOR;
  const metadata = parseCardMetadata(card.metadata_json);
  return {
    title: card.title,
    description: card.description ?? "",
    assignee_agent_id: card.assignee_agent_id ?? "",
    priority: card.priority,
    status: card.status,
    blocked_reason: card.blocked_reason ?? "",
    review_notes: card.review_notes ?? "",
    review_checklist: metadata.review_checklist ?? [],
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

  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const cardsById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const dispatchMap = useMemo(() => new Map(dispatches.map((dispatch) => [dispatch.id, dispatch])), [dispatches]);

  const selectedCard = selectedCardId ? cardsById.get(selectedCardId) ?? null : null;

  useEffect(() => {
    setEditor(coerceEditor(selectedCard));
    setRetryAssigneeId(selectedCard?.assignee_agent_id ?? "");
    setNewChecklistItem("");
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
    });
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
      return;
    }

    setLoadingIssues(true);
    setActionError(null);
    api.getGitHubIssues(selectedRepo, "open", 100)
      .then((result) => {
        setIssues(result.issues);
        if (result.error) {
          setActionError(result.error);
        }
      })
      .catch((error) => {
      setIssues([]);
      setActionError(error instanceof Error ? error.message : tr("GitHub 이슈를 불러오지 못했습니다.", "Failed to load GitHub issues."));
      })
      .finally(() => setLoadingIssues(false));
  }, [selectedRepo, tr]);

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

  const activeIssueNumbers = useMemo(() => {
    const set = new Set<number>();
    for (const card of repoCards) {
      if (!TERMINAL_STATUSES.has(card.status) && card.github_issue_number) {
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

  const handleDrop = async (
    targetStatus: KanbanCardStatus,
    beforeCardId: string | null,
    event: DragEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    const draggedId = draggingCardId;
    setDraggingCardId(null);
    setDragOverStatus(null);
    setDragOverCardId(null);
    setActionError(null);
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
    if (editor.status === "done" && editor.review_checklist.some((item) => !item.done)) {
      setActionError(tr("review checklist를 모두 완료해야 done으로 이동할 수 있습니다.", "Complete the review checklist before moving to done."));
      return;
    }
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

      await onUpdateCard(selectedCard.id, {
        title: editor.title.trim(),
        description: editor.description.trim() || null,
        assignee_agent_id: editor.assignee_agent_id || null,
        priority: editor.priority,
        status: editor.status,
        blocked_reason: editor.blocked_reason.trim() || null,
        review_notes: editor.review_notes.trim() || null,
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
        <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold" style={{ color: "var(--th-text-heading)" }}>
              {tr("Repo 기반 칸반", "Repo-backed Kanban")}
            </h2>
            <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
              {tr(
                "backlog는 GitHub issue에서 가져오고, 웹에서는 issue를 agent에게 할당해서 `ready` 카드로 올립니다.",
                "Backlog comes from GitHub issues, and the web assigns issues into `ready` cards.",
              )}
            </p>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 text-xs">
            <span className="px-3 py-1 rounded-full bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
              {tr("표시 중", "Visible")}: {totalVisible}
            </span>
            <span className="px-3 py-1 rounded-full bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
              {tr("열린 카드", "Open")}: {openCount}
            </span>
            {selectedRepo && (
              <span className="px-3 py-1 rounded-full bg-blue-500/20" style={{ color: "#bfdbfe" }}>
                {selectedRepo}
              </span>
            )}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_auto] min-w-0">
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
          </div>

          <div className="flex flex-col gap-2 self-start w-full lg:w-auto">
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
        </div>

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] min-w-0">
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

        {actionError && (
          <div className="rounded-xl px-3 py-2 text-sm border" style={{ borderColor: "rgba(248,113,113,0.45)", color: "#fecaca", backgroundColor: "rgba(127,29,29,0.22)" }}>
            {actionError}
          </div>
        )}
      </section>

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
                      {backlogCount}
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
                        className="rounded-2xl border p-3"
                        style={{ borderColor: "rgba(148,163,184,0.2)", backgroundColor: "rgba(2,6,23,0.82)" }}
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
                          >
                            GH
                          </a>
                        </div>
                        <div className="mt-3 flex flex-col items-start gap-2 text-xs sm:flex-row sm:items-center sm:justify-between" style={{ color: "var(--th-text-muted)" }}>
                          <span>{tr("업데이트", "Updated")}: {formatIso(issue.updatedAt, locale)}</span>
                          <div className="flex gap-2">
                            <button
                              onClick={() => void handleCloseIssue(issue)}
                              disabled={closingIssueNumber === issue.number}
                              className="rounded-lg px-3 py-1.5 border disabled:opacity-50"
                              style={{ borderColor: "rgba(148,163,184,0.28)", color: "var(--th-text-muted)" }}
                            >
                              {closingIssueNumber === issue.number ? tr("닫는 중", "Closing") : tr("닫기", "Close")}
                            </button>
                            <button
                              onClick={() => {
                                setAssignIssue(issue);
                                const repoSource = repoSources.find((s) => s.repo === selectedRepo);
                                setAssignAssigneeId(repoSource?.default_agent_id ?? "");
                              }}
                              className="rounded-lg px-3 py-1.5 text-white"
                              style={{ backgroundColor: column.accent }}
                            >
                              {tr("할당", "Assign")}
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}

                    {backlogCount === 0 && (
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

                          {card.description && (
                            <p className="mt-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                              {card.description}
                            </p>
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
              paddingBottom: "max(1.25rem, calc(1.25rem + env(safe-area-inset-bottom)))",
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
                className="rounded-xl px-3 py-2 text-sm bg-white/8"
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
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end justify-center sm:items-center p-0 sm:p-4">
          <div
            className="w-full max-w-3xl max-h-[88svh] overflow-y-auto rounded-t-3xl border p-5 sm:max-h-[90vh] sm:rounded-3xl sm:p-6 space-y-4"
            style={{
              backgroundColor: "rgba(2,6,23,0.96)",
              borderColor: "rgba(148,163,184,0.24)",
              paddingBottom: "max(1.25rem, calc(1.25rem + env(safe-area-inset-bottom)))",
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
                className="rounded-xl px-3 py-2 text-sm bg-white/8"
                style={{ color: "var(--th-text-secondary)" }}
              >
                {tr("닫기", "Close")}
              </button>
            </div>

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
              <label className="space-y-1">
                <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("상태", "Status")}</span>
                <select
                  value={editor.status}
                  onChange={(event) => setEditor((prev) => ({ ...prev, status: event.target.value as KanbanCardStatus }))}
                  className="w-full rounded-xl px-3 py-2 text-sm bg-white/6 border"
                  style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-primary)" }}
                >
                  {COLUMN_DEFS.map((column) => (
                    <option key={column.status} value={column.status}>{tr(column.labelKo, column.labelEn)}</option>
                  ))}
                </select>
              </label>
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

            <label className="space-y-1 block">
              <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("설명", "Description")}</span>
              <textarea
                value={editor.description}
                onChange={(event) => setEditor((prev) => ({ ...prev, description: event.target.value }))}
                rows={4}
                className="w-full rounded-xl px-3 py-2 text-sm bg-white/6 border resize-y"
                style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-primary)" }}
              />
            </label>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("Blocked 이유", "Blocked reason")}</span>
                <textarea
                  value={editor.blocked_reason}
                  onChange={(event) => setEditor((prev) => ({ ...prev, blocked_reason: event.target.value }))}
                  rows={3}
                  className="w-full rounded-xl px-3 py-2 text-sm bg-white/6 border resize-y"
                  style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-primary)" }}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>{tr("Review 메모", "Review notes")}</span>
                <textarea
                  value={editor.review_notes}
                  onChange={(event) => setEditor((prev) => ({ ...prev, review_notes: event.target.value }))}
                  rows={3}
                  className="w-full rounded-xl px-3 py-2 text-sm bg-white/6 border resize-y"
                  style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-primary)" }}
                />
              </label>
            </div>

            <div className="rounded-2xl border p-4 bg-white/5 space-y-3" style={{ borderColor: "rgba(148,163,184,0.18)" }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="font-medium" style={{ color: "var(--th-text-heading)" }}>
                    {tr("Review checklist", "Review checklist")}
                  </h4>
                  <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {tr("done 전 최종 확인 항목을 관리합니다.", "Track final checks before marking done.")}
                  </p>
                </div>
                <span className="text-xs px-2 py-1 rounded-full bg-white/8" style={{ color: "var(--th-text-secondary)" }}>
                  {editor.review_checklist.filter((item) => item.done).length}/{editor.review_checklist.length}
                </span>
              </div>

              {editor.review_checklist.length === 0 ? (
                <div className="rounded-xl border border-dashed px-3 py-4 text-xs text-center" style={{ borderColor: "rgba(148,163,184,0.22)", color: "var(--th-text-muted)" }}>
                  {tr("아직 checklist 항목이 없습니다.", "No checklist items yet.")}
                </div>
              ) : (
                <div className="space-y-2">
                  {editor.review_checklist.map((item) => (
                    <label
                      key={item.id}
                      className="flex items-center gap-3 rounded-xl px-3 py-2"
                      style={{ backgroundColor: "rgba(255,255,255,0.04)" }}
                    >
                      <input
                        type="checkbox"
                        checked={item.done}
                        onChange={(event) => setEditor((prev) => ({
                          ...prev,
                          review_checklist: prev.review_checklist.map((current) => current.id === item.id ? { ...current, done: event.target.checked } : current),
                        }))}
                      />
                      <span className="min-w-0 flex-1 text-sm" style={{ color: item.done ? "var(--th-text-secondary)" : "var(--th-text-primary)" }}>
                        {item.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditor((prev) => ({
                          ...prev,
                          review_checklist: prev.review_checklist.filter((current) => current.id !== item.id),
                        }))}
                        className="text-xs"
                        style={{ color: "var(--th-text-muted)" }}
                      >
                        {tr("삭제", "Remove")}
                      </button>
                    </label>
                  ))}
                </div>
              )}

              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  value={newChecklistItem}
                  onChange={(event) => setNewChecklistItem(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addChecklistItem();
                    }
                  }}
                  placeholder={tr("검토 항목 추가", "Add checklist item")}
                  className="w-full rounded-xl px-3 py-2 text-sm bg-white/6 border"
                  style={{ borderColor: "rgba(148,163,184,0.24)", color: "var(--th-text-primary)" }}
                />
                <button
                  type="button"
                  onClick={addChecklistItem}
                  disabled={!newChecklistItem.trim()}
                  className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  style={{ backgroundColor: "#0f766e" }}
                >
                  {tr("항목 추가", "Add item")}
                </button>
              </div>
            </div>

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
    </div>
  );
}
