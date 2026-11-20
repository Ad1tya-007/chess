import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { percentage } from '../../domain/analytics.js';
import type { PlayerService } from '../../services/player.service.js';
import type { Logger } from '../../utils/logger.js';
import {
  dataCoverageOutput,
  dataCoverageWire,
  formatCount,
  iso,
  isoDate,
  nullableIsoDate,
  runTool,
  SOURCE_CHESSCOM,
  type UsernamePolicy,
  warningsOutput,
} from './shared.js';

const liveFields = {
  username: z.string(),
  source: z.literal(SOURCE_CHESSCOM),
  generated_at: isoDate,
  fetched_at: isoDate.describe('When the data was retrieved from Chess.com.'),
  cache: z
    .enum(['network', 'revalidated', 'cache'])
    .describe('network = fresh download, revalidated = unchanged (304), cache = recent copy.'),
};

export const profileOutput = z.object({
  ...liveFields,
  profile: z.object({
    username: z.string(),
    name: z.string().nullable(),
    title: z.string().nullable(),
    status: z.string().nullable(),
    country_code: z.string().nullable(),
    location: z.string().nullable(),
    profile_url: z.string().nullable(),
    joined_at: nullableIsoDate,
    last_online_at: nullableIsoDate,
    followers: z.number().int().nullable(),
    fide_rating: z.number().int().nullable(),
    is_streamer: z.boolean().nullable(),
    league: z.string().nullable(),
  }),
  local_data: dataCoverageOutput,
  warnings: warningsOutput,
});

const STATS_NOTE =
  'current_rating is the rating Chess.com reports now for each category; record is the all-time ' +
  'win/loss/draw total Chess.com reports for that category. Neither is computed from synchronized ' +
  'games. For performance over a period, use get_performance_summary.';

export const statsOutput = z.object({
  ...liveFields,
  note: z.string(),
  ratings: z.array(
    z.object({
      category: z.string().describe('Chess.com key, e.g. chess_rapid or chess960_daily.'),
      rules: z.string(),
      time_class: z.string(),
      current_rating: z.number().int().nullable(),
      current_rating_date: nullableIsoDate,
      rating_deviation: z.number().nullable(),
      best_rating: z.number().int().nullable(),
      best_rating_date: nullableIsoDate,
      best_rating_game_url: z.string().nullable(),
      record: z
        .object({
          games: z.number().int(),
          wins: z.number().int(),
          losses: z.number().int(),
          draws: z.number().int(),
          win_rate: z.number().nullable(),
          score_percentage: z.number().nullable(),
          time_per_move_seconds: z.number().nullable(),
          timeout_percent: z.number().nullable(),
        })
        .nullable(),
    }),
  ),
  fide_rating: z.number().int().nullable(),
  tactics: z
    .object({ highest: z.number().int().nullable(), lowest: z.number().int().nullable() })
    .nullable(),
  puzzle_rush_best: z
    .object({ score: z.number().int(), total_attempts: z.number().int().nullable() })
    .nullable(),
  warnings: warningsOutput,
});

