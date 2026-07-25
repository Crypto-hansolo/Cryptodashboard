import { CHANNELS } from '@cid/platform';
import { rateLimitGuard } from '@/server/api';
import { getServices } from '@/server/container';

/**
 * GET /api/stream — Server-Sent Events for live updates.
 *
 * SSE rather than WebSockets: the traffic is strictly server-to-client
 * (events, quotes, alerts, connector status), SSE reconnects automatically,
 * and it survives proxies that mangle WebSocket upgrades. A WebSocket would add
 * a second protocol for no capability we use.
 *
 * The worker publishes to Redis pub/sub; this subscribes and forwards. That
 * indirection is required because worker and web are separate processes.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  // A client stuck in a reconnect loop would otherwise open a Redis subscription
  // per attempt, so the stream is limited like any other endpoint.
  const limited = await rateLimitGuard(request);
  if (limited) return limited;

  const { realtime, logger } = getServices();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const unsubscribers: Array<() => Promise<void>> = [];

      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The client vanished between the closed check and the enqueue.
          closed = true;
        }
      };

      // Tell the client to back off on reconnect, and confirm the stream is live
      // so the UI can show a connected indicator immediately.
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      send('ready', { at: new Date().toISOString() });

      for (const channel of [
        CHANNELS.events,
        CHANNELS.quotes,
        CHANNELS.alerts,
        CHANNELS.connectors,
      ]) {
        try {
          const unsubscribe = await realtime.subscribe(channel, (message) => {
            send(message.type, message.payload);
          });
          unsubscribers.push(unsubscribe);
        } catch (error) {
          logger.warn({ channel, err: error }, 'failed to subscribe to realtime channel');
        }
      }

      // Heartbeat: keeps intermediary proxies from closing an idle connection,
      // and lets the client detect a dead stream even when nothing is happening.
      const heartbeat = setInterval(() => {
        send('heartbeat', { at: new Date().toISOString() });
      }, 20_000);

      const cleanup = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        for (const unsubscribe of unsubscribers) {
          await unsubscribe().catch(() => {});
        }
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      request.signal.addEventListener('abort', () => void cleanup(), { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Disable nginx buffering, which otherwise holds frames until the buffer
      // fills and makes a "realtime" stream arrive in bursts.
      'x-accel-buffering': 'no',
    },
  });
}
