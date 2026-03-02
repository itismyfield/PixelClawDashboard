import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

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
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  return wss;
}

export function broadcast(type: string, payload: unknown): void {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}
