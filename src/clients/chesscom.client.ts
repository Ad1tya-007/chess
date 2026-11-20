import type * as z from 'zod/v4';

import { normalizeChessComUsername } from '../utils/chesscom-username.js';
import { formatArchiveMonth } from '../utils/dates.js';
import { ChessComApiError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import {
  archiveGamesSchema,
  archiveListSchema,
  isValidArchiveMonth,
  profileSchema,
  statsSchema,
  type ArchiveGames,
  type ArchiveList,
  type ArchiveMonth,
  type ChessComProfile,
  type ChessComStats,
} from './chesscom.schemas.js';

const API_ORIGIN = 'https://api.chess.com';
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface ChessComClientOptions {
  /** Descriptive User-Agent with contact information, required by Chess.com etiquette. */
  userAgent: string;
  /** Per-attempt timeout, covering both headers and body. */
  timeoutMs: number;
  logger: Logger;
  /** Retries after the first attempt, only for transient failures. Default 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff when no Retry-After is given. Default 500 ms. */
  retryBaseDelayMs?: number;
  /** A Retry-After longer than this is not waited for; the error surfaces instead. Default 30 s. */
  maxRetryAfterMs?: number;
  /** Upper bound on a response body. Default 25 MiB. */
  maxResponseBytes?: number;
  /** Max entries in the in-memory HTTP cache for profile/stats/archive-list responses. */
  cacheEntries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** HTTP validators for conditional requests. Persist these to skip unchanged archives. */
export interface CacheValidators {
  etag: string | null;
  lastModified: string | null;
}

export interface Fetched<T> {
  data: T;
  /** When the data was last confirmed with Chess.com. */
  fetchedAt: Date;
  /** network: downloaded; revalidated: 304 confirmed cached copy; cache: served within max-age. */
  source: 'network' | 'revalidated' | 'cache';
}

export type ConditionalFetch<T> =
  | { status: 'modified'; data: T; validators: CacheValidators; fetchedAt: Date }
  | { status: 'not_modified'; validators: CacheValidators; fetchedAt: Date };

interface RawResponse {
  status: 200 | 304;
  body: string | null;
  validators: CacheValidators;
  /** Cache-Control max-age in ms; 0 when absent or when caching is disallowed. */
  maxAgeMs: number;
  noStore: boolean;
}

interface CacheEntry {
  data: unknown;
  validators: CacheValidators;
  storedAt: number;
  maxAgeMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read-only client for the Chess.com Published-Data API.
 *
 * Requests are built only from validated usernames and known endpoint patterns, and are executed
 * one at a time: Chess.com does not rate-limit serial access but may answer parallel requests
 * with 429.
 */
export class ChessComClient {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxResponseBytes: number;
  private readonly cacheEntries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  private readonly cache = new Map<string, CacheEntry>();
  private queueTail: Promise<unknown> = Promise.resolve();

  constructor(options: ChessComClientOptions) {
    this.userAgent = options.userAgent;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 25 * 1024 * 1024;
    this.cacheEntries = options.cacheEntries ?? 200;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async getPlayerProfile(username: string): Promise<Fetched<ChessComProfile>> {
    const user = this.requireUsername(username);
    return this.getCached(`/pub/player/${user}`, profileSchema, `Chess.com player "${user}"`);
  }

  async getPlayerStats(username: string): Promise<Fetched<ChessComStats>> {
    const user = this.requireUsername(username);
    return this.getCached(
      `/pub/player/${user}/stats`,
      statsSchema,
      `Chess.com stats for "${user}"`,
    );
  }

  async getArchiveList(username: string): Promise<Fetched<ArchiveList>> {
    const user = this.requireUsername(username);
    return this.getCached(
      `/pub/player/${user}/games/archives`,
      archiveListSchema(user),
      `Chess.com game archives for "${user}"`,
    );
  }

  /**
   * Fetches one monthly archive. Pass validators stored from a previous fetch to receive
   * `not_modified` instead of re-downloading an unchanged archive. Archive bodies are not cached
   * in memory; callers persist what they need.
   */
  async getArchiveGames(
    username: string,
    archive: ArchiveMonth,
    validators?: CacheValidators,
  ): Promise<ConditionalFetch<ArchiveGames>> {
    const user = this.requireUsername(username);
    if (!isValidArchiveMonth(archive)) {
      throw new ChessComApiError('invalid_input', 'Archive year/month is out of range.');
    }
    const path = `/pub/player/${user}/games/${archive.year}/${String(archive.month).padStart(2, '0')}`;
    const label = `Chess.com archive ${formatArchiveMonth(archive)} for "${user}"`;

    const response = await this.request(path, label, validators);
    const fetchedAt = new Date(this.now());
    if (response.status === 304) {
      return {
        status: 'not_modified',
        validators: { ...validators!, ...nonNull(response.validators) },
        fetchedAt,
      };
    }
    return {
      status: 'modified',
      data: this.parse(response.body, archiveGamesSchema, path),
      validators: response.validators,
      fetchedAt,
    };
  }

  private requireUsername(username: string): string {
    const normalized = normalizeChessComUsername(username);
    if (!normalized) {
      throw new ChessComApiError(
        'invalid_input',
        'Invalid Chess.com username. Use letters, digits, "_" or "-" only.',
      );
    }
    return encodeURIComponent(normalized);
  }

  private async getCached<T>(
    path: string,
    schema: z.ZodType<T>,
    label: string,
  ): Promise<Fetched<T>> {
    const cached = this.cache.get(path);
    const now = this.now();
    if (cached && now - cached.storedAt < cached.maxAgeMs) {
      return { data: cached.data as T, fetchedAt: new Date(cached.storedAt), source: 'cache' };
    }

    const response = await this.request(path, label, cached?.validators);
    const fetchedAt = this.now();

    if (response.status === 304 && cached) {
      this.store(path, {
        data: cached.data,
        validators: { ...cached.validators, ...nonNull(response.validators) },
        storedAt: fetchedAt,
        maxAgeMs: response.maxAgeMs,
      });
      return { data: cached.data as T, fetchedAt: new Date(fetchedAt), source: 'revalidated' };
    }

    const data = this.parse(response.body, schema, path);
    if (response.noStore) {
      this.cache.delete(path);
    } else {
      this.store(path, {
        data,
        validators: response.validators,
        storedAt: fetchedAt,
        maxAgeMs: response.maxAgeMs,
      });
    }
    return { data, fetchedAt: new Date(fetchedAt), source: 'network' };
  }

  private store(path: string, entry: CacheEntry): void {
    this.cache.delete(path);
    this.cache.set(path, entry);
    while (this.cache.size > this.cacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private parse<T>(body: string | null, schema: z.ZodType<T>, path: string): T {
    let json: unknown;
    try {
      json = JSON.parse(body ?? '');
    } catch (error) {
      throw new ChessComApiError(
        'invalid_response',
        'Chess.com returned a response that is not valid JSON.',
        { path },
        { cause: error },
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ChessComApiError(
        'invalid_response',
        'Chess.com returned data in an unexpected format.',
        { path },
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  /** Runs requests one at a time across the whole process. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(task, task);
    this.queueTail = run.catch(() => undefined);
    return run;
  }

  private request(path: string, label: string, validators?: CacheValidators): Promise<RawResponse> {
    return this.serialize(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const started = this.now();
        try {
          const response = await this.attempt(path, label, validators);
          this.logger.debug(
            { path, status: response.status, attempt, durationMs: this.now() - started },
            'Chess.com request completed',
          );
          return response;
        } catch (error) {
          const apiError = toApiError(error, path).withDetails({ attempts: attempt });
          const delayMs = this.retryDelay(apiError, attempt);
          if (delayMs === null) {
            this.logger.warn(
              { path, kind: apiError.kind, status: apiError.details.status, attempts: attempt },
              'Chess.com request failed',
            );
            throw apiError;
          }
          this.logger.warn(
            { path, kind: apiError.kind, status: apiError.details.status, attempt, delayMs },
            'Chess.com request failed; retrying',
          );
          await this.sleep(delayMs);
        }
      }
    });
  }

  /** Returns the backoff before the next attempt, or null when the error must surface. */
  private retryDelay(error: ChessComApiError, attempt: number): number | null {
    if (!error.retryable || attempt > this.maxRetries) return null;
    const retryAfterSeconds = error.details.retryAfterSeconds;
    if (retryAfterSeconds !== undefined) {
      const ms = retryAfterSeconds * 1000;
      return ms <= this.maxRetryAfterMs ? ms : null;
    }
    const exponential = this.retryBaseDelayMs * 2 ** (attempt - 1);
    return Math.round(exponential + this.random() * this.retryBaseDelayMs);
  }

  private async attempt(
    path: string,
    label: string,
    validators?: CacheValidators,
  ): Promise<RawResponse> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
    };
    if (validators?.etag) headers['if-none-match'] = validators.etag;
    if (validators?.lastModified) headers['if-modified-since'] = validators.lastModified;

    let url = new URL(path, API_ORIGIN);
    for (let redirects = 0; ; redirects += 1) {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        const target = safeRedirectTarget(url, response.headers.get('location'));
        if (!target || redirects >= MAX_REDIRECTS) {
          throw new ChessComApiError(
            'upstream_error',
            'Chess.com returned an unexpected redirect.',
            {
              path,
              status: response.status,
              retryable: false,
            },
          );
        }
        this.logger.info(
          { from: url.pathname, to: target.pathname },
          'Chess.com redirected request',
        );
        url = target;
        continue;
      }

      const responseValidators: CacheValidators = {
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      };
      const cacheControl = parseCacheControl(response.headers.get('cache-control'));

      if (response.status === 200) {
        const body = await readBodyWithLimit(response, this.maxResponseBytes, path);
        return { status: 200, body, validators: responseValidators, ...cacheControl };
      }

      await response.body?.cancel();

      if (response.status === 304 && validators) {
        return { status: 304, body: null, validators: responseValidators, ...cacheControl };
      }
      throw statusError(response, path, label);
    }
  }
}

function nonNull(validators: CacheValidators): Partial<CacheValidators> {
  return Object.fromEntries(Object.entries(validators).filter(([, value]) => value !== null));
}

function safeRedirectTarget(from: URL, location: string | null): URL | null {
  if (!location) return null;
  try {
    const target = new URL(location, from);
    return target.origin === API_ORIGIN && target.pathname.startsWith('/pub/') ? target : null;
  } catch {
    return null;
  }
}

function parseCacheControl(header: string | null): { maxAgeMs: number; noStore: boolean } {
  const directives = (header ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim());
  const noStore = directives.includes('no-store');
  if (noStore || directives.includes('no-cache')) return { maxAgeMs: 0, noStore };
  const maxAge = directives.find((part) => part.startsWith('max-age='));
  const seconds = maxAge ? Number(maxAge.slice('max-age='.length)) : 0;
  return { maxAgeMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0, noStore };
}

/** Retry-After as seconds (delta-seconds or HTTP-date); undefined when absent or unparseable. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

function statusError(response: Response, path: string, label: string): ChessComApiError {
  const status = response.status;
  switch (status) {
    case 404:
      return new ChessComApiError('not_found', `${label} was not found.`, { path, status });
    case 410:
      return new ChessComApiError('gone', `${label} is permanently unavailable.`, { path, status });
    case 429: {
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
      return new ChessComApiError(
        'rate_limited',
        'Chess.com is rate-limiting requests. Try again shortly.',
        { path, status, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) },
      );
    }
    default:
      return new ChessComApiError(
        'upstream_error',
        status >= 500
          ? 'Chess.com is temporarily unavailable. Try again later.'
          : `Chess.com rejected the request (HTTP ${status}).`,
        { path, status, retryable: status >= 500 },
      );
  }
}

function toApiError(error: unknown, path: string): ChessComApiError {
  if (error instanceof ChessComApiError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ChessComApiError(
      'timeout',
      'Chess.com did not respond in time.',
      { path },
      { cause: error },
    );
  }
  return new ChessComApiError('network', 'Could not reach Chess.com.', { path }, { cause: error });
}

async function readBodyWithLimit(response: Response, limit: number, path: string): Promise<string> {
  const tooLarge = () =>
    new ChessComApiError('invalid_response', 'Chess.com response exceeded the size limit.', {
      path,
      retryable: false,
    });

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return '';

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
