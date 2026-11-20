import {
  aggregateOpenings,
  averageRating,
  computeStreaks,
  LOW_SAMPLE_GAMES,
  ratingTrends,
  summarizeResults,
} from '../domain/analytics.js';
import type {
  AnalyticsGame,
  OpeningStat,
  RatingAverage,
  RatingTrend,
  ResultSummary,
  StreakSummary,
} from '../domain/analytics.types.js';
import type { PlayerColor, TimeClass } from '../domain/game.types.js';
import type { GameFilters, GameRepository } from '../repositories/game.repository.js';
import { resolveUsername } from '../utils/chesscom-username.js';
import { assertInteger, assertRange } from './game.service.js';
import type { LocalDataService, LocalDataStatus } from './local-data.service.js';

/** Analytics consider at most this many of the most recent matching games. */
export const MAX_ANALYTICS_GAMES = 50_000;
export const DEFAULT_MIN_GAMES = 3;
export const MAX_MIN_GAMES = 1_000;
export const DEFAULT_OPENING_LIMIT = 20;
export const MAX_OPENING_LIMIT = 100;
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
  minGames?: number | undefined;
  limit?: number | undefined;
}

export interface OpeningStatistics {
  username: string;
  color: PlayerColor | 'both';
  timeClass: TimeClass | null;
  from: Date | null;
  until: Date | null;
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
}

export interface PerformanceSummary {
  username: string;
  period: Period;
  periodStart: Date | null;
  periodEnd: Date;
  timeClass: TimeClass | null;
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

    const dataset = await this.load(query.username, {
      timeClass: query.timeClass,
      color: query.color === 'both' ? undefined : query.color,
      from: query.from,
      until: query.until,
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

  async getPerformanceSummary(query: PerformanceSummaryQuery = {}): Promise<PerformanceSummary> {
    const period = query.period ?? '30d';
    const periodEnd = this.now();
    const periodStart =
      period === 'all' ? null : new Date(periodEnd.getTime() - PERIOD_DAYS[period] * 86_400_000);

    const dataset = await this.load(query.username, {
      timeClass: query.timeClass,
      from: periodStart ?? undefined,
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
