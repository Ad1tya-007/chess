import type {
  AnalyticsGame,
  OpeningStat,
  OpponentStat,
  RatingAverage,
  RatingTrend,
  ResultSummary,
  Streak,
  StreakSummary,
} from './analytics.types.js';

/** Openings (or other groups) with fewer games than this are flagged as low-sample. */
export const LOW_SAMPLE_GAMES = 10;

/** Percentages are rounded to one decimal place. */
export function percentage(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * - Win rate: wins / games * 100. Draws and losses are not wins.
 * - Score percentage: (wins + 0.5 * draws) / games * 100.
 * Both are null (not 0) when there are no games.
 */
export function summarizeResults(games: readonly Pick<AnalyticsGame, 'result'>[]): ResultSummary {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (const game of games) {
    if (game.result === 'win') wins += 1;
    else if (game.result === 'loss') losses += 1;
    else draws += 1;
  }
  const total = games.length;
  return {
    games: total,
    wins,
    losses,
    draws,
    winRate: percentage(wins, total),
    scorePercentage: percentage(wins + 0.5 * draws, total),
  };
}

/** Arithmetic mean of the non-null values, rounded to an integer. */
export function averageRating(values: readonly (number | null)[]): RatingAverage {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return { value: null, gamesWithRating: 0 };
  const sum = present.reduce((total, value) => total + value, 0);
  return { value: Math.round(sum / present.length), gamesWithRating: present.length };
}

/**
 * Streaks are consecutive wins (or losses) in chronological order within the given, already
 * filtered games. A draw ends both a win streak and a loss streak. When two streaks tie for
 * longest, the more recent one is reported. Input must be sorted by playedAt ascending.
 */
export function computeStreaks(
  games: readonly Pick<AnalyticsGame, 'playedAt' | 'result'>[],
): StreakSummary {
  let longestWin: Streak | null = null;
  let longestLoss: Streak | null = null;
  let runType: 'win' | 'loss' | null = null;
  let runLength = 0;
  let runStart: Date | null = null;

  for (const game of games) {
    if (game.result === 'draw') {
      runType = null;
      runLength = 0;
      continue;
    }
    if (game.result === runType) {
      runLength += 1;
    } else {
      runType = game.result;
      runLength = 1;
      runStart = game.playedAt;
    }
    const streak: Streak = { length: runLength, from: runStart!, to: game.playedAt };
    if (runType === 'win' && runLength >= (longestWin?.length ?? 0)) longestWin = streak;
    if (runType === 'loss' && runLength >= (longestLoss?.length ?? 0)) longestLoss = streak;
  }

  return {
    longestWinStreak: longestWin,
    longestLossStreak: longestLoss,
    current: { type: runType, length: runLength },
  };
}

/**
 * Groups games by (ECO, opening name). Distinct ECO codes are never merged, even when names are
 * similar. Games with neither ECO nor name form one "unknown" group. Sorted by games played
 * (descending), then score percentage, then name (unknown last), then ECO. Groups below
 * `minGames` are dropped.
 */
export function aggregateOpenings(
  games: readonly AnalyticsGame[],
  minGames = 1,
): { openings: OpeningStat[]; groupsBelowMinGames: number; gamesBelowMinGames: number } {
  const groups = new Map<string, AnalyticsGame[]>();
  for (const game of games) {
    const key = `${game.eco ?? ''}\u0000${game.openingName ?? ''}`;
    const group = groups.get(key);
    if (group) group.push(game);
    else groups.set(key, [game]);
  }

  const openings: OpeningStat[] = [];
  let groupsBelowMinGames = 0;
  let gamesBelowMinGames = 0;
  for (const group of groups.values()) {
    if (group.length < minGames) {
      groupsBelowMinGames += 1;
      gamesBelowMinGames += group.length;
      continue;
    }
    const times = minMax(group.map((game) => game.playedAt.getTime()))!;
    openings.push({
      eco: group[0]!.eco,
      openingName: group[0]!.openingName,
      ...summarizeResults(group),
      lowSample: group.length < LOW_SAMPLE_GAMES,
      firstPlayedAt: new Date(times.min),
      lastPlayedAt: new Date(times.max),
    });
  }

  openings.sort(
    (a, b) =>
      b.games - a.games ||
      (b.scorePercentage ?? 0) - (a.scorePercentage ?? 0) ||
      Number(a.openingName === null) - Number(b.openingName === null) ||
      (a.openingName ?? '').localeCompare(b.openingName ?? '') ||
      (a.eco ?? '').localeCompare(b.eco ?? ''),
  );
  return { openings, groupsBelowMinGames, gamesBelowMinGames };
}

/**
 * Groups games by opponent username (case-insensitive). Display casing comes from the most recent
 * game in each group. Sorted by games played (descending), then score percentage, then username.
 * Groups below `minGames` are dropped.
 */
export function aggregateOpponents(
  games: readonly AnalyticsGame[],
  minGames = 1,
): { opponents: OpponentStat[]; groupsBelowMinGames: number; gamesBelowMinGames: number } {
  const groups = new Map<string, AnalyticsGame[]>();
  for (const game of games) {
    const key = game.opponentUsername.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(game);
    else groups.set(key, [game]);
  }

  const opponents: OpponentStat[] = [];
  let groupsBelowMinGames = 0;
  let gamesBelowMinGames = 0;
  for (const group of groups.values()) {
    if (group.length < minGames) {
      groupsBelowMinGames += 1;
      gamesBelowMinGames += group.length;
      continue;
    }
    const times = minMax(group.map((game) => game.playedAt.getTime()))!;
    // Most recent game's casing (input is chronological ascending).
    const displayUsername = group.at(-1)!.opponentUsername;
    opponents.push({
      opponentUsername: displayUsername,
      ...summarizeResults(group),
      lowSample: group.length < LOW_SAMPLE_GAMES,
      firstPlayedAt: new Date(times.min),
      lastPlayedAt: new Date(times.max),
      averageOpponentRating: averageRating(group.map((game) => game.opponentRating)),
      byColor: {
        white: summarizeResults(group.filter((game) => game.playerColor === 'white')),
        black: summarizeResults(group.filter((game) => game.playerColor === 'black')),
      },
    });
  }

  opponents.sort(
    (a, b) =>
      b.games - a.games ||
      (b.scorePercentage ?? 0) - (a.scorePercentage ?? 0) ||
      a.opponentUsername.toLowerCase().localeCompare(b.opponentUsername.toLowerCase()),
  );
  return { opponents, groupsBelowMinGames, gamesBelowMinGames };
}

/**
 * Rating trend per time class from the player's recorded rating in each game, in chronological
 * order: change = rating in the last rated game - rating in the first rated game. This samples
 * the synchronized archive games; it is not an official rating history. Input must be sorted by
 * playedAt ascending.
 */
export function ratingTrends(games: readonly AnalyticsGame[]): RatingTrend[] {
  const byTimeClass = new Map<string | null, AnalyticsGame[]>();
  for (const game of games) {
    const group = byTimeClass.get(game.timeClass);
    if (group) group.push(game);
    else byTimeClass.set(game.timeClass, [game]);
  }

  const trends: RatingTrend[] = [];
  for (const [timeClass, group] of byTimeClass) {
    const rated = group.filter((game) => game.playerRating !== null);
    const range = minMax(rated.map((game) => game.playerRating!));
    const first = rated[0];
    const last = rated.at(-1);
    trends.push({
      timeClass,
      gamesWithRating: rated.length,
      firstRating: first?.playerRating ?? null,
      lastRating: last?.playerRating ?? null,
      change: first && last ? last.playerRating! - first.playerRating! : null,
      minRating: range?.min ?? null,
      maxRating: range?.max ?? null,
      firstGameAt: first?.playedAt ?? null,
      lastGameAt: last?.playedAt ?? null,
    });
  }
  return trends.sort((a, b) => b.gamesWithRating - a.gamesWithRating);
}

/** Avoids Math.min(...values), which overflows the call stack for very large arrays. */
function minMax(values: readonly number[]): { min: number; max: number } | null {
  if (values.length === 0) return null;
  let min = values[0]!;
  let max = values[0]!;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}
