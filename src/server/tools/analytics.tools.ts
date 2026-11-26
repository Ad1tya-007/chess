import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { LOW_SAMPLE_GAMES } from '../../domain/analytics.js';
import type { OpponentStat, RatingAverage, Streak } from '../../domain/analytics.types.js';
import { PLAYER_COLORS } from '../../domain/game.types.js';
import {
  type AnalyticsService,
  DEFAULT_MIN_GAMES,
  DEFAULT_OPENING_LIMIT,
  DEFAULT_OPPONENT_LIMIT,
  MAX_MIN_GAMES,
  MAX_OPENING_LIMIT,
  MAX_OPPONENT_LIMIT,
  PERIODS,
  RATING_TREND_METHOD,
  STREAK_DEFINITION,
} from '../../services/analytics.service.js';
import { CHESSCOM_USERNAME_PATTERN } from '../../utils/chesscom-username.js';
import type { Logger } from '../../utils/logger.js';
import {
  dataCoverageOutput,
  dataCoverageWire,
  DEFINITIONS,
  formatCount,
  formatPercent,
  fromDateInput,
  iso,
  isoDate,
  nullableIsoDate,
  openingOutput,
  openingWire,
  parseFromDate,
  parseToDate,
  resultSummaryOutput,
  resultSummaryWire,
  runTool,
  SOURCE_LOCAL,
  timeClassInput,
  toDateInput,
  type UsernamePolicy,
  warningsOutput,
} from './shared.js';

const dateRangeOutput = z
  .object({ first_game_at: nullableIsoDate, last_game_at: nullableIsoDate })
  .describe('First and last game included in the calculation.');

export const openingStatsOutput = z.object({
  username: z.string(),
  source: z.literal(SOURCE_LOCAL),
  generated_at: isoDate,
  filters: z.object({
    color: z.enum(['white', 'black', 'both']),
    time_class: z.string().nullable(),
    from_date: z.string().nullable(),
    to_date: z.string().nullable(),
    min_games: z.number().int(),
    limit: z.number().int(),
  }),
  definitions: z.record(z.string(), z.string()),
  totals: resultSummaryOutput.describe('All games matching the filters.'),
  openings: z.array(openingOutput).describe('Most-played first.'),
  openings_matching: z.number().int().describe('Openings meeting min_games, before limit.'),
  openings_returned: z.number().int(),
  openings_below_min_games: z.number().int(),
  games_below_min_games: z.number().int(),
  date_range: dateRangeOutput,
  truncated: z.boolean(),
  data_coverage: dataCoverageOutput,
  warnings: warningsOutput,
});

const ratingAverageOutput = z.object({
  value: z.number().int().nullable(),
  games_with_rating: z.number().int().describe('Denominator of the mean.'),
});

const streakOutput = z.object({ length: z.number().int(), from: isoDate, to: isoDate }).nullable();

export const performanceOutput = z.object({
  username: z.string(),
  source: z.literal(SOURCE_LOCAL),
  generated_at: isoDate,
  period: z.enum(PERIODS),
  period_start: nullableIsoDate,
  period_end: isoDate,
  time_class: z.string().nullable(),
  definitions: z.record(z.string(), z.string()),
  results: resultSummaryOutput,
  by_color: z.object({ white: resultSummaryOutput, black: resultSummaryOutput }),
  average_opponent_rating: ratingAverageOutput,
  average_player_rating: ratingAverageOutput,
  rating_trends: z.array(
    z.object({
      time_class: z.string().nullable(),
      games_with_rating: z.number().int(),
      first_rating: z.number().int().nullable(),
      last_rating: z.number().int().nullable(),
      change: z.number().int().nullable(),
      min_rating: z.number().int().nullable(),
      max_rating: z.number().int().nullable(),
      first_game_at: nullableIsoDate,
      last_game_at: nullableIsoDate,
    }),
  ),
  top_openings: z.array(openingOutput),
  streaks: z.object({
    longest_win_streak: streakOutput,
    longest_loss_streak: streakOutput,
    current: z.object({ type: z.enum(['win', 'loss']).nullable(), length: z.number().int() }),
  }),
  date_range: dateRangeOutput,
  truncated: z.boolean(),
  data_coverage: dataCoverageOutput,
  warnings: warningsOutput,
});

