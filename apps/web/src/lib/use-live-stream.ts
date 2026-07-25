'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * SSE subscription hook.
 *
 * `EventSource` handles reconnection itself, but it does not tell you the
 * connection is *stale* — a proxy can hold a dead socket open indefinitely. The
 * server sends a heartbeat every 20s and this treats a 60s gap as dead and
 * forces a reconnect, which is the difference between a dashboard that silently
 * stops updating and one that recovers.
 */

export type LiveStatus = 'connecting' | 'live' | 'stale' | 'error';

export interface LiveEventPayload {
  id: string;
  occurredAt: string;
  coinId: string | null;
  category: string;
  headline: string;
  url: string | null;
  importance: number | null;
  sentiment: string | null;
}

export interface LiveQuotePayload {
  coinId: string;
  priceUsd: number;
  change24hPct: number | null;
}

export interface LiveAlertPayload {
  id: string;
  alertId: string;
  alertName: string;
  title: string;
  message: string;
  coinId: string | null;
  coinSymbol: string | null;
  importance: number | null;
  triggeredAt: string;
  url: string | null;
}

export interface LiveStreamHandlers {
  onEvent?: (payload: LiveEventPayload) => void;
  onQuote?: (payload: LiveQuotePayload) => void;
  onAlert?: (payload: LiveAlertPayload) => void;
  onConnector?: (payload: { key: string; status: string; at: string }) => void;
}

const STALE_AFTER_MS = 60_000;

export function useLiveStream(handlers: LiveStreamHandlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  // Handlers are stashed in a ref so a parent re-render does not tear down and
  // rebuild the EventSource on every keystroke.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let source: EventSource | null = null;
    let staleTimer: ReturnType<typeof setInterval> | null = null;
    let lastMessageAt = Date.now();
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      source?.close();
      setStatus('connecting');
      source = new EventSource('/api/stream');

      const touch = (): void => {
        lastMessageAt = Date.now();
        setStatus('live');
      };

      source.addEventListener('ready', touch);
      source.addEventListener('heartbeat', touch);

      source.addEventListener('event', (message) => {
        touch();
        try {
          handlersRef.current.onEvent?.(JSON.parse((message as MessageEvent<string>).data));
        } catch {
          /* ignore a malformed frame rather than killing the stream */
        }
      });

      source.addEventListener('quote', (message) => {
        touch();
        try {
          handlersRef.current.onQuote?.(JSON.parse((message as MessageEvent<string>).data));
        } catch {
          /* ignore */
        }
      });

      source.addEventListener('alert', (message) => {
        touch();
        try {
          handlersRef.current.onAlert?.(JSON.parse((message as MessageEvent<string>).data));
        } catch {
          /* ignore */
        }
      });

      source.addEventListener('connector', (message) => {
        touch();
        try {
          handlersRef.current.onConnector?.(JSON.parse((message as MessageEvent<string>).data));
        } catch {
          /* ignore */
        }
      });

      source.addEventListener('error', () => {
        // EventSource retries on its own; surface the state rather than
        // reconnecting manually and racing its internal timer.
        setStatus((current) => (current === 'live' ? 'stale' : 'error'));
      });
    };

    connect();

    // Watchdog for a socket that is open but no longer delivering.
    staleTimer = setInterval(() => {
      if (Date.now() - lastMessageAt > STALE_AFTER_MS) {
        setStatus('stale');
        connect();
      }
    }, 15_000);

    return () => {
      disposed = true;
      if (staleTimer) clearInterval(staleTimer);
      source?.close();
    };
  }, []);

  return status;
}

/**
 * Desktop notifications for fired alerts.
 *
 * Permission is requested on an explicit user action only — browsers ignore (and
 * users resent) an unprompted request on page load.
 */
export function useDesktopNotifications(): {
  permission: NotificationPermission | 'unsupported';
  request: () => Promise<void>;
  notify: (alert: LiveAlertPayload) => void;
} {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  );

  const request = async (): Promise<void> => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    setPermission(await Notification.requestPermission());
  };

  const notify = (alert: LiveAlertPayload): void => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const notification = new Notification(alert.title, {
      body: alert.message,
      // Tag by alert id so repeated firings of the same alert replace rather
      // than stack into a wall of notifications.
      tag: alert.alertId,
    });
    if (alert.url) {
      notification.onclick = () => window.open(alert.url ?? '', '_blank');
    }
  };

  return { permission, request, notify };
}
