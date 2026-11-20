import { and, count, desc, eq, gte, lt, max, min, sql, type SQL } from 'drizzle-orm';

import type { Db, DbExecutor } from '../db/client.js';
import { games } from '../db/schema.js';
import type { AnalyticsGame } from '../domain/analytics.types.js';
import type { GameResult, NormalizedGame, PlayerColor, TimeClass } from '../domain/game.types.js';

export type GameRow = typeof games.$inferSelect;

export interface GameFilters {
  timeClass?: TimeClass | undefined;
  result?: GameResult | undefined;
  color?: PlayerColor | undefined;
  /** Inclusive lower bound on played_at. */
  from?: Date | undefined;
  /** Exclusive upper bound on played_at. */
  until?: Date | undefined;
}

/** A game without its PGN and move list, for listings. */
export type GameSummaryRow = Omit<GameRow, 'pgn' | 'sanMoves' | 'createdAt' | 'updatedAt'>;

export interface GameCoverage {
  games: number;
  firstPlayedAt: Date | null;
  lastPlayedAt: Date | null;
}

const PLAYER_RATING = sql<
  number | null
>`case when ${games.playerColor} = 'white' then ${games.whiteRating} else ${games.blackRating} end`;

const SUMMARY_COLUMNS = {
  id: games.id,
  playerId: games.playerId,
  chesscomGameUrl: games.chesscomGameUrl,
  playedAt: games.playedAt,
  timeClass: games.timeClass,
  timeControl: games.timeControl,
  rated: games.rated,
  whiteUsername: games.whiteUsername,
  blackUsername: games.blackUsername,
  whiteRating: games.whiteRating,
  blackRating: games.blackRating,
  result: games.result,
  playerColor: games.playerColor,
  opponentUsername: games.opponentUsername,
  opponentRating: games.opponentRating,
  eco: games.eco,
  openingName: games.openingName,
};

function whereClause(playerId: string, filters: GameFilters): SQL {
  const conditions: SQL[] = [eq(games.playerId, playerId)];
  if (filters.timeClass) conditions.push(eq(games.timeClass, filters.timeClass));
  if (filters.result) conditions.push(eq(games.result, filters.result));
  if (filters.color) conditions.push(eq(games.playerColor, filters.color));
  if (filters.from) conditions.push(gte(games.playedAt, filters.from));
  if (filters.until) conditions.push(lt(games.playedAt, filters.until));
  return and(...conditions)!;
}

export interface UpsertGamesResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

/** 500 rows x 20 columns stays well under PostgreSQL's 65,535 bind-parameter limit. */
const CHUNK_SIZE = 500;

/** Columns refreshed when Chess.com re-delivers a known game. */
const MUTABLE_COLUMNS = [
  'playedAt',
  'timeClass',
  'timeControl',
  'rated',
  'whiteUsername',
  'blackUsername',
  'whiteRating',
  'blackRating',
  'result',
  'playerColor',
  'opponentUsername',
  'opponentRating',
  'eco',
  'openingName',
  'pgn',
  'sanMoves',
] as const satisfies ReadonlyArray<keyof NormalizedGame & keyof GameRow>;

const excluded = (column: (typeof MUTABLE_COLUMNS)[number]): SQL =>
  sql`excluded.${sql.identifier(games[column].name)}`;

const UPDATE_SET = {
  ...Object.fromEntries(MUTABLE_COLUMNS.map((column) => [column, excluded(column)])),
  updatedAt: sql`now()`,
};

/** Only touch rows whose content actually changed, so re-syncs are no-ops. */
const CHANGED = sql`(${sql.join(
  MUTABLE_COLUMNS.map((column) => sql`${games[column]}`),
  sql`, `,
)}) is distinct from (${sql.join(MUTABLE_COLUMNS.map(excluded), sql`, `)})`;

export class GameRepository {
  constructor(private readonly db: Db) {}