const opponentOutput = resultSummaryOutput.extend({
  opponent: z.string(),
  low_sample: z.boolean(),
  first_played_at: isoDate,
  last_played_at: isoDate,
  average_opponent_rating: ratingAverageOutput,
  by_color: z.object({ white: resultSummaryOutput, black: resultSummaryOutput }),
});

export const opponentStatsOutput = z.object({
  username: z.string(),
  source: z.literal(SOURCE_LOCAL),
  generated_at: isoDate,
  filters: z.object({
    opponent: z.string().nullable(),
    color: z.enum(['white', 'black', 'both']),
    time_class: z.string().nullable(),
    from_date: z.string().nullable(),
    to_date: z.string().nullable(),
    min_games: z.number().int(),
    limit: z.number().int(),
  }),
  definitions: z.record(z.string(), z.string()),
  totals: resultSummaryOutput.describe('All games matching the filters.'),
  opponents: z.array(opponentOutput).describe('Most-played opponents first.'),
  opponents_matching: z.number().int().describe('Opponents meeting min_games, before limit.'),
  opponents_returned: z.number().int(),
  opponents_below_min_games: z.number().int(),
  games_below_min_games: z.number().int(),
  date_range: dateRangeOutput,
  truncated: z.boolean(),
  data_coverage: dataCoverageOutput,
  warnings: warningsOutput,
});

const ANALYTICS_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const ratingAverageWire = (average: RatingAverage) => ({
  value: average.value,
  games_with_rating: average.gamesWithRating,
});

const streakWire = (streak: Streak | null) =>
  streak ? { length: streak.length, from: iso(streak.from), to: iso(streak.to) } : null;

const opponentWire = (row: OpponentStat): z.infer<typeof opponentOutput> => ({
  opponent: row.opponentUsername,
  ...resultSummaryWire(row),
  low_sample: row.lowSample,
  first_played_at: iso(row.firstPlayedAt),
  last_played_at: iso(row.lastPlayedAt),
  average_opponent_rating: ratingAverageWire(row.averageOpponentRating),
  by_color: {
    white: resultSummaryWire(row.byColor.white),
    black: resultSummaryWire(row.byColor.black),
  },
});

