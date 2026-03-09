import { useState } from "react";
import type { CompanySettings } from "../types";

interface SettingsViewProps {
  settings: CompanySettings;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  isKo: boolean;
}

export default function SettingsView({
  settings,
  onSave,
  isKo,
}: SettingsViewProps) {
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

      <div>
        <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: "var(--th-text-muted)" }}>
          {tr("일반", "General")}
        </h3>
        <div className="space-y-3">
          <div className="rounded-xl p-4" style={cardStyle}>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
              {tr("회사 이름", "Company Name")}
            </label>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={inputStyle}
            />
          </div>

          <div className="rounded-xl p-4" style={cardStyle}>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
              {tr("CEO 이름", "CEO Name")}
            </label>
            <input
              type="text"
              value={ceoName}
              onChange={(e) => setCeoName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={inputStyle}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl p-4" style={cardStyle}>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
                {tr("언어", "Language")}
              </label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as typeof language)}
                className="w-full px-3 py-2 rounded-lg text-sm"
                style={inputStyle}
              >
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
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value as typeof theme)}
                className="w-full px-3 py-2 rounded-lg text-sm"
                style={inputStyle}
              >
                <option value="dark">{tr("다크", "Dark")}</option>
                <option value="light">{tr("라이트", "Light")}</option>
                <option value="auto">{tr("자동 (시스템)", "Auto (System)")}</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: "var(--th-text-muted)" }}>
          {tr("자동화", "Automation")}
        </h3>
        <div className="space-y-3">
          <div className="rounded-xl p-4" style={cardStyle}>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
              {tr("기본 CLI Provider", "Default CLI Provider")}
            </label>
            <select
              value={defaultProvider}
              onChange={(e) => setDefaultProvider(e.target.value as typeof defaultProvider)}
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={inputStyle}
            >
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
