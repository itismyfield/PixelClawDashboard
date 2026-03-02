import { useEffect, useRef, useState } from "react";
import type { Department } from "../../types";
import { localeName, useI18n } from "../../i18n";
import * as api from "../../api";
import { CLI_PROVIDERS, ROLE_BADGE, ROLE_LABEL, ROLES } from "./constants";
import EmojiPicker from "./EmojiPicker";
import type { FormData } from "./types";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function AgentFormModal({
  isKo,
  locale,
  tr,
  form,
  setForm,
  departments,
  isEdit,
  saving,
  onSave,
  onClose,
}: {
  isKo: boolean;
  locale: string;
  tr: (ko: string, en: string) => string;
  form: FormData;
  setForm: (f: FormData) => void;
  departments: Department[];
  isEdit: boolean;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [spriteFile, setSpriteFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string> | null>(null);
  const [spriteNum, setSpriteNum] = useState(form.sprite_number ?? 0);
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState(false);

  // ESC 키로 닫기
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const inputCls =
    "w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors";
  const inputStyle = {
    background: "var(--th-input-bg)",
    borderColor: "var(--th-input-border)",
    color: "var(--th-text-primary)",
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "var(--th-modal-overlay)" }}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto overscroll-contain rounded-2xl p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
        style={{
          background: "var(--th-card-bg)",
          border: "1px solid var(--th-card-border)",
          backdropFilter: "blur(20px)",
        }}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-bold" style={{ color: "var(--th-text-heading)" }}>
            {isEdit ? tr("직원 정보 수정", "Edit Agent") : tr("신규 직원 채용", "Hire New Agent")}
          </h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[var(--th-bg-surface-hover)] transition-colors"
            style={{ color: "var(--th-text-muted)" }}
          >
            ✕
          </button>
        </div>

        {/* 2-column layout */}
        <div className="grid grid-cols-2 gap-5">
          {/* ── Left column: 기본 정보 ── */}
          <div className="space-y-4">
            <div
              className="text-[10px] font-semibold uppercase tracking-widest"
              style={{ color: "var(--th-text-muted)" }}
            >
              {tr("기본 정보", "Basic Info")}
            </div>
            {/* ── 스프라이트 얼굴 미리보기 + 위/아래 변경 ── */}
            <div className="flex items-center gap-3">
              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  className="w-6 h-6 rounded flex items-center justify-center text-xs hover:bg-[var(--th-bg-surface-hover)] transition-colors"
                  style={{ color: "var(--th-text-muted)", border: "1px solid var(--th-input-border)" }}
                  onClick={() => {
                    const next = Math.max(1, spriteNum || 0) + 1;
                    setSpriteNum(next);
                    setForm({ ...form, sprite_number: next });
                  }}
                >
                  ▲
                </button>
                <div
                  className="w-14 h-14 rounded-xl overflow-hidden bg-gray-700 flex items-center justify-center flex-shrink-0"
                  style={{ border: "2px solid var(--th-input-border)" }}
                >
                  {spriteNum > 0 ? (
                    <img
                      src={`/sprites/${spriteNum}-D-1.png`}
                      alt={`sprite ${spriteNum}`}
                      className="w-full h-full object-cover"
                      style={{ imageRendering: "pixelated" }}
                    />
                  ) : (
                    <span className="text-2xl">{form.avatar_emoji || "🤖"}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="w-6 h-6 rounded flex items-center justify-center text-xs hover:bg-[var(--th-bg-surface-hover)] transition-colors"
                  style={{ color: "var(--th-text-muted)", border: "1px solid var(--th-input-border)" }}
                  onClick={() => {
                    const next = Math.max(1, (spriteNum || 1) - 1);
                    setSpriteNum(next);
                    setForm({ ...form, sprite_number: next });
                  }}
                >
                  ▼
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <span
                  className="text-xs font-mono px-1.5 py-0.5 rounded"
                  style={{ color: "var(--th-text-muted)", background: "var(--th-bg-surface-hover)" }}
                >
                  #{spriteNum || "—"}
                </span>
                <div className="mt-2">
                  <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                    {tr("영문 이름", "Name")} <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="DORO"
                    className={inputCls}
                    style={inputStyle}
                  />
                </div>
              </div>
            </div>
            {/* 로캘 기반 현지 이름 필드 */}
            {locale.startsWith("ko") && (
              <div>
                <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                  {tr("한글 이름", "Korean Name")}
                </label>
                <input
                  type="text"
                  value={form.name_ko}
                  onChange={(e) => setForm({ ...form, name_ko: e.target.value })}
                  placeholder="도로롱"
                  className={inputCls}
                  style={inputStyle}
                />
              </div>
            )}
            {locale.startsWith("ja") && (
              <div>
                <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                  {t({ ko: "일본어 이름", en: "Japanese Name", ja: "日本語名", zh: "日语名" })}
                </label>
                <input
                  type="text"
                  value={form.name_ja}
                  onChange={(e) => setForm({ ...form, name_ja: e.target.value })}
                  placeholder="ドロロン"
                  className={inputCls}
                  style={inputStyle}
                />
              </div>
            )}
            {locale.startsWith("zh") && (
              <div>
                <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                  {t({ ko: "중국어 이름", en: "Chinese Name", ja: "中国語名", zh: "中文名" })}
                </label>
                <input
                  type="text"
                  value={form.name_zh}
                  onChange={(e) => setForm({ ...form, name_zh: e.target.value })}
                  placeholder="多罗隆"
                  className={inputCls}
                  style={inputStyle}
                />
              </div>
            )}
            <div className="grid grid-cols-[72px_1fr] gap-2">
              <div>
                <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                  {tr("이모지", "Emoji")}
                </label>
                <EmojiPicker
                  value={form.avatar_emoji}
                  onChange={(emoji) => setForm({ ...form, avatar_emoji: emoji })}
                />
              </div>
              <div>
                <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                  {tr("소속 부서", "Department")}
                </label>
                <select
                  value={form.department_id}
                  onChange={(e) => setForm({ ...form, department_id: e.target.value })}
                  className={`${inputCls} cursor-pointer`}
                  style={inputStyle}
                >
                  <option value="">{tr("— 미배정 —", "— Unassigned —")}</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.icon} {localeName(locale, d)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* ── Right column: 역할 설정 ── */}
          <div className="space-y-4">
            <div
              className="text-[10px] font-semibold uppercase tracking-widest"
              style={{ color: "var(--th-text-muted)" }}
            >
              {tr("역할 설정", "Role Config")}
            </div>
            {/* 직급 */}
            <div>
              <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {tr("직급", "Role")}
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {ROLES.map((r) => {
                  const active = form.role === r;
                  return (
                    <button
                      key={r}
                      onClick={() => setForm({ ...form, role: r })}
                      className={`py-2 rounded-lg text-xs font-medium border transition-all ${
                        active ? ROLE_BADGE[r] : ""
                      }`}
                      style={
                        !active ? { borderColor: "var(--th-input-border)", color: "var(--th-text-muted)" } : undefined
                      }
                    >
                      {isKo ? ROLE_LABEL[r].ko : ROLE_LABEL[r].en}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* CLI Provider */}
            <div>
              <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {tr("CLI 도구", "CLI Provider")}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {CLI_PROVIDERS.map((p) => {
                  const active = form.cli_provider === p;
                  return (
                    <button
                      key={p}
                      onClick={() => setForm({ ...form, cli_provider: p })}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-mono border transition-all ${
                        active ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : ""
                      }`}
                      style={
                        !active ? { borderColor: "var(--th-input-border)", color: "var(--th-text-muted)" } : undefined
                      }
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* 성격/프롬프트 */}
            <div>
              <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {tr("성격 / 역할 프롬프트", "Personality / Prompt")}
              </label>
              <textarea
                value={form.personality}
                onChange={(e) => setForm({ ...form, personality: e.target.value })}
                rows={3}
                placeholder={tr("전문 분야나 성격 설명...", "Expertise or personality...")}
                className={`${inputCls} resize-none`}
                style={inputStyle}
              />
            </div>
          </div>
        </div>

        {/* ── Sprite Upload ── */}
        <div className="mt-5 pt-4" style={{ borderTop: "1px solid var(--th-card-border)" }}>
          <div
            className="text-[10px] font-semibold uppercase tracking-widest mb-3"
            style={{ color: "var(--th-text-muted)" }}
          >
            {tr("캐릭터 스프라이트", "Character Sprite")}
          </div>

          {!previews && !processing && (
            <label
              className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border-2 border-dashed cursor-pointer transition-colors hover:border-blue-500/50"
              style={{ borderColor: "var(--th-input-border)", color: "var(--th-text-muted)" }}
            >
              <span className="text-2xl">🖼️</span>
              <span className="text-xs">
                {tr("4방향 스프라이트 시트 업로드 (2x2 그리드)", "Upload 4-direction sprite sheet (2x2 grid)")}
              </span>
              <span className="text-xs">{tr("앞 / 왼 / 뒤 / 오른 순서", "Front / Left / Back / Right order")}</span>
              <span className="text-xs">
                {t({
                  ko: "(흰색배경)",
                  en: "(White background)",
                  ja: "（白背景）",
                  zh: "（白色背景）",
                })}
              </span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setSpriteFile(file);
                  setProcessing(true);
                  setPreviews(null);
                  setRegistered(false);
                  try {
                    const base64 = await fileToBase64(file);
                    const result = await api.processSprite(base64);
                    setPreviews(result.previews);
                    setSpriteNum(result.suggestedNumber);
                  } catch (err) {
                    console.error("Sprite processing failed:", err);
                  } finally {
                    setProcessing(false);
                  }
                }}
              />
            </label>
          )}

          {processing && (
            <div className="flex items-center justify-center gap-2 py-8" style={{ color: "var(--th-text-muted)" }}>
              <span className="animate-spin text-lg">⏳</span>
              <span className="text-sm">
                {tr("배경 제거 및 분할 처리 중...", "Removing background & splitting...")}
              </span>
            </div>
          )}

          {previews && !processing && (
            <div className="space-y-3">
              {/* Preview grid */}
              <div className="grid grid-cols-3 gap-3">
                {(["D", "L", "R"] as const).map((dir) => (
                  <div key={dir} className="text-center">
                    <div className="text-[10px] font-medium mb-1" style={{ color: "var(--th-text-muted)" }}>
                      {dir === "D" ? tr("정면", "Front") : dir === "L" ? tr("좌측", "Left") : tr("우측", "Right")}
                    </div>
                    <div
                      className="rounded-lg p-2 flex items-center justify-center h-24"
                      style={{ background: "var(--th-input-bg)", border: "1px solid var(--th-input-border)" }}
                    >
                      {previews[dir] ? (
                        <img
                          src={previews[dir]}
                          alt={dir}
                          className="max-h-20 object-contain"
                          style={{ imageRendering: "pixelated" }}
                        />
                      ) : (
                        <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                          —
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Sprite number + register */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
                    {tr("스프라이트 번호", "Sprite #")}
                  </label>
                  <input
                    type="number"
                    value={spriteNum}
                    onChange={(e) => setSpriteNum(Number(e.target.value))}
                    min={1}
                    className="w-16 px-2 py-1 border rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                    style={{
                      background: "var(--th-input-bg)",
                      borderColor: "var(--th-input-border)",
                      color: "var(--th-text-primary)",
                    }}
                  />
                </div>
                <button
                  onClick={async () => {
                    if (!previews) return;
                    setRegistering(true);
                    try {
                      await api.registerSprite(previews, spriteNum);
                      setRegistered(true);
                      setForm({ ...form, sprite_number: spriteNum });
                    } catch (err) {
                      console.error("Sprite register failed:", err);
                    } finally {
                      setRegistering(false);
                    }
                  }}
                  disabled={registering || registered || !spriteNum}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    registered
                      ? "bg-emerald-600/20 text-emerald-400 border border-emerald-500/30"
                      : "bg-blue-600 hover:bg-blue-500 text-white"
                  } disabled:opacity-50`}
                >
                  {registering
                    ? tr("등록 중...", "Registering...")
                    : registered
                      ? tr("등록 완료!", "Registered!")
                      : tr("스프라이트 등록", "Register Sprite")}
                </button>
                {previews && (
                  <button
                    onClick={() => {
                      setPreviews(null);
                      setSpriteFile(null);
                      setRegistered(false);
                    }}
                    className="text-xs px-2 py-1 rounded-lg hover:bg-[var(--th-bg-surface-hover)] transition-colors"
                    style={{ color: "var(--th-text-muted)" }}
                  >
                    {tr("다시 업로드", "Re-upload")}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions — full width */}
        <div className="flex gap-2 mt-5 pt-4" style={{ borderTop: "1px solid var(--th-card-border)" }}>
          <button
            onClick={onSave}
            disabled={saving || !form.name.trim()}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white disabled:opacity-40 shadow-sm shadow-blue-600/20"
          >
            {saving
              ? tr("처리 중...", "Saving...")
              : isEdit
                ? tr("변경사항 저장", "Save Changes")
                : tr("채용 확정", "Confirm Hire")}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-lg text-sm font-medium transition-all hover:bg-[var(--th-bg-surface-hover)]"
            style={{ border: "1px solid var(--th-input-border)", color: "var(--th-text-secondary)" }}
          >
            {tr("취소", "Cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