export function registerAnalyticsTools(
  server: McpServer,
  analytics: AnalyticsService,
  users: UsernamePolicy,
  logger: Logger,
) {
  server.registerTool(
    'get_opening_statistics',
    {
      title: 'Opening statistics',
      description:
        'Per-opening results (games, wins, losses, draws, win rate, score percentage) from the ' +
        "player's perspective, grouped by ECO code plus opening name, computed from " +
        'synchronized games. Choose color white, black, or both; optionally filter by time ' +
        `class and date range. Openings with fewer than ${LOW_SAMPLE_GAMES} games are flagged ` +
        'low_sample. Requires synchronized games (see sync_chesscom_games).',
      inputSchema: z.object({
        username: users.input,
        color: z
          .enum([...PLAYER_COLORS, 'both'])
          .describe('Games where the player had white, black, or both.'),
        time_class: timeClassInput,
        from_date: fromDateInput,
        to_date: toDateInput,
        min_games: z
          .number()
          .int()
          .min(1)
          .max(MAX_MIN_GAMES)
          .optional()
          .describe(`Hide openings with fewer games (default ${DEFAULT_MIN_GAMES}).`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_OPENING_LIMIT)
          .optional()
          .describe(
            `Openings to return (1-${MAX_OPENING_LIMIT}, default ${DEFAULT_OPENING_LIMIT}).`,
          ),
      }),
      outputSchema: openingStatsOutput,
      annotations: { title: 'Opening statistics', ...ANALYTICS_ANNOTATIONS },
    },
    (input) =>
      runTool(logger, 'get_opening_statistics', async () => {
        const stats = await analytics.getOpeningStatistics({
          username: users.check(input.username),
          color: input.color,
          timeClass: input.time_class,
          from: parseFromDate(input.from_date),
          until: parseToDate(input.to_date),
          minGames: input.min_games,
          limit: input.limit,
        });
        const data: z.infer<typeof openingStatsOutput> = {
          username: stats.username,
          source: SOURCE_LOCAL,
          generated_at: iso(new Date()),
          filters: {
            color: stats.color,
            time_class: stats.timeClass,
            from_date: input.from_date ?? null,
            to_date: input.to_date ?? null,
            min_games: stats.minGames,
            limit: input.limit ?? DEFAULT_OPENING_LIMIT,
          },
          definitions: {
            ...DEFINITIONS,
            low_sample: `fewer than ${LOW_SAMPLE_GAMES} games`,
            grouping: 'ECO code plus opening name; distinct ECO codes are never merged',
          },
          totals: resultSummaryWire(stats.totals),
          openings: stats.openings.map(openingWire),
          openings_matching: stats.openingsMatching,
          openings_returned: stats.openings.length,
          openings_below_min_games: stats.groupsBelowMinGames,
          games_below_min_games: stats.gamesBelowMinGames,
          date_range: {
            first_game_at: iso(stats.firstGameAt),
            last_game_at: iso(stats.lastGameAt),
          },
          truncated: stats.truncated,
          data_coverage: dataCoverageWire(stats.local),
          warnings: stats.warnings,
        };
        const top = stats.openings[0];
        return {
          summary:
            `${stats.openings.length} opening(s) with at least ${stats.minGames} games for ` +
            `${stats.username} (${stats.color}) across ${formatCount(stats.totals.games)} games.` +
            (top
              ? ` Most played: ${top.eco ?? '?'} ${top.openingName ?? 'unknown'} ` +
                `(${top.games} games, score ${formatPercent(top.scorePercentage)}).`
              : ''),
          data,
        };
      }),
  );

  server.registerTool(
    'get_performance_summary',
    {
      title: 'Performance summary',
      description:
        'Summarize results over a period (7d, 30d, 90d, or all) from synchronized games: games, ' +
        'wins/losses/draws, win rate and score percentage, white vs black, average player and ' +
        'opponent rating, rating trend per time class (from recorded game ratings), top ' +
        'openings, and longest win/loss streaks. Optionally filter by time class. Requires ' +
        'synchronized games (see sync_chesscom_games); for official current ratings use ' +
        'get_player_stats.',
      inputSchema: z.object({
        username: users.input,
        period: z.enum(PERIODS).optional().describe('7d, 30d (default), 90d, or all.'),
        time_class: timeClassInput,
      }),
      outputSchema: performanceOutput,
      annotations: { title: 'Performance summary', ...ANALYTICS_ANNOTATIONS },
    },
    (input) =>
      runTool(logger, 'get_performance_summary', async () => {
        const summary = await analytics.getPerformanceSummary({
          username: users.check(input.username),
          period: input.period,
          timeClass: input.time_class,
        });
        const data: z.infer<typeof performanceOutput> = {
          username: summary.username,
          source: SOURCE_LOCAL,
          generated_at: iso(new Date()),
          period: summary.period,
          period_start: iso(summary.periodStart),
          period_end: iso(summary.periodEnd),
          time_class: summary.timeClass,
          definitions: {
            ...DEFINITIONS,
            average_rating: 'arithmetic mean of non-null ratings; denominator is games_with_rating',
            rating_trend: RATING_TREND_METHOD,
            streak: STREAK_DEFINITION,
          },
          results: resultSummaryWire(summary.results),
          by_color: {
            white: resultSummaryWire(summary.byColor.white),
            black: resultSummaryWire(summary.byColor.black),
          },
          average_opponent_rating: ratingAverageWire(summary.averageOpponentRating),
          average_player_rating: ratingAverageWire(summary.averagePlayerRating),
          rating_trends: summary.ratingTrends.map((trend) => ({
            time_class: trend.timeClass,
            games_with_rating: trend.gamesWithRating,
            first_rating: trend.firstRating,
            last_rating: trend.lastRating,
            change: trend.change,
            min_rating: trend.minRating,
            max_rating: trend.maxRating,
            first_game_at: iso(trend.firstGameAt),
            last_game_at: iso(trend.lastGameAt),
          })),
          top_openings: summary.topOpenings.map(openingWire),
          streaks: {
            longest_win_streak: streakWire(summary.streaks.longestWinStreak),
            longest_loss_streak: streakWire(summary.streaks.longestLossStreak),
            current: summary.streaks.current,
          },
          date_range: {
            first_game_at: iso(summary.firstGameAt),
            last_game_at: iso(summary.lastGameAt),
          },
          truncated: summary.truncated,
          data_coverage: dataCoverageWire(summary.local),
          warnings: summary.warnings,
        };
        const results = summary.results;
        return {
          summary:
            `${summary.username}, ${summary.period}${summary.timeClass ? ` ${summary.timeClass}` : ''}: ` +
            `${formatCount(results.games)} games, ${results.wins}W/${results.losses}L/${results.draws}D, ` +
            `win rate ${formatPercent(results.winRate)}, score ${formatPercent(results.scorePercentage)}.`,
          data,
        };
      }),
  );

  server.registerTool(
    'get_opponent_statistics',
    {
      title: 'Opponent / head-to-head statistics',
      description:
        'Per-opponent results (games, wins, losses, draws, win rate, score percentage) from the ' +
        "player's perspective, grouped by opponent username (case-insensitive), computed from " +
        'synchronized games. Omit opponent to see who you have played most; pass opponent for a ' +
        'head-to-head record. Optionally filter by color, time class, and date range. Opponents ' +
        `with fewer than ${LOW_SAMPLE_GAMES} games are flagged low_sample. Requires synchronized ` +
        'games (see sync_chesscom_games).',
      inputSchema: z.object({
        username: users.input,
        opponent: z
          .string()
          .regex(CHESSCOM_USERNAME_PATTERN, 'Chess.com usernames use letters, digits, "_" and "-".')
          .optional()
          .describe(
            'Optional. When set, return only the head-to-head vs this opponent (case-insensitive).',
          ),
        color: z
          .enum([...PLAYER_COLORS, 'both'])
          .optional()
          .describe('Games where the player had white, black, or both (default both).'),
        time_class: timeClassInput,
        from_date: fromDateInput,
        to_date: toDateInput,
        min_games: z
          .number()
          .int()
          .min(1)
          .max(MAX_MIN_GAMES)
          .optional()
          .describe(
            `Hide opponents with fewer games (default ${DEFAULT_MIN_GAMES}, or 1 when opponent is set).`,
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_OPPONENT_LIMIT)
          .optional()
          .describe(
            `Opponents to return (1-${MAX_OPPONENT_LIMIT}, default ${DEFAULT_OPPONENT_LIMIT}).`,
          ),
      }),
      outputSchema: opponentStatsOutput,
      annotations: { title: 'Opponent / head-to-head statistics', ...ANALYTICS_ANNOTATIONS },
    },
    (input) =>
      runTool(logger, 'get_opponent_statistics', async () => {
        const stats = await analytics.getOpponentStatistics({
          username: users.check(input.username),
          opponent: input.opponent,
          color: input.color,
          timeClass: input.time_class,
          from: parseFromDate(input.from_date),
          until: parseToDate(input.to_date),
          minGames: input.min_games,
          limit: input.limit,
        });
        const data: z.infer<typeof opponentStatsOutput> = {
          username: stats.username,
          source: SOURCE_LOCAL,
          generated_at: iso(new Date()),
          filters: {
            opponent: stats.opponentFilter,
            color: stats.color,
            time_class: stats.timeClass,
            from_date: input.from_date ?? null,
            to_date: input.to_date ?? null,
            min_games: stats.minGames,
            limit: input.limit ?? DEFAULT_OPPONENT_LIMIT,
          },
          definitions: {
            ...DEFINITIONS,
            low_sample: `fewer than ${LOW_SAMPLE_GAMES} games`,
            grouping: 'opponent username, case-insensitive',
          },
          totals: resultSummaryWire(stats.totals),
          opponents: stats.opponents.map(opponentWire),
          opponents_matching: stats.opponentsMatching,
          opponents_returned: stats.opponents.length,
          opponents_below_min_games: stats.groupsBelowMinGames,
          games_below_min_games: stats.gamesBelowMinGames,
          date_range: {
            first_game_at: iso(stats.firstGameAt),
            last_game_at: iso(stats.lastGameAt),
          },
          truncated: stats.truncated,
          data_coverage: dataCoverageWire(stats.local),
          warnings: stats.warnings,
        };
        const top = stats.opponents[0];
        const summary = stats.opponentFilter
          ? top
            ? `Head-to-head vs ${top.opponentUsername}: ${formatCount(top.games)} games, ` +
              `${top.wins}W/${top.losses}L/${top.draws}D, win rate ${formatPercent(top.winRate)}, ` +
              `score ${formatPercent(top.scorePercentage)}.`
            : `No synchronized games against "${stats.opponentFilter}" for ${stats.username}.`
          : `${stats.opponents.length} opponent(s) with at least ${stats.minGames} games for ` +
            `${stats.username} across ${formatCount(stats.totals.games)} games.` +
            (top
              ? ` Most played: ${top.opponentUsername} (${top.games} games, score ` +
                `${formatPercent(top.scorePercentage)}).`
              : '');
        return { summary, data };
      }),
  );
}
