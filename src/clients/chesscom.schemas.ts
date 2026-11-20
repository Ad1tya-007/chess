import * as z from 'zod/v4';

import { epochSecondsToDate } from '../utils/dates.js';

/**
 * Defensive parsing of Chess.com PubAPI responses (untrusted input).
 *
 * Required fields fail the whole response (or, for archived games, only that game). Optional
 * fields that are absent or malformed become `null`: never fabricated, never fatal.
 */

const MAX_TEXT = 200;
const MAX_URL = 2048;
const MAX_PGN = 1_000_000;

/** Absent or malformed optional values become undefined instead of failing the parse. */
const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const text = (max = MAX_TEXT) => z.string().max(max);
const epochSeconds = z
  .number()
  .refine((value) => epochSecondsToDate(value) !== null, { error: 'Invalid timestamp' });
const rating = z.number().int().min(0).max(5000);
const count = z.number().int().nonnegative();

const CHESS_COM_WEB_PREFIX = 'https://www.chess.com/';
export const GAME_URL_PATTERN = /^https:\/\/www\.chess\.com\/game\/[a-z]+\/\d+$/;
const COUNTRY_URL_PATTERN = /^https:\/\/api\.chess\.com\/pub\/country\/([A-Z0-9]{2,3})$/;

const toDate = (seconds: number | undefined): Date | null =>
  seconds === undefined ? null : epochSecondsToDate(seconds);

const chessComWebUrl = (value: string | undefined): string | null =>
  value?.startsWith(CHESS_COM_WEB_PREFIX) ? value : null;

// --- Player profile: GET /pub/player/{username} ---------------------------------------------

const rawProfileSchema = z.object({
  username: text(100).min(1),
  player_id: opt(z.number().int()),
  url: opt(text(MAX_URL)),
  name: opt(text()),
  title: opt(text(10)),
  status: opt(text(50)),
  country: opt(text(MAX_URL)),
  location: opt(text()),
  joined: opt(epochSeconds),
  last_online: opt(epochSeconds),
  followers: opt(count),
  fide: opt(rating),
  is_streamer: opt(z.boolean()),
  league: opt(text(50)),
});

export interface ChessComProfile {
  username: string;
  playerId: number | null;
  name: string | null;
  title: string | null;
  status: string | null;
  /** ISO-style code from the country URL, e.g. "US". Chess.com also uses non-ISO codes like "XE". */
  countryCode: string | null;
  location: string | null;
  profileUrl: string | null;
  joinedAt: Date | null;
  lastOnlineAt: Date | null;
  followers: number | null;
  fideRating: number | null;
  isStreamer: boolean | null;
  league: string | null;
}

export const profileSchema = rawProfileSchema.transform((raw): ChessComProfile => ({
  username: raw.username,
  playerId: raw.player_id ?? null,
  name: raw.name ?? null,
  title: raw.title ?? null,
  status: raw.status ?? null,
  countryCode: raw.country?.match(COUNTRY_URL_PATTERN)?.[1] ?? null,
  location: raw.location ?? null,
  profileUrl: chessComWebUrl(raw.url),
  joinedAt: toDate(raw.joined),
  lastOnlineAt: toDate(raw.last_online),
  followers: raw.followers ?? null,
  fideRating: raw.fide ?? null,
  isStreamer: raw.is_streamer ?? null,
  league: raw.league ?? null,
}));

// --- Player stats: GET /pub/player/{username}/stats ------------------------------------------

/** Rating categories are keyed `<rules>_<time class>`, e.g. chess_rapid or chess960_daily. */
const RATING_CATEGORY_PATTERN = /^([a-z0-9]+)_(daily|rapid|blitz|bullet)$/;

const ratingBlockSchemas = {
  last: z.object({ rating, date: opt(epochSeconds), rd: opt(z.number().nonnegative()) }),
  best: z.object({ rating, date: opt(epochSeconds), game: opt(text(MAX_URL)) }),
  record: z.object({
    win: count,
    loss: count,
    draw: count,
    time_per_move: opt(count),
    timeout_percent: opt(z.number().min(0).max(100)),
  }),
};

/** Parses one stats block; a present-but-malformed block is reported rather than failing. */
function parseBlock<K extends keyof typeof ratingBlockSchemas>(
  category: Record<string, unknown>,
  key: K,
  categoryName: string,
  warnings: string[],
): z.infer<(typeof ratingBlockSchemas)[K]> | null {
  if (category[key] === undefined) return null;
  const parsed = ratingBlockSchemas[key].safeParse(category[key]);
  if (parsed.success) return parsed.data as z.infer<(typeof ratingBlockSchemas)[K]>;
  warnings.push(`Ignored malformed "${key}" data in stats category "${categoryName}".`);
  return null;
}

