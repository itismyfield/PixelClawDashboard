import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { getDb } from "./db/runtime.js";

const clients = new Set<WebSocket>();

export function createWsServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(
      JSON.stringify({
        type: "connected",
        payload: { app: "PixelClawDashboard", version: "1.0.0" },
        ts: Date.now(),
      }),
    );

    // Handle incoming messages from clients (bidirectional)
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === "chat_message") {
          handleChatMessage(data.payload);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  return wss;
}

function handleChatMessage(payload: {
  sender_type?: string;
  sender_id?: string | null;
  receiver_type?: string;
  receiver_id?: string | null;
  content?: string;
  message_type?: string;
}) {
  if (!payload.content?.trim()) return;
  const db = getDb();

  const result = db
    .prepare(
      `INSERT INTO messages (sender_type, sender_id, receiver_type, receiver_id, content, message_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      payload.sender_type || "ceo",
      payload.sender_id || null,
      payload.receiver_type || "agent",
      payload.receiver_id || null,
      payload.content.trim(),
      payload.message_type || "chat",
    );

  const msg = db
    .prepare(
      `SELECT m.*,
        a.name AS sender_name, a.name_ko AS sender_name_ko, a.avatar_emoji AS sender_avatar
       FROM messages m
       LEFT JOIN agents a ON m.sender_type = 'agent' AND m.sender_id = a.id
       WHERE m.id = ?`,
    )
    .get(result.lastInsertRowid);

  broadcast("new_message", msg);
}

export function broadcast(type: string, payload: unknown): void {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}
