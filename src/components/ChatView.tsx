import { useState, useEffect, useRef, useCallback } from "react";
import type { Agent } from "../types";
import type { ChatMessage } from "../api/client";
import * as api from "../api";
import { Send, Users, Megaphone } from "lucide-react";

interface ChatViewProps {
  agents: Agent[];
  isKo: boolean;
  wsRef: React.RefObject<WebSocket | null>;
}

export default function ChatView({ agents, isKo, wsRef }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [mode, setMode] = useState<"agent" | "all">("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sending, setSending] = useState(false);

  // Load messages
  const loadMessages = useCallback(async () => {
    try {
      const opts: Parameters<typeof api.getMessages>[0] = { limit: 100 };
      if (mode === "agent" && selectedAgent) {
        opts.receiverId = selectedAgent;
      }
      const data = await api.getMessages(opts);
      setMessages(data.messages);
    } catch { /* ignore */ }
  }, [mode, selectedAgent]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Auto scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Listen for WS new_message events
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "new_message") {
          setMessages((prev) => [...prev, data.payload as ChatMessage]);
        }
      } catch { /* ignore */ }
    };
    const ws = wsRef.current;
    if (ws) {
      ws.addEventListener("message", handler);
      return () => ws.removeEventListener("message", handler);
    }
  }, [wsRef]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      await api.sendMessage({
        sender_type: "ceo",
        receiver_type: mode === "agent" && selectedAgent ? "agent" : "all",
        receiver_id: mode === "agent" ? selectedAgent : null,
        content: input.trim(),
        message_type: "chat",
      });
      setInput("");
    } catch (e) {
      console.error("Send failed:", e);
    } finally {
      setSending(false);
    }
  };

  const tr = (ko: string, en: string) => (isKo ? ko : en);
  const selectedAgentObj = agents.find((a) => a.id === selectedAgent);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Header: mode + agent selector */}
      <div
        className="flex items-center gap-2 px-4 py-2 border-b shrink-0"
        style={{ borderColor: "var(--th-card-border)", background: "var(--th-surface)" }}
      >
        <button
          onClick={() => { setMode("all"); setSelectedAgent(null); }}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${mode === "all" ? "bg-indigo-600 text-white" : ""}`}
          style={mode !== "all" ? { color: "var(--th-text-muted)" } : undefined}
        >
          <Megaphone size={12} className="inline mr-1" />
          {tr("전체", "All")}
        </button>
        <button
          onClick={() => setMode("agent")}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${mode === "agent" ? "bg-indigo-600 text-white" : ""}`}
          style={mode !== "agent" ? { color: "var(--th-text-muted)" } : undefined}
        >
          <Users size={12} className="inline mr-1" />
          {tr("1:1", "DM")}
        </button>

        {mode === "agent" && (
          <select
            value={selectedAgent || ""}
            onChange={(e) => setSelectedAgent(e.target.value || null)}
            className="ml-2 px-2 py-1 rounded-lg text-xs bg-transparent border"
            style={{ borderColor: "var(--th-input-border)", color: "var(--th-text)" }}
          >
            <option value="">{tr("에이전트 선택", "Select Agent")}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.avatar_emoji} {a.alias || a.name_ko || a.name}
              </option>
            ))}
          </select>
        )}

        <div className="flex-1" />
        <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
          {messages.length} {tr("메시지", "messages")}
        </span>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2 min-h-0"
      >
        {messages.length === 0 && (
          <div className="text-center py-16" style={{ color: "var(--th-text-muted)" }}>
            <div className="text-4xl mb-2">💬</div>
            <div className="text-sm">{tr("메시지가 없습니다", "No messages yet")}</div>
            <div className="text-xs mt-1">{tr("에이전트에게 지시를 보내보세요!", "Send a directive to your agents!")}</div>
          </div>
        )}

        {messages.map((msg) => {
          const isCeo = msg.sender_type === "ceo";
          const isSystem = msg.sender_type === "system";
          const senderAgent = !isCeo && !isSystem
            ? agents.find((a) => a.id === msg.sender_id)
            : null;

          if (isSystem) {
            return (
              <div key={msg.id} className="text-center">
                <span
                  className="inline-block text-[10px] px-2 py-0.5 rounded-full"
                  style={{ background: "var(--th-bg-surface)", color: "var(--th-text-muted)" }}
                >
                  {msg.content}
                </span>
              </div>
            );
          }

          return (
            <div
              key={msg.id}
              className={`flex gap-2 ${isCeo ? "flex-row-reverse" : ""}`}
            >
              {/* Avatar */}
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
                style={{
                  background: isCeo ? "#6366f1" : "var(--th-bg-surface)",
                }}
              >
                {isCeo ? "👑" : (senderAgent?.avatar_emoji || msg.sender_avatar || "🤖")}
              </div>

              {/* Bubble */}
              <div className={`max-w-[75%] ${isCeo ? "text-right" : ""}`}>
                <div className="text-[10px] mb-0.5" style={{ color: "var(--th-text-muted)" }}>
                  {isCeo
                    ? "CEO"
                    : (senderAgent?.alias || msg.sender_name_ko || msg.sender_name || "Agent")}
                  <span className="ml-2">
                    {new Date(msg.created_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                <div
                  className="px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words"
                  style={{
                    background: isCeo ? "#4f46e5" : "var(--th-bg-surface)",
                    color: isCeo ? "#fff" : "var(--th-text)",
                    borderRadius: isCeo ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                  }}
                >
                  {msg.content}
                </div>
                {msg.receiver_type === "all" && (
                  <span className="text-[9px]" style={{ color: "var(--th-text-muted)" }}>
                    📢 {tr("전체 공지", "Broadcast")}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Input */}
      <div
        className="px-4 py-3 border-t shrink-0"
        style={{ borderColor: "var(--th-card-border)", background: "var(--th-surface)" }}
      >
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              mode === "all"
                ? tr("전체 공지 메시지...", "Broadcast message...")
                : selectedAgent
                  ? tr(`${selectedAgentObj?.alias || selectedAgentObj?.name_ko || "에이전트"}에게 메시지...`, `Message to ${selectedAgentObj?.name || "agent"}...`)
                  : tr("에이전트를 선택하세요", "Select an agent")
            }
            className="flex-1 px-3 py-2 rounded-xl text-base resize-none bg-transparent border"
            style={{
              borderColor: "var(--th-input-border)",
              color: "var(--th-text)",
              maxHeight: "120px",
              minHeight: "40px",
            }}
            rows={1}
            disabled={mode === "agent" && !selectedAgent}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending || (mode === "agent" && !selectedAgent)}
            className="p-2.5 rounded-xl bg-indigo-600 text-white disabled:opacity-40 transition-opacity hover:bg-indigo-500"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
