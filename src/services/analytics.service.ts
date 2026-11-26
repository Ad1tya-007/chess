import {
  aggregateOpenings,
  aggregateOpponents,
  averageRating,
  breakdownByTermination,
  buildOpeningMoveTree,
  computeStreaks,
  DEFAULT_MOVE_TREE_MAX_CHILDREN,
  DEFAULT_MOVE_TREE_MAX_PLY,
  LOW_SAMPLE_GAMES,
  MAX_MOVE_TREE_MAX_CHILDREN,
  MAX_MOVE_TREE_MAX_PLY,
  ratingTrends,
  summarizeResults,
} from '../domain/analytics.js';
import type {
  AnalyticsGame,
  OpeningMoveTreeNode,
  OpeningStat,
  OpponentStat,
  RatingAverage,
  RatingTrend,
  ResultBreakdown,
  ResultSummary,
  StreakSummary,
} from '../domain/analytics.types.js';
import type { PlayerColor, TimeClass } from '../domain/game.types.js';
import type { GameFilters, GameRepository } from '../repositories/game.repository.js';
import { isValidChessComUsername, resolveUsername } from '../utils/chesscom-username.js';
import { AppError } from '../utils/errors.js';
import { assertInteger, assertRange, normalizeOpponentFilter } from './game.service.js';
import type { LocalDataService, LocalDataStatus } from './local-data.service.js';

export {
  DEFAULT_MOVE_TREE_MAX_CHILDREN,
  DEFAULT_MOVE_TREE_MAX_PLY,
  MAX_MOVE_TREE_MAX_CHILDREN,
  MAX_MOVE_TREE_MAX_PLY,
};

/** Analytics consider at most this many of the most recent matching games. */
export const MAX_ANALYTICS_GAMES = 50_000;
export const DEFAULT_MIN_GAMES = 3;
export const MAX_MIN_GAMES = 1_000;
export const DEFAULT_OPENING_LIMIT = 20;
export const MAX_OPENING_LIMIT = 100;
export const DEFAULT_OPPONENT_LIMIT = 20;
export const MAX_OPPONENT_LIMIT = 100;
export const TOP_OPENINGS_IN_SUMMARY = 5;

export const PERIODS = ['7d', '30d', '90d', 'all'] as const;
export type Period = (typeof PERIODS)[number];
const PERIOD_DAYS: Record<Exclude<Period, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

export const RATING_TREND_METHOD =
  "Player's recorded rating in the first and last synchronized rated game of each time class, " +
  'in chronological order. This samples archived games; it is not an official rating history.';

export const STREAK_DEFINITION =
  'Consecutive wins (or losses) in chronological order within the filtered games. A draw ends ' +
  'both kinds of streak. Ties report the most recent streak.';

interface Dataset {
  username: string;
  local: LocalDataStatus;
  games: AnalyticsGame[];
  truncated: boolean;
  warnings: string[];
}

export interface OpeningStatisticsQuery {
  username?: string | undefined;
  color: PlayerColor | 'both';
  timeClass?: TimeClass | undefined;
  from?: Date | undefined;
  until?: Date | undefined;
  rated?: boolean | undefined;
  opponent?: string | undefined;
  timeControl?: string | undefined;
  minGames?: number | undefined;
  limit?: number | undefined;
}

export interface OpeningStatistics {
  username: string;
  color: PlayerColor | 'both';
  timeClass: TimeClass | null;
  from: Date | null;
  until: Date | null;
  rated: boolean | null;
  opponent: string | null;
  timeControl: string | null;
  minGames: number;
  totals: ResultSummary;
  openings: OpeningStat[];
  /** Opening groups meeting minGames, before applying `limit`. */
  openingsMatching: number;
  groupsBelowMinGames: number;
  gamesBelowMinGames: number;
  firstGameAt: Date | null;
  lastGameAt: Date | null;
  truncated: boolean;
  local: LocalDataStatus;
  warnings: string[];
}

export interface PerformanceSummaryQuery {
  username?: string | undefined;
  period?: Period | undefined;
  timeClass?: TimeClass | undefined;
  rated?: boolean | undefined;
  opponent?: string | undefined;
  timeControl?: string | undefined;
}

