import { createPopNow, type PopNowProviderSettings } from '../src';

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | (() => Response | Promise<Response>);

export function envelope(data: unknown, init: { status?: number; code?: number; msg?: string } = {}) {
  return new Response(
    JSON.stringify({ code: init.code ?? 200, msg: init.msg ?? 'success', data, request_id: 'req_test' }),
    { status: init.status ?? 200, headers: { 'content-type': 'application/json' } },
  );
}

export function bytes(content: number[], type = 'image/png') {
  return new Response(new Uint8Array(content), { status: 200, headers: { 'content-type': type } });
}

/**
 * A fetch mock that answers requests from queued replies, matched by method and a URL
 * substring, and records every call it sees.
 */
export function mockFetch() {
  const routes: Array<{ method: string; match: string; replies: Reply[]; repeat?: Reply }> = [];
  const calls: RecordedCall[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit | undefined).forEach((value, key) => {
      headers[key] = value;
    });
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the raw string
      }
    }
    calls.push({ method, url, headers, body });

    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');

    const route = routes.find((r) => r.method === method && url.includes(r.match) && (r.replies.length || r.repeat));
    if (!route) throw new Error(`Unexpected request: ${method} ${url}`);
    const reply = route.replies.length ? route.replies.shift()! : route.repeat!;
    return typeof reply === 'function' ? reply() : reply.clone();
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    /** Queues one-off replies for a route, in order. */
    on(method: string, match: string, ...replies: Reply[]) {
      routes.push({ method, match, replies });
      return this;
    },
    /** Answers every matching request with the same reply. */
    always(method: string, match: string, reply: Reply) {
      routes.push({ method, match, replies: [], repeat: reply });
      return this;
    },
    callsTo(method: string, match: string) {
      return calls.filter((c) => c.method === method && c.url.includes(match));
    },
  };
}

export function schema(properties: Record<string, unknown>) {
  return envelope({ model: 'test', available: true, inputSchema: { type: 'object', properties } });
}

export function succeededTask(assets: unknown[], extra: Record<string, unknown> = {}) {
  return {
    taskId: 'job_1',
    model: 'test/model/text-to-image',
    state: 'succeeded',
    output: { assets },
    costUsd: '0.048',
    settled: true,
    createdAt: '2026-11-05T00:00:00Z',
    ...extra,
  };
}

export function provider(fetch: typeof globalThis.fetch, settings: PopNowProviderSettings = {}) {
  return createPopNow({ apiKey: 'sk-popnow-test', fetch, ...settings });
}
