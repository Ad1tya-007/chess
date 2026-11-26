import type {
  AnalyticsGame,
  OpeningMoveTree,
  OpeningMoveTreeNode,
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

/** Default / hard caps for opening move-tree cardinality control. */
export const DEFAULT_MOVE_TREE_MAX_PLY = 6;
export const MAX_MOVE_TREE_MAX_PLY = 12;
/** Per-node children returned after sorting by popularity (then score). */
export const DEFAULT_MOVE_TREE_MAX_CHILDREN = 8;
export const MAX_MOVE_TREE_MAX_CHILDREN = 20;

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

/**
 * Builds a repertoire-style prefix tree from validated SAN move lists. Each path is the absolute
 * game move order (not reoriented by color). Games with null `sanMoves` are excluded from the
 * tree and counted in `gamesMissingMoves`. Nodes below `minGames` are dropped (except the root).
 * Each node keeps at most `maxChildren` children, sorted by games (desc), then score, then SAN.
 */
export function buildOpeningMoveTree(
  games: readonly AnalyticsGame[],
  options: {
    maxPly?: number | undefined;
    minGames?: number | undefined;
    maxChildren?: number | undefined;
  } = {},
): OpeningMoveTree {
  const maxPly = options.maxPly ?? DEFAULT_MOVE_TREE_MAX_PLY;
  const minGames = options.minGames ?? 1;
  const maxChildren = options.maxChildren ?? DEFAULT_MOVE_TREE_MAX_CHILDREN;

  const root = emptyBucket();
  let gamesWithMoves = 0;
  let gamesMissingMoves = 0;

  for (const game of games) {
    if (game.sanMoves === null) {
      gamesMissingMoves += 1;
      continue;
    }
    gamesWithMoves += 1;
    recordResult(root, game.result);
    let bucket = root;
    const limit = Math.min(maxPly, game.sanMoves.length);
    for (let i = 0; i < limit; i += 1) {
      const san = game.sanMoves[i]!;
      let child = bucket.children.get(san);
      if (!child) {
        child = emptyBucket();
        bucket.children.set(san, child);
      }
      recordResult(child, game.result);
      bucket = child;
    }
  }

  let nodesReturned = 0;
  const materialize = (
    bucket: MoveBucket,
    san: string | null,
    prefix: string[],
    ply: number,
  ): OpeningMoveTreeNode => {
    nodesReturned += 1;
    const summary = summarizeBucket(bucket);
    const eligible: { san: string; bucket: MoveBucket }[] = [];
    let belowMinGames = 0;
    for (const [childSan, childBucket] of bucket.children) {
      if (childBucket.games < minGames) {
        belowMinGames += 1;
        continue;
      }
      eligible.push({ san: childSan, bucket: childBucket });
    }
    eligible.sort(
      (a, b) =>
        b.bucket.games - a.bucket.games ||
        scoreOf(b.bucket) - scoreOf(a.bucket) ||
        a.san.localeCompare(b.san),
    );
    const kept = eligible.slice(0, maxChildren);
    const childrenOmitted = belowMinGames + (eligible.length - kept.length);
    return {
      san,
      prefix,
      ply,
      ...summary,
      lowSample: summary.games < LOW_SAMPLE_GAMES,
      children: kept.map((entry) =>
        materialize(entry.bucket, entry.san, [...prefix, entry.san], ply + 1),
      ),
      childrenOmitted,
    };
  };

  return {
    root: materialize(root, null, [], 0),
    gamesWithMoves,
    gamesMissingMoves,
    nodesReturned,
  };
}

interface MoveBucket {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  children: Map<string, MoveBucket>;
}

function emptyBucket(): MoveBucket {
  return { games: 0, wins: 0, losses: 0, draws: 0, children: new Map() };
}

function recordResult(bucket: MoveBucket, result: AnalyticsGame['result']): void {
  bucket.games += 1;
  if (result === 'win') bucket.wins += 1;
  else if (result === 'loss') bucket.losses += 1;
  else bucket.draws += 1;
}

function summarizeBucket(bucket: MoveBucket): ResultSummary {
  return {
    games: bucket.games,
    wins: bucket.wins,
    losses: bucket.losses,
    draws: bucket.draws,
    winRate: percentage(bucket.wins, bucket.games),
    scorePercentage: percentage(bucket.wins + 0.5 * bucket.draws, bucket.games),
  };
}

function scoreOf(bucket: MoveBucket): number {
  if (bucket.games <= 0) return 0;
  return (bucket.wins + 0.5 * bucket.draws) / bucket.games;
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