  /**
   * Idempotently inserts or refreshes games for a player, keyed by (player, game URL).
   * Re-running with the same input changes nothing. Runs in one transaction unless an
   * executor (transaction) is supplied by the caller.
   */
  async upsertMany(
    playerId: string,
    input: NormalizedGame[],
    executor?: DbExecutor,
  ): Promise<UpsertGamesResult> {
    // Duplicate URLs in one statement would make ON CONFLICT fail; the last occurrence wins.
    const unique = [...new Map(input.map((game) => [game.chesscomGameUrl, game])).values()];
    const result: UpsertGamesResult = { inserted: 0, updated: 0, unchanged: 0 };
    if (unique.length === 0) return result;

    const run = async (tx: DbExecutor) => {
      for (let start = 0; start < unique.length; start += CHUNK_SIZE) {
        const chunk = unique.slice(start, start + CHUNK_SIZE);
        const rows = await tx
          .insert(games)
          .values(chunk.map((game) => ({ ...game, playerId })))
          .onConflictDoUpdate({
            target: [games.playerId, games.chesscomGameUrl],
            set: UPDATE_SET,
            setWhere: CHANGED,
          })
          // xmax = 0 identifies freshly inserted rows; unchanged rows are not returned at all.
          .returning({ inserted: sql<boolean>`(xmax = 0)` });

        const inserted = rows.filter((row) => row.inserted).length;
        result.inserted += inserted;
        result.updated += rows.length - inserted;
        result.unchanged += chunk.length - rows.length;
      }
    };

    if (executor) await run(executor);
    else await this.db.transaction(run);
    return result;
  }

  async findByUrl(playerId: string, gameUrl: string): Promise<GameRow | null> {
    const [row] = await this.db
      .select()
      .from(games)
      .where(and(eq(games.playerId, playerId), eq(games.chesscomGameUrl, gameUrl)))
      .limit(1);
    return row ?? null;
  }

  async countForPlayer(playerId: string): Promise<number> {
    return this.countMatching(playerId, {});
  }

  async countMatching(playerId: string, filters: GameFilters): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(games)
      .where(whereClause(playerId, filters));
    return row?.value ?? 0;
  }

  /** Newest first. */
  async listSummaries(
    playerId: string,
    filters: GameFilters,
    page: { limit: number; offset: number },
  ): Promise<GameSummaryRow[]> {
    return this.db
      .select(SUMMARY_COLUMNS)
      .from(games)
      .where(whereClause(playerId, filters))
      .orderBy(desc(games.playedAt), desc(games.chesscomGameUrl))
      .limit(page.limit)
      .offset(page.offset);
  }

  /**
   * Lean rows for analytics in chronological order. At most `maxGames` of the most recent
   * matching games are returned; `truncated` reports whether older games were left out.
   */
  async listForAnalytics(
    playerId: string,
    filters: GameFilters,
    maxGames: number,
  ): Promise<{ games: AnalyticsGame[]; truncated: boolean }> {
    const rows = await this.db
      .select({
        playedAt: games.playedAt,
        result: games.result,
        playerColor: games.playerColor,
        timeClass: games.timeClass,
        eco: games.eco,
        openingName: games.openingName,
        playerRating: PLAYER_RATING,
        opponentRating: games.opponentRating,
      })
      .from(games)
      .where(whereClause(playerId, filters))
      .orderBy(desc(games.playedAt), desc(games.chesscomGameUrl))
      .limit(maxGames + 1);
    const truncated = rows.length > maxGames;
    return { games: rows.slice(0, maxGames).reverse(), truncated };
  }

  async coverage(playerId: string, filters: GameFilters = {}): Promise<GameCoverage> {
    const [row] = await this.db
      .select({ games: count(), first: min(games.playedAt), last: max(games.playedAt) })
      .from(games)
      .where(whereClause(playerId, filters));
    return {
      games: row?.games ?? 0,
      firstPlayedAt: row?.first ?? null,
      lastPlayedAt: row?.last ?? null,
    };
  }
}
