import { readFileSync } from 'node:fs';

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  redirect: RequestInit['redirect'];
}

export type Responder = (
  request: RecordedRequest,
  signal: AbortSignal,
) => Response | Promise<Response>;

/**
 * A scripted fetch: each call consumes the next responder. Records every request and the peak
 * number of requests in flight.
 */
export function scriptedFetch(responders: Responder[]) {
  const queue = [...responders];
  const requests: RecordedRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const recorded: RecordedRequest = {
      url: input instanceof Request ? input.url : String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      redirect: init?.redirect,
    };
    requests.push(recorded);
    const responder = queue.shift();
    if (!responder) throw new Error(`Unexpected request: ${recorded.url}`);

    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await responder(recorded, init?.signal ?? new AbortController().signal);
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    requests,
    get remaining() {
      return queue.length;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
}

export function status(code: number, headers: Record<string, string> = {}) {
  return () =>
    new Response(code === 304 ? null : '{"code":0,"message":"error"}', { status: code, headers });
}

export function networkError(): Responder {
  return () => Promise.reject(new TypeError('fetch failed'));
}

/** Never answers; rejects with the signal's reason once the client's timeout fires. */
export function hang(): Responder {
  return (_request, signal) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    });
}

export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/chesscom/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}