export interface OpeningMoveTreeQuery {
  username?: string | undefined;
  color: PlayerColor | 'both';
  timeClass?: TimeClass | undefined;
  from?: Date | undefined;
  until?: Date | undefined;
  maxPly?: number | undefined;
  minGames?: number | undefined;
  maxChildren?: number | undefined;
}

export interface OpeningMoveTreeStatistics {
  username: string;
  color: PlayerColor | 'both';
  timeClass: TimeClass | null;
  from: Date | null;
  until: Date | null;
  maxPly: number;
  minGames: number;
  maxChildren: number;
  totals: ResultSummary;
  root: OpeningMoveTreeNode;
  gamesWithMoves: number;
  gamesMissingMoves: number;
  nodesReturned: number;
  firstGameAt: Date | null;
  lastGameAt: Date | null;
  truncated: boolean;
  local: LocalDataStatus;
  warnings: string[];
}

export interface PerformanceSummary {
  username: string;
  period: Period;
  periodStart: Date | null;
  periodEnd: Date;
  timeClass: TimeClass | null;
  rated: boolean | null;
  opponent: string | null;
  timeControl: string | null;
  results: ResultSummary;
  byColor: Record<PlayerColor, ResultSummary>;
  averageOpponentRating: RatingAverage;
  averagePlayerRating: RatingAverage;
  ratingTrends: RatingTrend[];
  topOpenings: OpeningStat[];
  streaks: StreakSummary;
  firstGameAt: Date | null;
  lastGameAt: Date | null;
  truncated: boolean;
  local: LocalDataStatus;
  warnings: string[];
}

export interface OpponentStatisticsQuery {
  username?: string | undefined;
  /** When set, return only the head-to-head vs this opponent (case-insensitive). */
  opponent?: string | undefined;
  color?: PlayerColor | 'both' | undefined;
  timeClass?: TimeClass | undefined;
  from?: Date | undefined;
  until?: Date | undefined;
  minGames?: number | undefined;
  limit?: number | undefined;
}

export interface OpponentStatistics {
  username: string;
  opponentFilter: string | null;
  color: PlayerColor | 'both';
  timeClass: TimeClass | null;
  from: Date | null;
  until: Date | null;
  minGames: number;
  totals: ResultSummary;
  opponents: OpponentStat[];
  /** Opponent groups meeting minGames, before applying `limit`. */
  opponentsMatching: number;
  groupsBelowMinGames: number;
  gamesBelowMinGames: number;
  firstGameAt: Date | null;
  lastGameAt: Date | null;
  truncated: boolean;
  local: LocalDataStatus;
  warnings: string[];
}

export interface ResultBreakdownQuery {
  username?: string | undefined;
  period?: Period | undefined;
  timeClass?: TimeClass | undefined;
  color?: PlayerColor | 'both' | undefined;
  from?: Date | undefined;
  until?: Date | undefined;
}

export interface ResultBreakdownSummary {
  username: string;
  period: Period | 'custom';
  periodStart: Date | null;
  periodEnd: Date | null;
  timeClass: TimeClass | null;
  color: PlayerColor | 'both';
  breakdown: ResultBreakdown;
  firstGameAt: Date | null;
  lastGameAt: Date | null;
  truncated: boolean;
  local: LocalDataStatus;
  warnings: string[];
}

export const TERMINATION_DEFINITION =
  "How the game ended using Chess.com result codes: on wins, the opponent's loss code " +
  "(checkmated, resigned, timeout, …); on losses and draws, the player's own code. Null when " +
  'the code was never stored (pre-migration rows) or only a PGN Result tag was available.';

export interface AnalyticsServiceDependencies {
  games: GameRepository;
  localData: LocalDataService;
  defaultUsername: string;
  now?: () => Date;
}

/** Aggregates over synchronized games, always from the requested player's perspective. */
export class AnalyticsService {
  private readonly now: () => Date;

