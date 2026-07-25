import { z } from 'zod';
import { route } from '@/server/api';
import { getServices } from '@/server/container';

/**
 * POST /api/ask — the AI research console.
 *
 * Streams as SSE so the first tokens appear immediately; a local model can take
 * ten seconds to finish, and a spinner for ten seconds feels broken. Citations
 * are sent first so the evidence renders while the prose is still arriving.
 */

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  question: z.string().trim().min(3).max(500),
  coinIds: z.array(z.string()).optional(),
  stream: z.boolean().default(true),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: { code: 'VALIDATION', message: 'question is required (3-500 chars)' } },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const { agent } = getServices();

  if (!body.stream) {
    // Non-streaming path, for scripts and tests.
    return route(async () => {
      const result = await agent.ask({
        question: body.question,
        ...(body.coinIds ? { coinIds: body.coinIds } : {}),
      });
      if (!result.ok) throw result.error;
      return {
        answer: result.value.answer,
        citations: result.value.citations.map((citation) => ({
          eventId: citation.eventId,
          headline: citation.headline,
          sourceName: citation.sourceName,
          occurredAt: citation.occurredAt.toISOString(),
          url: citation.url,
        })),
        noEvidence: result.value.noEvidence,
        model: result.value.model,
      };
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        for await (const chunk of agent.askStream({
          question: body.question,
          ...(body.coinIds ? { coinIds: body.coinIds } : {}),
        })) {
          if (chunk.type === 'citations') {
            send('citations', {
              citations: chunk.citations.map((citation) => ({
                eventId: citation.eventId,
                headline: citation.headline,
                sourceName: citation.sourceName,
                occurredAt: citation.occurredAt.toISOString(),
                url: citation.url,
              })),
            });
          } else if (chunk.type === 'token') {
            send('token', { token: chunk.token });
          } else if (chunk.type === 'error') {
            send('error', { message: chunk.message });
          } else {
            send('done', {});
          }
        }
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : 'stream failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
