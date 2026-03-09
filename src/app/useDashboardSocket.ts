import { useEffect, useRef, useState } from "react";
import type { WSEvent } from "../types";

export function useDashboardSocket(onEvent: (event: WSEvent) => void) {
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const wsRetryRef = useRef(0);
  const wsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        wsRetryRef.current = 0;
        setWsConnected(true);
      };

      ws.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data) as WSEvent;
          onEventRef.current(event);
        } catch {
          // ignore malformed ws payload
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        wsRef.current = null;
        if (destroyed) return;
        const delay = Math.min(1000 * 2 ** wsRetryRef.current, 30000);
        wsRetryRef.current += 1;
        wsTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (wsTimerRef.current) clearTimeout(wsTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  return { wsConnected, wsRef };
}