const READ_ONLY_LIVE = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerPlayerTools(
  server: McpServer,
  player: PlayerService,
  users: UsernamePolicy,
  logger: Logger,
) {
  server.registerTool(
    'get_player_profile',
    {
      title: 'Get Chess.com profile',
      description:
        'Fetch the public Chess.com profile (display name, title, country, profile URL, join ' +
        'date, last online) live from the Chess.com API. Also reports how many games are ' +
        'synchronized locally. Does not require a prior sync.',
      inputSchema: z.object({ username: users.input }),
      outputSchema: profileOutput,
      annotations: { title: 'Get Chess.com profile', ...READ_ONLY_LIVE },
    },
    ({ username }) =>
      runTool(logger, 'get_player_profile', async () => {
        const result = await player.getProfile(users.check(username));
        const profile = result.data;
        const data: z.infer<typeof profileOutput> = {
          username: result.username,
          source: SOURCE_CHESSCOM,
          generated_at: iso(new Date()),
          fetched_at: iso(result.fetchedAt),
          cache: result.cache,
          profile: {
            username: profile.username,
            name: profile.name,
            title: profile.title,
            status: profile.status,
            country_code: profile.countryCode,
            location: profile.location,
            profile_url: profile.profileUrl,
            joined_at: iso(profile.joinedAt),
            last_online_at: iso(profile.lastOnlineAt),
            followers: profile.followers,
            fide_rating: profile.fideRating,
            is_streamer: profile.isStreamer,
            league: profile.league,
          },
          local_data: dataCoverageWire(result.local),
          warnings: result.local.warnings,
        };
        const who = [profile.title, profile.name].filter(Boolean).join(' ');
        return {
          summary:
            `Chess.com profile for ${profile.username}${who ? ` (${who})` : ''}` +
            `${profile.joinedAt ? `, joined ${profile.joinedAt.toISOString().slice(0, 10)}` : ''}. ` +
            `${formatCount(result.local.gamesStored)} games synchronized locally.`,
          data,
        };
      }),
  );

  server.registerTool(
    'get_player_stats',
    {
      title: 'Get Chess.com ratings',
      description:
        'Fetch current Chess.com ratings, best ratings, and all-time win/loss/draw records per ' +
        'category (rapid, blitz, bullet, daily, and variants when present), plus FIDE, tactics, ' +
        'and puzzle rush, live from the Chess.com API. These are official current values, not ' +
        'computed from synchronized games. Does not require a prior sync.',
      inputSchema: z.object({ username: users.input }),
      outputSchema: statsOutput,
      annotations: { title: 'Get Chess.com ratings', ...READ_ONLY_LIVE },
    },
    ({ username }) =>
      runTool(logger, 'get_player_stats', async () => {
        const result = await player.getStats(users.check(username));
        const stats = result.data;
        const data: z.infer<typeof statsOutput> = {
          username: result.username,
          source: SOURCE_CHESSCOM,
          generated_at: iso(new Date()),
          fetched_at: iso(result.fetchedAt),
          cache: result.cache,
          note: STATS_NOTE,
          ratings: stats.ratings.map((category) => {
            const record = category.record;
            const games = record ? record.wins + record.losses + record.draws : 0;
            return {
              category: category.category,
              rules: category.rules,
              time_class: category.timeClass,
              current_rating: category.current?.rating ?? null,
              current_rating_date: iso(category.current?.date ?? null),
              rating_deviation: category.current?.ratingDeviation ?? null,
              best_rating: category.best?.rating ?? null,
              best_rating_date: iso(category.best?.date ?? null),
              best_rating_game_url: category.best?.gameUrl ?? null,
              record: record
                ? {
                    games,
                    wins: record.wins,
                    losses: record.losses,
                    draws: record.draws,
                    win_rate: percentage(record.wins, games),
                    score_percentage: percentage(record.wins + 0.5 * record.draws, games),
                    time_per_move_seconds: record.timePerMoveSeconds,
                    timeout_percent: record.timeoutPercent,
                  }
                : null,
            };
          }),
          fide_rating: stats.fideRating,
          tactics: stats.tactics,
          puzzle_rush_best: stats.puzzleRushBest
            ? {
                score: stats.puzzleRushBest.score,
                total_attempts: stats.puzzleRushBest.totalAttempts,
              }
            : null,
          warnings: stats.warnings,
        };
        const current = stats.ratings
          .filter((category) => category.current && category.rules === 'chess')
          .map((category) => `${category.timeClass} ${category.current!.rating}`);
        return {
          summary:
            `Current Chess.com ratings for ${result.username}: ` +
            `${current.length > 0 ? current.join(', ') : 'none reported'}.`,
          data,
        };
      }),
  );
}
