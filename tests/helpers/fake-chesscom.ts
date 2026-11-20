import type { ChessComArchiveGame } from '../../src/clients/chesscom.schemas.js';
import { fixture, type Responder } from './fake-fetch.js';

const API = 'https://api.chess.com/pub';

/** Converts a parsed fixture game back into the raw PubAPI JSON shape. */
export function toRawGame(game: ChessComArchiveGame): Record<string, unknown> {
  const player = (side: ChessComArchiveGame['white']) => ({
    username: side.username,
    ...(side.rating !== null ? { rating: side.rating } : {}),
    result: side.resultCode,
  });
  return {
    url: game.url,
    pgn: game.pgn,
    time_control: game.timeControl,
    time_class: game.timeClass,
    rules: game.rules,
    ...(game.rated !== null ? { rated: game.rated } : {}),
    end_time: Math.floor(game.endTime.getTime() / 1000),
    ...(game.ecoUrl ? { eco: game.ecoUrl } : {}),
    white: player(game.white),
    black: player(game.black),
  };
}

interface FakeArchive {
  games: unknown[];
  version: number;
}

/**
 * An in-memory stand-in for the Chess.com PubAPI endpoints used by sync. Archives carry an ETag
 * that changes whenever their games change, and `If-None-Match` yields 304 like the real API.
 */
export class FakeChessCom {
  readonly requests: string[] = [];
  private readonly players = new Map<string, Map<string, FakeArchive>>();
  private readonly failures = new Map<string, Responder>();
  private readonly gates = new Map<string, Promise<void>>();
  private readonly gateReached = new Map<string, () => void>();

  addPlayer(username: string): this {
    this.players.set(username.toLowerCase(), new Map());
    return this;
  }

  setArchive(username: string, year: number, month: number, games: unknown[]): this {
    const archives = this.players.get(username.toLowerCase());
    if (!archives) throw new Error(`Unknown fake player ${username}`);
    const key = archiveKey(year, month);
    const raw = games.map((game) => (isParsedGame(game) ? toRawGame(game) : game));
    archives.set(key, { games: raw, version: (archives.get(key)?.version ?? 0) + 1 });
    return this;
  }

  /** Every request whose path ends with `pathSuffix` is answered by `responder` until cleared. */
  fail(pathSuffix: string, responder: Responder): this {
    this.failures.set(pathSuffix, responder);
    return this;
  }

  clearFailures(): void {
    this.failures.clear();
  }

  /** Holds requests for `pathSuffix` until the returned function is called. */
  gate(pathSuffix: string): { release: () => void; reached: Promise<void> } {
    let release!: () => void;
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.gates.set(
      pathSuffix,
      gate.then(() => void this.gates.delete(pathSuffix)),
    );
    this.gateReached.set(pathSuffix, reached);
    return { release, reached: reachedPromise };
  }

  countRequests(pathSuffix: string): number {
    return this.requests.filter((path) => path.endsWith(pathSuffix)).length;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname;
    this.requests.push(path);
    const headers = new Headers(init?.headers);

    for (const [suffix, gate] of this.gates) {
      if (path.endsWith(suffix)) {
        this.gateReached.get(suffix)?.();
        await gate;
      }
    }
    for (const [suffix, responder] of this.failures) {
      if (path.endsWith(suffix)) {
        return responder(
          { url: url.href, headers: Object.fromEntries(headers), redirect: init?.redirect },
          init?.signal ?? new AbortController().signal,
        );
      }
    }

    const match =
      /^\/pub\/player\/([^/]+)(\/stats|\/games\/archives|\/games\/(\d{4})\/(\d{2}))?$/.exec(path);
    const archives = match ? this.players.get(match[1]!) : undefined;
    if (!match || !archives) return notFound();
    const username = match[1]!;

    if (!match[2]) return jsonResponse({ ...(fixture('profile.json') as object), username });
    if (match[2] === '/stats') return jsonResponse(fixture('stats.json'));

    if (match[2] === '/games/archives') {
      const urls = [...archives.keys()]
        .sort()
        .map((key) => `${API}/player/${username}/games/${key}`);
      return jsonResponse({ archives: urls });
    }

    const archive = archives.get(`${match[3]}/${match[4]}`);
    if (!archive) return jsonResponse({ games: [] });
    const etag = `"v${archive.version}"`;
    if (headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return jsonResponse({ games: archive.games }, { etag });
  }) as typeof fetch;
}

function archiveKey(year: number, month: number): string {
  return `${year}/${String(month).padStart(2, '0')}`;
}

function isParsedGame(game: unknown): game is ChessComArchiveGame {
  return typeof game === 'object' && game !== null && 'endTime' in game;
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function notFound(): Response {
  return new Response('{"code":0,"message":"User \\"x\\" not found."}', {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}