const highLowSchema = z.object({
  highest: opt(z.object({ rating, date: opt(epochSeconds) })),
  lowest: opt(z.object({ rating, date: opt(epochSeconds) })),
});

const puzzleRushSchema = z.object({
  best: opt(z.object({ score: count, total_attempts: opt(count) })),
});

export interface RatingCategoryStats {
  /** Raw Chess.com key, e.g. "chess_rapid". */
  category: string;
  rules: string;
  timeClass: 'daily' | 'rapid' | 'blitz' | 'bullet';
  /** Current rating (Chess.com "last"): the rating after the most recent rated game. */
  current: { rating: number; date: Date | null; ratingDeviation: number | null } | null;
  best: { rating: number; date: Date | null; gameUrl: string | null } | null;
  /** All-time record in this category as reported by Chess.com. */
  record: {
    wins: number;
    losses: number;
    draws: number;
    timePerMoveSeconds: number | null;
    timeoutPercent: number | null;
  } | null;
}

export interface ChessComStats {
  ratings: RatingCategoryStats[];
  fideRating: number | null;
  tactics: { highest: number | null; lowest: number | null } | null;
  puzzleRushBest: { score: number; totalAttempts: number | null } | null;
  /** Categories present in the response that could not be parsed. */
  warnings: string[];
}

export const statsSchema = z.record(z.string(), z.unknown()).transform((raw): ChessComStats => {
  const ratings: RatingCategoryStats[] = [];
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(raw)) {
    const match = RATING_CATEGORY_PATTERN.exec(key);
    if (!match) continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      warnings.push(`Ignored malformed stats category "${key}".`);
      continue;
    }
    const category = value as Record<string, unknown>;
    const last = parseBlock(category, 'last', key, warnings);
    const best = parseBlock(category, 'best', key, warnings);
    const record = parseBlock(category, 'record', key, warnings);
    if (!last && !best && !record) {
      warnings.push(`Ignored stats category "${key}" with no usable data.`);
      continue;
    }
    ratings.push({
      category: key,
      rules: match[1]!,
      timeClass: match[2] as RatingCategoryStats['timeClass'],
      current: last
        ? { rating: last.rating, date: toDate(last.date), ratingDeviation: last.rd ?? null }
        : null,
      best: best
        ? { rating: best.rating, date: toDate(best.date), gameUrl: chessComWebUrl(best.game) }
        : null,
      record: record
        ? {
            wins: record.win,
            losses: record.loss,
            draws: record.draw,
            timePerMoveSeconds: record.time_per_move ?? null,
            timeoutPercent: record.timeout_percent ?? null,
          }
        : null,
    });
  }

  ratings.sort((a, b) => a.category.localeCompare(b.category));

  const fide = rating.safeParse(raw.fide);
  const tactics = highLowSchema.safeParse(raw.tactics);
  const puzzleRush = puzzleRushSchema.safeParse(raw.puzzle_rush);

  return {
    ratings,
    fideRating: fide.success ? fide.data : null,
    tactics:
      tactics.success && (tactics.data.highest || tactics.data.lowest)
        ? {
            highest: tactics.data.highest?.rating ?? null,
            lowest: tactics.data.lowest?.rating ?? null,
          }
        : null,
    puzzleRushBest:
      puzzleRush.success && puzzleRush.data.best
        ? {
            score: puzzleRush.data.best.score,
            totalAttempts: puzzleRush.data.best.total_attempts ?? null,
          }
        : null,
    warnings,
  };
});

// --- Archive list: GET /pub/player/{username}/games/archives ---------------------------------

export interface ArchiveMonth {
  year: number;
  month: number;
}

export interface ArchiveList {
  /** Ascending chronological order, de-duplicated. */
  archives: ArchiveMonth[];
  /** Entries that were not a well-formed archive URL for the requested player. */
  ignoredEntries: number;
}

const ARCHIVE_URL_PATTERN =
  /^https:\/\/api\.chess\.com\/pub\/player\/([^/]+)\/games\/(\d{4})\/(\d{2})$/;

/**
 * Extracts year/month from an archive URL listed for `username`. Archive URLs are never fetched
 * directly; the client rebuilds them from these validated parts.
 */
export function parseArchiveUrl(url: string, username: string): ArchiveMonth | null {
  const match = ARCHIVE_URL_PATTERN.exec(url);
  if (!match || match[1]!.toLowerCase() !== username.toLowerCase()) return null;
  const year = Number(match[2]);
  const month = Number(match[3]);
  return isValidArchiveMonth({ year, month }) ? { year, month } : null;
}

