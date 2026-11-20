import { describe, expect, it } from 'vitest';

import {
  aggregateOpenings,
  averageRating,
  computeStreaks,
  LOW_SAMPLE_GAMES,
  percentage,
  ratingTrends,
  summarizeResults,
} from '../../src/domain/analytics.js';
import type { AnalyticsGame } from '../../src/domain/analytics.types.js';
import type { GameResult } from '../../src/domain/game.types.js';

let day = 0;
function game(overrides: Partial<AnalyticsGame> = {}): AnalyticsGame {
  day += 1;
  return {
    playedAt: new Date(Date.UTC(2026, 0, 1) + day * 86_400_000),
    result: 'win',
    playerColor: 'white',
    timeClass: 'blitz',
    eco: 'B12',
    openingName: 'Caro Kann Defense Advance Variation',
    playerRating: 1500,
    opponentRating: 1500,
    ...overrides,
  };
}

const sequence = (results: string) =>
  [...results].map((code) =>
    game({ result: ({ W: 'win', L: 'loss', D: 'draw' } as const)[code as 'W' | 'L' | 'D'] }),
  );

describe('percentage', () => {
  it('rounds to one decimal', () => {
    expect(percentage(1, 3)).toBe(33.3);
    expect(percentage(2, 3)).toBe(66.7);
    expect(percentage(5, 5)).toBe(100);
  });

  it('returns null, not 0, when the denominator is zero', () => {
    expect(percentage(0, 0)).toBeNull();
  });
});

describe('summarizeResults', () => {
  it('computes win rate and score percentage', () => {
    // 3 wins, 1 loss, 2 draws: win rate 3/6 = 50%, score (3 + 1) / 6 = 66.7%
    expect(summarizeResults(sequence('WWWLDD'))).toEqual({
      games: 6,
      wins: 3,
      losses: 1,
      draws: 2,
      winRate: 50,
      scorePercentage: 66.7,
    });
  });

  it('does not count draws as wins', () => {
    expect(summarizeResults(sequence('DDDD'))).toMatchObject({ winRate: 0, scorePercentage: 50 });
  });

  it('returns nulls for an empty dataset', () => {
    expect(summarizeResults([])).toEqual({
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      winRate: null,
      scorePercentage: null,
    });
  });
});

describe('averageRating', () => {
  it('averages only non-null ratings and reports the denominator', () => {
    expect(averageRating([1500, null, 1600, null, 1700])).toEqual({
      value: 1600,
      gamesWithRating: 3,
    });
  });

  it('rounds to an integer', () => {
    expect(averageRating([1500, 1501])).toEqual({ value: 1501, gamesWithRating: 2 });
  });

  it('returns null when no game has a rating', () => {
    expect(averageRating([null, null])).toEqual({ value: null, gamesWithRating: 0 });
    expect(averageRating([])).toEqual({ value: null, gamesWithRating: 0 });
  });
});

describe('computeStreaks', () => {
  it('finds the longest win and loss streaks in chronological order', () => {
    const games = sequence('WWLLLWWWWDL');
    const streaks = computeStreaks(games);
    expect(streaks.longestWinStreak).toEqual({
      length: 4,
      from: games[5]!.playedAt,
      to: games[8]!.playedAt,
    });
    expect(streaks.longestLossStreak).toEqual({
      length: 3,
      from: games[2]!.playedAt,
      to: games[4]!.playedAt,
    });
    expect(streaks.current).toEqual({ type: 'loss', length: 1 });
  });

  it('lets draws break streaks', () => {
    const streaks = computeStreaks(sequence('WWDWW'));
    expect(streaks.longestWinStreak?.length).toBe(2);
  });

  it('reports the most recent streak on ties', () => {
    const games = sequence('WWLWW');
    expect(computeStreaks(games).longestWinStreak?.from).toEqual(games[3]!.playedAt);
  });

  it('reports no current streak after a draw and nulls for missing streak types', () => {
    const streaks = computeStreaks(sequence('WWD'));
    expect(streaks.current).toEqual({ type: null, length: 0 });
    expect(streaks.longestLossStreak).toBeNull();
  });

  it('handles an empty dataset', () => {
    expect(computeStreaks([])).toEqual({
      longestWinStreak: null,
      longestLossStreak: null,
      current: { type: null, length: 0 },
    });
  });
});

describe('aggregateOpenings', () => {
  const games = [
    ...Array.from({ length: 4 }, (_, i) =>
      game({ result: (['win', 'win', 'loss', 'draw'] as GameResult[])[i]! }),
    ),
    // Same display name but a different ECO code: must not be merged.
    game({ eco: 'B13' }),
    game({ eco: 'C50', openingName: 'Italian Game' }),
    game({ eco: 'C50', openingName: 'Italian Game', result: 'loss' }),
    game({ eco: null, openingName: null }),
  ];

  it('groups by ECO plus opening name without merging distinct ECO codes', () => {
    const { openings } = aggregateOpenings(games);
    expect(openings.map((opening) => [opening.eco, opening.openingName, opening.games])).toEqual([
      ['B12', 'Caro Kann Defense Advance Variation', 4],
      ['C50', 'Italian Game', 2],
      ['B13', 'Caro Kann Defense Advance Variation', 1],
      [null, null, 1],
    ]);
  });

  it('computes per-opening rates and flags low samples', () => {
    const [caroKann] = aggregateOpenings(games).openings;
    expect(caroKann).toMatchObject({
      wins: 2,
      losses: 1,
      draws: 1,
      winRate: 50,
      scorePercentage: 62.5,
      lowSample: true,
    });
    expect(caroKann!.firstPlayedAt.getTime()).toBeLessThan(caroKann!.lastPlayedAt.getTime());

    const many = Array.from({ length: LOW_SAMPLE_GAMES }, () => game());
    expect(aggregateOpenings(many).openings[0]!.lowSample).toBe(false);
  });

  it('drops groups below min games and counts what was dropped', () => {
    const result = aggregateOpenings(games, 2);
    expect(result.openings).toHaveLength(2);
    expect(result.groupsBelowMinGames).toBe(2);
    expect(result.gamesBelowMinGames).toBe(2);
  });

  it('handles large datasets without exceeding the call stack', () => {
    const large = Array.from({ length: 200_000 }, () => game());
    expect(aggregateOpenings(large).openings[0]!.games).toBe(200_000);
  });
});

describe('ratingTrends', () => {
  it('uses the first and last recorded rating per time class, skipping unrated games', () => {
    const trends = ratingTrends([
      game({ timeClass: 'blitz', playerRating: 1500 }),
      game({ timeClass: 'rapid', playerRating: 1800 }),
      game({ timeClass: 'blitz', playerRating: null }),
      game({ timeClass: 'blitz', playerRating: 1450 }),
      game({ timeClass: 'blitz', playerRating: 1560 }),
    ]);
    expect(trends[0]).toMatchObject({
      timeClass: 'blitz',
      gamesWithRating: 3,
      firstRating: 1500,
      lastRating: 1560,
      change: 60,
      minRating: 1450,
      maxRating: 1560,
    });
    expect(trends[1]).toMatchObject({ timeClass: 'rapid', change: 0, gamesWithRating: 1 });
  });

  it('returns null values when a time class has no rated games', () => {
    expect(ratingTrends([game({ playerRating: null })])[0]).toMatchObject({
      gamesWithRating: 0,
      firstRating: null,
      change: null,
      minRating: null,
    });
  });
});