  constructor(private readonly deps: AnalyticsServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async getOpeningStatistics(query: OpeningStatisticsQuery): Promise<OpeningStatistics> {
    const minGames = query.minGames ?? DEFAULT_MIN_GAMES;
    const limit = query.limit ?? DEFAULT_OPENING_LIMIT;
    assertInteger('min_games', minGames, 1, MAX_MIN_GAMES);
    assertInteger('limit', limit, 1, MAX_OPENING_LIMIT);
    assertRange(query.from, query.until);

    const opponent = normalizeOpponentFilter(query.opponent);
    const dataset = await this.load(query.username, {
      timeClass: query.timeClass,
      color: query.color === 'both' ? undefined : query.color,
      from: query.from,
      until: query.until,
      rated: query.rated,
      opponent,
      timeControl: query.timeControl,
    });
    const aggregated = aggregateOpenings(dataset.games, minGames);
    const openings = aggregated.openings.slice(0, limit);

    const warnings = [...dataset.warnings];
    if (dataset.local.gamesStored > 0 && dataset.games.length === 0) {
      warnings.push('No synchronized games match these filters.');
    }
    if (openings.some((opening) => opening.lowSample)) {
      warnings.push(
        `Openings with fewer than ${LOW_SAMPLE_GAMES} games are flagged low_sample; their ` +
          'rates are anecdotal, not strong evidence.',
      );
    }

    return {
      username: dataset.username,
      color: query.color,
      timeClass: query.timeClass ?? null,
      from: query.from ?? null,
      until: query.until ?? null,
      rated: query.rated ?? null,
      opponent: opponent ?? null,
      timeControl: query.timeControl ?? null,
      minGames,
      totals: summarizeResults(dataset.games),
      openings,
      openingsMatching: aggregated.openings.length,
      groupsBelowMinGames: aggregated.groupsBelowMinGames,
      gamesBelowMinGames: aggregated.gamesBelowMinGames,
      firstGameAt: dataset.games[0]?.playedAt ?? null,
      lastGameAt: dataset.games.at(-1)?.playedAt ?? null,
      truncated: dataset.truncated,
      local: dataset.local,
      warnings,
    };
  }

  async getOpeningMoveTree(query: OpeningMoveTreeQuery): Promise<OpeningMoveTreeStatistics> {
    const maxPly = query.maxPly ?? DEFAULT_MOVE_TREE_MAX_PLY;
    const minGames = query.minGames ?? DEFAULT_MIN_GAMES;
    const maxChildren = query.maxChildren ?? DEFAULT_MOVE_TREE_MAX_CHILDREN;
    assertInteger('max_ply', maxPly, 1, MAX_MOVE_TREE_MAX_PLY);
    assertInteger('min_games', minGames, 1, MAX_MIN_GAMES);
    assertInteger('max_children', maxChildren, 1, MAX_MOVE_TREE_MAX_CHILDREN);
    assertRange(query.from, query.until);

    const dataset = await this.load(query.username, {
      timeClass: query.timeClass,
      color: query.color === 'both' ? undefined : query.color,
      from: query.from,
      until: query.until,
    });
    const tree = buildOpeningMoveTree(dataset.games, { maxPly, minGames, maxChildren });

    const warnings = [...dataset.warnings];
    if (dataset.local.gamesStored > 0 && dataset.games.length === 0) {
      warnings.push('No synchronized games match these filters.');
    }
    if (tree.gamesMissingMoves > 0) {
      warnings.push(
        `${tree.gamesMissingMoves} game(s) were skipped because san_moves could not be parsed; ` +
          're-sync those months or inspect them with get_game_details.',
      );
    }
    if (tree.gamesWithMoves === 0 && dataset.games.length > 0) {
      warnings.push('No filtered games have parsed SAN moves to build a move tree.');
    }
    if (hasLowSampleNode(tree.root)) {
      warnings.push(
        `Nodes with fewer than ${LOW_SAMPLE_GAMES} games are flagged low_sample; their rates ` +
          'are anecdotal, not strong evidence.',
      );
    }

    return {
      username: dataset.username,
      color: query.color,
      timeClass: query.timeClass ?? null,
      from: query.from ?? null,
      until: query.until ?? null,
      maxPly,
      minGames,
      maxChildren,
      totals: summarizeResults(dataset.games),
      root: tree.root,
      gamesWithMoves: tree.gamesWithMoves,
      gamesMissingMoves: tree.gamesMissingMoves,
      nodesReturned: tree.nodesReturned,
      firstGameAt: dataset.games[0]?.playedAt ?? null,
      lastGameAt: dataset.games.at(-1)?.playedAt ?? null,
      truncated: dataset.truncated,
      local: dataset.local,
      warnings,
    };
  }

  async getPerformanceSummary(query: PerformanceSummaryQuery = {}): Promise<PerformanceSummary> {
    const period = query.period ?? '30d';
    const periodEnd = this.now();
    const periodStart =
      period === 'all' ? null : new Date(periodEnd.getTime() - PERIOD_DAYS[period] * 86_400_000);

    const opponent = normalizeOpponentFilter(query.opponent);
    const dataset = await this.load(query.username, {
      timeClass: query.timeClass,
      from: periodStart ?? undefined,
      rated: query.rated,
      opponent,
      timeControl: query.timeControl,
    });
    const { games } = dataset;

    const warnings = [...dataset.warnings];
    if (dataset.local.gamesStored > 0 && games.length === 0) {
      warnings.push(`No synchronized games in the selected period (${period}).`);
    }
    if (!query.timeClass && new Set(games.map((game) => game.timeClass)).size > 1) {
      warnings.push(
        'Average player rating mixes time classes, whose ratings are not comparable; use ' +
          'rating_trends or filter by time_class.',
      );
    }

    return {
      username: dataset.username,
      period,
      periodStart,
      periodEnd,
      timeClass: query.timeClass ?? null,
      rated: query.rated ?? null,
      opponent: opponent ?? null,
      timeControl: query.timeControl ?? null,
      results: summarizeResults(games),
      byColor: {
        white: summarizeResults(games.filter((game) => game.playerColor === 'white')),
        black: summarizeResults(games.filter((game) => game.playerColor === 'black')),
      },
      averageOpponentRating: averageRating(games.map((game) => game.opponentRating)),
      averagePlayerRating: averageRating(games.map((game) => game.playerRating)),
      ratingTrends: ratingTrends(games),
      topOpenings: aggregateOpenings(games).openings.slice(0, TOP_OPENINGS_IN_SUMMARY),
      streaks: computeStreaks(games),
      firstGameAt: games[0]?.playedAt ?? null,
      lastGameAt: games.at(-1)?.playedAt ?? null,
      truncated: dataset.truncated,
      local: dataset.local,
      warnings,
    };
  }

  async getOpponentStatistics(query: OpponentStatisticsQuery = {}): Promise<OpponentStatistics> {
    const color = query.color ?? 'both';
    const minGames = query.minGames ?? (query.opponent ? 1 : DEFAULT_MIN_GAMES);
    const limit = query.limit ?? DEFAULT_OPPONENT_LIMIT;
    assertInteger('min_games', minGames, 1, MAX_MIN_GAMES);
    assertInteger('limit', limit, 1, MAX_OPPONENT_LIMIT);
    assertRange(query.from, query.until);

    let opponentFilter: string | null = null;
    if (query.opponent !== undefined) {
      const trimmed = query.opponent.trim();
      if (!isValidChessComUsername(trimmed)) {
        throw new AppError('invalid_input', 'Invalid opponent Chess.com username.');
      }
      opponentFilter = trimmed.toLowerCase();
    }

    const dataset = await this.load(query.username, {
      timeClass: query.timeClass,
      color: color === 'both' ? undefined : color,
      opponent: opponentFilter ?? undefined,
      from: query.from,
      until: query.until,
    });
    const aggregated = aggregateOpponents(dataset.games, minGames);
    const opponents = aggregated.opponents.slice(0, limit);

    const warnings = [...dataset.warnings];
    if (dataset.local.gamesStored > 0 && dataset.games.length === 0) {
      warnings.push(
        opponentFilter
          ? `No synchronized games against "${opponentFilter}" match these filters.`
          : 'No synchronized games match these filters.',
      );
    }
    if (opponents.some((row) => row.lowSample)) {
      warnings.push(
        `Opponents with fewer than ${LOW_SAMPLE_GAMES} games are flagged low_sample; their ` +
          'rates are anecdotal, not strong evidence.',
      );
    }

    return {
      username: dataset.username,
      opponentFilter,
      color,
      timeClass: query.timeClass ?? null,
      from: query.from ?? null,
      until: query.until ?? null,
      minGames,
      totals: summarizeResults(dataset.games),
      opponents,
      opponentsMatching: aggregated.opponents.length,
      groupsBelowMinGames: aggregated.groupsBelowMinGames,
      gamesBelowMinGames: aggregated.gamesBelowMinGames,
      firstGameAt: dataset.games[0]?.playedAt ?? null,
      lastGameAt: dataset.games.at(-1)?.playedAt ?? null,
      truncated: dataset.truncated,
      local: dataset.local,
      warnings,
    };
  }

  async getResultBreakdown(query: ResultBreakdownQuery = {}): Promise<ResultBreakdownSummary> {
    assertRange(query.from, query.until);

    const hasCustomDates = query.from !== undefined || query.until !== undefined;
    let period: Period | 'custom';
    let periodStart: Date | null;
    let periodEnd: Date | null;
    if (hasCustomDates) {
      period = 'custom';
      periodStart = query.from ?? null;
      periodEnd = query.until ?? null;
    } else {
      period = query.period ?? '30d';
      periodEnd = this.now();
      periodStart =
        period === 'all' ? null : new Date(periodEnd.getTime() - PERIOD_DAYS[period] * 86_400_000);
    }

    const color = query.color === 'both' ? undefined : query.color;
    const dataset = await this.load(query.username, {
      timeClass: query.timeClass,
      color,
      from: periodStart ?? undefined,
      until: periodEnd ?? undefined,
    });
    const { games } = dataset;
    const breakdown = breakdownByTermination(games);

    const warnings = [...dataset.warnings];
    if (dataset.local.gamesStored > 0 && games.length === 0) {
      warnings.push(
        hasCustomDates
          ? 'No synchronized games match these filters.'
          : `No synchronized games in the selected period (${period}).`,
      );
    }
    if (breakdown.missingTermination > 0) {
      warnings.push(
        `${breakdown.missingTermination} game(s) lack a termination code (synced before ` +
          'termination was stored, or inferred only from the PGN Result tag). Re-sync those ' +
          'months with sync_chesscom_games to backfill Chess.com result codes when available.',
      );
    }

    return {
      username: dataset.username,
      period,
      periodStart,
      periodEnd,
      timeClass: query.timeClass ?? null,
      color: query.color ?? 'both',
      breakdown,
      firstGameAt: games[0]?.playedAt ?? null,
      lastGameAt: games.at(-1)?.playedAt ?? null,
      truncated: dataset.truncated,
      local: dataset.local,
      warnings,
    };
  }

  private async load(username: string | undefined, filters: GameFilters): Promise<Dataset> {
    const resolved = resolveUsername(username, this.deps.defaultUsername);
    const local = await this.deps.localData.describe(resolved);
    const warnings = [...local.warnings, ...this.deps.localData.rangeWarnings(local, filters.from)];
    if (!local.player || local.gamesStored === 0) {
      return { username: resolved, local, games: [], truncated: false, warnings };
    }

    const { games, truncated } = await this.deps.games.listForAnalytics(
      local.player.id,
      filters,
      MAX_ANALYTICS_GAMES,
    );
    if (truncated) {
      warnings.push(
        `Only the most recent ${MAX_ANALYTICS_GAMES} matching games were analyzed; narrow the ` +
          'date range or time class to include older games.',
      );
    }
    return { username: resolved, local, games, truncated, warnings };
  }
}

function hasLowSampleNode(node: OpeningMoveTreeNode): boolean {
  if (node.games > 0 && node.lowSample) return true;
  return node.children.some(hasLowSampleNode);
}
