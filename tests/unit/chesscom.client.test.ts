import { describe, expect, it } from 'vitest';

import {
  ChessComClient,
  parseRetryAfter,
  type ChessComClientOptions,
} from '../../src/clients/chesscom.client.js';
import { ChessComApiError } from '../../src/utils/errors.js';
import { createLogger } from '../../src/utils/logger.js';
import {
  fixture,
  hang,
  json,
  networkError,
  scriptedFetch,
  status,
  type Responder,
} from '../helpers/fake-fetch.js';

const UA = 'ChessIntelligenceMCP/test (contact: test@example.com)';
const logger = createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

function setup(responders: Responder[], options: Partial<ChessComClientOptions> = {}) {
  const scripted = scriptedFetch(responders);
  const sleeps: number[] = [];
  let clock = Date.UTC(2026, 10, 18, 12);
  const client = new ChessComClient({
    userAgent: UA,
    timeoutMs: 1_000,
    logger,
    fetch: scripted.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => clock,
    random: () => 0,
    ...options,
  });
  return {
    client,
    scripted,
    sleeps,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function captureError(promise: Promise<unknown>): Promise<ChessComApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ChessComApiError);
    return error as ChessComApiError;
  }
  throw new Error('Expected the promise to reject');
}

describe('ChessComClient requests', () => {
  it('builds the profile URL from the normalized username and sends a descriptive User-Agent', async () => {
    const { client, scripted } = setup([json(fixture('profile.json'))]);
    await client.getPlayerProfile('  TestPlayer ');

    expect(scripted.requests).toHaveLength(1);
    expect(scripted.requests[0]).toMatchObject({
      url: 'https://api.chess.com/pub/player/testplayer',
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
  });

  it.each(['', 'a', 'bad name', '../stats', 'x/y', 'name?callback=x', 'ünïcode'])(
    'rejects invalid username %j without making a request',
    async (username) => {
      const { client, scripted } = setup([]);
      const error = await captureError(client.getPlayerProfile(username));

      expect(error.kind).toBe('invalid_input');
      expect(scripted.requests).toHaveLength(0);
    },
  );

  it('rejects out-of-range archive months without making a request', async () => {
    const { client, scripted } = setup([]);
    for (const archive of [
      { year: 1999, month: 1 },
      { year: 2026, month: 0 },
      { year: 2026, month: 13 },
      { year: 2026.5, month: 1 },
    ]) {
      expect((await captureError(client.getArchiveGames('testplayer', archive))).kind).toBe(
        'invalid_input',
      );
    }
    expect(scripted.requests).toHaveLength(0);
  });

  it('fetches the stats, archive-list and monthly archive endpoints', async () => {
    const { client, scripted } = setup([
      json(fixture('stats.json')),
      json(fixture('archives.json')),
      json(fixture('archive-games.json')),
    ]);
    await client.getPlayerStats('testplayer');
    await client.getArchiveList('testplayer');
    await client.getArchiveGames('testplayer', { year: 2026, month: 3 });

    expect(scripted.requests.map((request) => request.url)).toEqual([
      'https://api.chess.com/pub/player/testplayer/stats',
      'https://api.chess.com/pub/player/testplayer/games/archives',
      'https://api.chess.com/pub/player/testplayer/games/2026/03',
    ]);
  });
});

describe('ChessComClient caching', () => {
  const etag = 'W/"abc123"';
  const lastModified = 'Wednesday, 18-Nov-2026 21:43:23 GMT+0000';

  it('serves a cached response within Cache-Control max-age without a request', async () => {
    const { client, scripted, advance } = setup([
      json(fixture('profile.json'), { headers: { 'cache-control': 'public, max-age=60', etag } }),
    ]);
    const first = await client.getPlayerProfile('testplayer');
    advance(30_000);
    const second = await client.getPlayerProfile('TESTPLAYER');

    expect(first.source).toBe('network');
    expect(second.source).toBe('cache');
    expect(second.data).toEqual(first.data);
    expect(scripted.requests).toHaveLength(1);
  });

  it('revalidates with If-None-Match / If-Modified-Since and uses the cached copy on 304', async () => {
    const { client, scripted, advance } = setup([
      json(fixture('profile.json'), {
        headers: { 'cache-control': 'public, max-age=5', etag, 'last-modified': lastModified },
      }),
      status(304, { etag, 'cache-control': 'public, max-age=5' }),
    ]);
    const first = await client.getPlayerProfile('testplayer');
    advance(10_000);
    const second = await client.getPlayerProfile('testplayer');

    expect(scripted.requests[1]!.headers).toMatchObject({
      'if-none-match': etag,
      'if-modified-since': lastModified,
    });
    expect(second.source).toBe('revalidated');
    expect(second.data).toEqual(first.data);
    expect(second.fetchedAt.getTime()).toBeGreaterThan(first.fetchedAt.getTime());
  });

  it('does not cache responses marked no-store', async () => {
    const { client, scripted } = setup([
      json(fixture('profile.json'), { headers: { 'cache-control': 'no-store', etag } }),
      json(fixture('profile.json'), { headers: { 'cache-control': 'no-store', etag } }),
    ]);
    await client.getPlayerProfile('testplayer');
    await client.getPlayerProfile('testplayer');

    expect(scripted.requests[1]!.headers['if-none-match']).toBeUndefined();
  });

  it('returns not_modified for an unchanged archive when validators are supplied', async () => {
    const { client, scripted } = setup([status(304, { etag })]);
    const result = await client.getArchiveGames(
      'testplayer',
      { year: 2026, month: 11 },
      { etag, lastModified: null },
    );

    expect(scripted.requests[0]!.headers['if-none-match']).toBe(etag);
    expect(scripted.requests[0]!.headers['if-modified-since']).toBeUndefined();
    expect(result).toMatchObject({
      status: 'not_modified',
      validators: { etag, lastModified: null },
    });
  });

  it('returns archive data and its validators when modified', async () => {
    const { client } = setup([
      json(fixture('archive-games.json'), { headers: { etag, 'last-modified': lastModified } }),
    ]);
    const result = await client.getArchiveGames('testplayer', { year: 2026, month: 11 });

    expect(result.status).toBe('modified');
    if (result.status !== 'modified') return;
    expect(result.validators).toEqual({ etag, lastModified });
    expect(result.data.games).toHaveLength(3);
  });

  it('treats an unsolicited 304 as an upstream error', async () => {
    const { client } = setup([status(304)]);
    const error = await captureError(
      client.getArchiveGames('testplayer', { year: 2026, month: 11 }),
    );
    expect(error).toMatchObject({ kind: 'upstream_error', details: { status: 304 } });
  });
});

describe('ChessComClient errors and retries', () => {
  it('maps 404 to not_found without retrying', async () => {
    const { client, scripted, sleeps } = setup([status(404)]);
    const error = await captureError(client.getPlayerProfile('missing-user'));

    expect(error).toMatchObject({ kind: 'not_found', code: 'chesscom_not_found' });
    expect(error.details).toMatchObject({ status: 404, attempts: 1 });
    expect(error.message).toBe('Chess.com player "missing-user" was not found.');
    expect(scripted.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('maps 410 to gone without retrying', async () => {
    const { client, scripted } = setup([status(410)]);
    const error = await captureError(
      client.getArchiveGames('testplayer', { year: 2026, month: 1 }),
    );

    expect(error).toMatchObject({ kind: 'gone', details: { status: 410, attempts: 1 } });
    expect(scripted.requests).toHaveLength(1);
  });

  it('waits for Retry-After on 429 and then succeeds', async () => {
    const { client, scripted, sleeps } = setup([
      status(429, { 'retry-after': '2' }),
      json(fixture('profile.json')),
    ]);
    const result = await client.getPlayerProfile('testplayer');

    expect(result.data.username).toBe('testplayer');
    expect(sleeps).toEqual([2_000]);
    expect(scripted.requests).toHaveLength(2);
  });

  it('gives up with rate_limited after the bounded number of 429 retries', async () => {
    const { client, scripted, sleeps } = setup([status(429), status(429), status(429)], {
      maxRetries: 2,
      retryBaseDelayMs: 100,
    });
    const error = await captureError(client.getPlayerStats('testplayer'));

    expect(error).toMatchObject({ kind: 'rate_limited', details: { status: 429, attempts: 3 } });
    expect(sleeps).toEqual([100, 200]);
    expect(scripted.remaining).toBe(0);
  });

  it('does not wait for a Retry-After longer than the configured maximum', async () => {
    const { client, scripted, sleeps } = setup([status(429, { 'retry-after': '3600' })], {
      maxRetryAfterMs: 30_000,
    });
    const error = await captureError(client.getPlayerProfile('testplayer'));

    expect(error).toMatchObject({ kind: 'rate_limited', details: { retryAfterSeconds: 3600 } });
    expect(sleeps).toEqual([]);
    expect(scripted.requests).toHaveLength(1);
  });

  it('retries transient 5xx responses with exponential backoff', async () => {
    const { client, sleeps } = setup([status(503), status(502), json(fixture('profile.json'))], {
      retryBaseDelayMs: 100,
      random: () => 0.5,
    });
    const result = await client.getPlayerProfile('testplayer');

    expect(result.source).toBe('network');
    expect(sleeps).toEqual([150, 250]);
  });

  it('surfaces upstream_error after persistent 5xx responses', async () => {
    const { client, scripted } = setup([status(500), status(500), status(500)]);
    const error = await captureError(client.getPlayerProfile('testplayer'));

    expect(error).toMatchObject({ kind: 'upstream_error', details: { status: 500, attempts: 3 } });
    expect(error.message).toBe('Chess.com is temporarily unavailable. Try again later.');
    expect(scripted.remaining).toBe(0);
  });

  it('does not retry unexpected 4xx responses', async () => {
    const { client, scripted } = setup([status(400)]);
    const error = await captureError(client.getPlayerProfile('testplayer'));

    expect(error).toMatchObject({ kind: 'upstream_error', details: { status: 400, attempts: 1 } });
    expect(scripted.requests).toHaveLength(1);
  });

  it('retries network failures', async () => {
    const { client, scripted } = setup([networkError(), json(fixture('profile.json'))]);
    await client.getPlayerProfile('testplayer');
    expect(scripted.requests).toHaveLength(2);
  });

  it('reports network when Chess.com stays unreachable', async () => {
    const { client } = setup([networkError(), networkError(), networkError()]);
    const error = await captureError(client.getPlayerProfile('testplayer'));
    expect(error).toMatchObject({ kind: 'network', details: { attempts: 3 } });
  });

  it('aborts a request that exceeds the timeout', async () => {
    const { client } = setup([hang()], { timeoutMs: 20, maxRetries: 0 });
    const error = await captureError(client.getPlayerProfile('testplayer'));
    expect(error).toMatchObject({ kind: 'timeout', details: { attempts: 1 } });
  });

  it('retries a timed-out request and then succeeds', async () => {
    const { client, scripted } = setup([hang(), json(fixture('profile.json'))], {
      timeoutMs: 20,
      maxRetries: 1,
    });
    await client.getPlayerProfile('testplayer');
    expect(scripted.requests).toHaveLength(2);
  });

  it('rejects a body that is not JSON without retrying', async () => {
    const { client, scripted } = setup([json('<html>maintenance</html>')]);
    const error = await captureError(client.getPlayerProfile('testplayer'));

    expect(error.kind).toBe('invalid_response');
    expect(error.message).not.toContain('maintenance');
    expect(scripted.requests).toHaveLength(1);
  });

  it('rejects a response missing required fields', async () => {
    const { client } = setup([json({ player_id: 1 })]);
    expect((await captureError(client.getPlayerProfile('testplayer'))).kind).toBe(
      'invalid_response',
    );
  });

  it('rejects responses larger than the size limit', async () => {
    const { client } = setup([json({ username: 'x'.repeat(5_000) })], { maxResponseBytes: 1_000 });
    const error = await captureError(client.getPlayerProfile('testplayer'));
    expect(error).toMatchObject({ kind: 'invalid_response', details: { attempts: 1 } });
  });

  it('follows a redirect that stays on the PubAPI', async () => {
    const { client, scripted } = setup([
      status(301, { location: '/pub/player/renamed' }),
      json(fixture('profile.json')),
    ]);
    await client.getPlayerProfile('oldname');

    expect(scripted.requests.map((request) => request.url)).toEqual([
      'https://api.chess.com/pub/player/oldname',
      'https://api.chess.com/pub/player/renamed',
    ]);
  });

  it('refuses redirects to other hosts', async () => {
    const { client, scripted } = setup([
      status(302, { location: 'https://evil.example.com/pub/player/x' }),
    ]);
    const error = await captureError(client.getPlayerProfile('testplayer'));

    expect(error).toMatchObject({ kind: 'upstream_error', details: { status: 302, attempts: 1 } });
    expect(scripted.requests).toHaveLength(1);
  });
});

describe('ChessComClient concurrency', () => {
  it('never has more than one request in flight', async () => {
    const slow: Responder = () =>
      new Promise((resolve) => setTimeout(() => resolve(json(fixture('profile.json'))()), 10));
    const { client, scripted } = setup([slow, slow, slow]);

    await Promise.all([
      client.getPlayerProfile('a-player'),
      client.getPlayerProfile('b-player'),
      client.getPlayerProfile('c-player'),
    ]);

    expect(scripted.requests).toHaveLength(3);
    expect(scripted.maxInFlight).toBe(1);
  });

  it('keeps processing queued requests after one fails', async () => {
    const { client } = setup([status(404), json(fixture('profile.json'))]);
    const [failed, succeeded] = await Promise.allSettled([
      client.getPlayerProfile('missing'),
      client.getPlayerProfile('testplayer'),
    ]);

    expect(failed.status).toBe('rejected');
    expect(succeeded.status).toBe('fulfilled');
  });
});

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 10, 18, 12);

  it.each([
    [null, undefined],
    ['', undefined],
    ['5', 5],
    [' 0 ', 0],
    ['soon', undefined],
    [new Date(now + 10_000).toUTCString(), 10],
    [new Date(now - 10_000).toUTCString(), 0],
  ])('parses %j as %j', (header, expected) => {
    expect(parseRetryAfter(header, now)).toBe(expected);
  });
});
