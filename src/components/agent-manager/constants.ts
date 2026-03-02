import type { AgentRole, CliProvider } from "../../types";
import type { DeptForm, FormData } from "./types";

export const ROLES: AgentRole[] = ["team_leader", "senior", "junior", "intern"];
export const CLI_PROVIDERS: CliProvider[] = ["claude", "codex", "gemini", "opencode", "copilot", "antigravity", "api"];

export const ROLE_LABEL: Record<string, { ko: string; en: string }> = {
  team_leader: { ko: "팀장", en: "Leader" },
  senior: { ko: "시니어", en: "Senior" },
  junior: { ko: "주니어", en: "Junior" },
  intern: { ko: "인턴", en: "Intern" },
};

export const ROLE_BADGE: Record<string, string> = {
  team_leader: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  senior: "bg-sky-500/15 text-sky-400 border-sky-500/25",
  junior: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  intern: "bg-slate-500/15 text-slate-400 border-slate-500/25",
};

export const STATUS_DOT: Record<string, string> = {
  working: "bg-emerald-400 shadow-emerald-400/50 shadow-sm",
  break: "bg-amber-400",
  offline: "bg-red-400",
  idle: "bg-slate-500",
};

export const ICON_SPRITE_POOL = Array.from({ length: 13 }, (_, i) => i + 1);

export const EMOJI_GROUPS: { label: string; labelEn: string; emojis: string[] }[] = [
  {
    label: "부서/업무",
    labelEn: "Work",
    emojis: ["📊", "💻", "🎨", "🔍", "🛡️", "⚙️", "📁", "🏢", "📋", "📈", "💼", "🗂️", "📌", "🎯", "🔧", "🧪"],
  },
  {
    label: "사람/표정",
    labelEn: "People",
    emojis: ["🤖", "👤", "👥", "😊", "😎", "🤓", "🧑‍💻", "👨‍🔬", "👩‍🎨", "🧑‍🏫", "🦸", "🦊", "🐱", "🐶", "🐻", "🐼"],
  },
  {
    label: "사물/기호",
    labelEn: "Objects",
    emojis: ["💡", "🚀", "⚡", "🔥", "💎", "🏆", "🎵", "🎮", "📱", "💾", "🖥️", "📡", "🔑", "🛠️", "📦", "🧩"],
  },
  {
    label: "자연/색상",
    labelEn: "Nature",
    emojis: ["🌟", "⭐", "🌈", "🌊", "🌸", "🍀", "🌙", "☀️", "❄️", "🔵", "🟢", "🟡", "🔴", "🟣", "🟠", "⚪"],
  },
];

export const BLANK: FormData = {
  name: "",
  name_ko: "",
  name_ja: "",
  name_zh: "",
  department_id: "",
  role: "junior",
  cli_provider: "claude",
  avatar_emoji: "🤖",
  sprite_number: null,
  personality: "",
};

export const DEPT_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#8b5cf6",
  "#f97316",
  "#ec4899",
  "#06b6d4",
  "#6b7280",
];

export const DEPT_BLANK: DeptForm = {
  id: "",
  name: "",
  name_ko: "",
  name_ja: "",
  name_zh: "",
  icon: "📁",
  color: "#3b82f6",
  description: "",
  prompt: "",
};