export function isValidArchiveMonth({ year, month }: ArchiveMonth): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    year >= 2000 &&
    year <= 2100 &&
    month >= 1 &&
    month <= 12
  );
}

export const archiveListSchema = (username: string) =>
  z.object({ archives: z.array(z.unknown()).max(10_000) }).transform((raw): ArchiveList => {
    const seen = new Map<number, ArchiveMonth>();
    let ignoredEntries = 0;
    for (const entry of raw.archives) {
      const parsed = typeof entry === 'string' ? parseArchiveUrl(entry, username) : null;
      if (!parsed) {
        ignoredEntries += 1;
        continue;
      }
      seen.set(parsed.year * 100 + parsed.month, parsed);
    }
    const archives = [...seen.entries()].sort(([a], [b]) => a - b).map(([, month]) => month);
    return { archives, ignoredEntries };
  });

// --- Monthly archive: GET /pub/player/{username}/games/{YYYY}/{MM} ----------------------------

const rawGamePlayerSchema = z.object({
  username: text(100).min(1),
  rating: opt(rating),
  /** Chess.com result code, e.g. win, checkmated, resigned, agreed, timevsinsufficient. */
  result: text(50).min(1),
  uuid: opt(text(100)),
});

const rawArchiveGameSchema = z.object({
  url: z.string().regex(GAME_URL_PATTERN),
  uuid: opt(text(100)),
  pgn: opt(text(MAX_PGN)),
  time_control: opt(text(50)),
  time_class: opt(text(20)),
  rules: opt(text(30)),
  rated: opt(z.boolean()),
  start_time: opt(epochSeconds),
  end_time: epochSeconds,
  eco: opt(text(MAX_URL)),
  initial_setup: opt(text(MAX_TEXT)),
  fen: opt(text(MAX_TEXT)),
  white: rawGamePlayerSchema,
  black: rawGamePlayerSchema,
});

export interface ChessComGamePlayer {
  username: string;
  rating: number | null;
  resultCode: string;
  uuid: string | null;
}

/** An archived game as reported by Chess.com. Perspective normalization happens later. */
export interface ChessComArchiveGame {
  url: string;
  uuid: string | null;
  pgn: string | null;
  timeControl: string | null;
  timeClass: string | null;
  rules: string | null;
  rated: boolean | null;
  startTime: Date | null;
  endTime: Date;
  /** Chess.com opening page URL, e.g. https://www.chess.com/openings/Caro-Kann-Defense... */
  ecoUrl: string | null;
  initialSetup: string | null;
  fen: string | null;
  white: ChessComGamePlayer;
  black: ChessComGamePlayer;
}

export interface SkippedGame {
  index: number;
  /** The game URL when it was readable, for traceability. */
  url: string | null;
  reason: string;
}

export interface ArchiveGames {
  /** Ascending game-end-time order, as delivered by Chess.com. */
  games: ChessComArchiveGame[];
  /** Entries that could not be parsed; the rest of the archive is still returned. */
  skipped: SkippedGame[];
}

const toPlayer = (raw: z.infer<typeof rawGamePlayerSchema>): ChessComGamePlayer => ({
  username: raw.username,
  rating: raw.rating ?? null,
  resultCode: raw.result,
  uuid: raw.uuid ?? null,
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export const archiveGamesSchema = z
  .object({ games: z.array(z.unknown()).max(50_000) })
  .transform((raw): ArchiveGames => {
    const games: ChessComArchiveGame[] = [];
    const skipped: SkippedGame[] = [];

    raw.games.forEach((entry, index) => {
      const parsed = rawArchiveGameSchema.safeParse(entry);
      if (!parsed.success) {
        const url = (entry as { url?: unknown } | null)?.url;
        skipped.push({
          index,
          url: typeof url === 'string' && GAME_URL_PATTERN.test(url) ? url : null,
          reason: describeIssues(parsed.error),
        });
        return;
      }
      const game = parsed.data;
      games.push({
        url: game.url,
        uuid: game.uuid ?? null,
        pgn: game.pgn ?? null,
        timeControl: game.time_control ?? null,
        timeClass: game.time_class ?? null,
        rules: game.rules ?? null,
        rated: game.rated ?? null,
        startTime: toDate(game.start_time),
        endTime: epochSecondsToDate(game.end_time)!,
        ecoUrl: game.eco?.startsWith('https://www.chess.com/openings/') ? game.eco : null,
        initialSetup: game.initial_setup ?? null,
        fen: game.fen ?? null,
        white: toPlayer(game.white),
        black: toPlayer(game.black),
      });
    });

    return { games, skipped };
  });
