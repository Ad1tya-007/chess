import { describe, expect, it } from 'vitest';

import {
  aggregateOpenings,
  aggregateOpponents,
  averageRating,
  breakdownByTermination,
  buildOpeningMoveTree,
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
    playerResultCode: 'win',
    termination: 'checkmated',
    playerColor: 'white',
    timeClass: 'blitz',
    eco: 'B12',
    openingName: 'Caro Kann Defense Advance Variation',
    playerRating: 1500,
    opponentUsername: 'opponent',
    opponentRating: 1500,
    sanMoves: ['e4', 'c6', 'd4', 'd5'],
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

describe('aggregateOpponents', () => {
  it('groups case-insensitively and keeps casing from the most recent game', () => {
    const games = [
      game({ opponentUsername: 'Hikaru', result: 'win', opponentRating: 2800 }),
      game({
        opponentUsername: 'hikaru',
        result: 'loss',
        playerColor: 'black',
        opponentRating: 2810,
      }),
      game({ opponentUsername: 'Magnus', result: 'draw', opponentRating: 2850 }),
      game({ opponentUsername: 'HIKARU', result: 'win', opponentRating: 2820 }),
    ];
    const { opponents } = aggregateOpponents(games);
    expect(opponents.map((row) => [row.opponentUsername, row.games])).toEqual([
      ['HIKARU', 3],
      ['Magnus', 1],
    ]);
    expect(opponents[0]).toMatchObject({
      wins: 2,
      losses: 1,
      draws: 0,
      winRate: 66.7,
      scorePercentage: 66.7,
      lowSample: true,
      averageOpponentRating: { value: 2810, gamesWithRating: 3 },
      byColor: {
        white: { games: 2, wins: 2 },
        black: { games: 1, losses: 1 },
      },
    });
  });

  it('drops groups below min games and flags low samples', () => {
    const games = [
      ...Array.from({ length: 4 }, () => game({ opponentUsername: 'frequent' })),
      game({ opponentUsername: 'once' }),
    ];
    const result = aggregateOpponents(games, 2);
    expect(result.opponents).toHaveLength(1);
    expect(result.groupsBelowMinGames).toBe(1);
    expect(result.gamesBelowMinGames).toBe(1);
    expect(result.opponents[0]!.lowSample).toBe(true);

    const many = Array.from({ length: LOW_SAMPLE_GAMES }, () =>
      game({ opponentUsername: 'frequent' }),
    );
    expect(aggregateOpponents(many).opponents[0]!.lowSample).toBe(false);
  });

  it('sorts by games, then score, then username', () => {
    const games = [
      game({ opponentUsername: 'b', result: 'win' }),
      game({ opponentUsername: 'a', result: 'win' }),
      game({ opponentUsername: 'a', result: 'loss' }),
      game({ opponentUsername: 'c', result: 'win' }),
      game({ opponentUsername: 'c', result: 'win' }),
    ];
    expect(aggregateOpponents(games).opponents.map((row) => row.opponentUsername)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

describe('buildOpeningMoveTree', () => {
  it('groups by SAN prefix and reports rates along each path', () => {
    const games = [
      game({ sanMoves: ['e4', 'e5', 'Nf3'], result: 'win' }),
      game({ sanMoves: ['e4', 'e5', 'Bc4'], result: 'loss' }),
      game({ sanMoves: ['e4', 'c5'], result: 'draw' }),
      game({ sanMoves: ['d4', 'd5'], result: 'win' }),
      game({ sanMoves: null, result: 'win' }),
    ];
    const tree = buildOpeningMoveTree(games, { maxPly: 3, minGames: 1, maxChildren: 8 });
    expect(tree.gamesWithMoves).toBe(4);
    expect(tree.gamesMissingMoves).toBe(1);
    expect(tree.root).toMatchObject({
      san: null,
      prefix: [],
      ply: 0,
      games: 4,
      wins: 2,
      losses: 1,
      draws: 1,
      winRate: 50,
      scorePercentage: 62.5,
      lowSample: true,
    });
    expect(tree.root.children.map((child) => child.san)).toEqual(['e4', 'd4']);
    const e4 = tree.root.children[0]!;
    expect(e4).toMatchObject({
      san: 'e4',
      prefix: ['e4'],
      ply: 1,
      games: 3,
      wins: 1,
      losses: 1,
      draws: 1,
      scorePercentage: 50,
    });
    expect(e4.children.map((child) => [child.san, child.games])).toEqual([
      ['e5', 2],
      ['c5', 1],
    ]);
    expect(e4.children[0]!.children.map((child) => child.san).sort()).toEqual(['Bc4', 'Nf3']);
  });

  it('drops rare branches and caps children per node', () => {
    const games = [
      ...Array.from({ length: 3 }, () => game({ sanMoves: ['e4', 'e5'], result: 'win' })),
      game({ sanMoves: ['e4', 'c5'], result: 'loss' }),
      game({ sanMoves: ['d4'], result: 'draw' }),
      game({ sanMoves: ['c4'], result: 'win' }),
      game({ sanMoves: ['Nf3'], result: 'win' }),
    ];
    const pruned = buildOpeningMoveTree(games, { maxPly: 2, minGames: 2, maxChildren: 8 });
    expect(pruned.root.children.map((child) => child.san)).toEqual(['e4']);
    expect(pruned.root.childrenOmitted).toBe(3);
    expect(pruned.root.children[0]!.children.map((child) => child.san)).toEqual(['e5']);
    expect(pruned.root.children[0]!.childrenOmitted).toBe(1);

    const capped = buildOpeningMoveTree(games, { maxPly: 1, minGames: 1, maxChildren: 2 });
    // e4 (4 games) then c4/Nf3 tied on score 100% — SAN order keeps c4 over Nf3.
    expect(capped.root.children.map((child) => child.san)).toEqual(['e4', 'c4']);
    expect(capped.root.childrenOmitted).toBe(2);
  });

  it('respects max_ply and treats empty move lists as root-only', () => {
    const tree = buildOpeningMoveTree(
      [
        game({ sanMoves: ['e4', 'e5', 'Nf3', 'Nc6'], result: 'win' }),
        game({ sanMoves: [], result: 'loss' }),
      ],
      { maxPly: 2, minGames: 1 },
    );
    expect(tree.root.games).toBe(2);
    expect(tree.root.children).toHaveLength(1);
    expect(tree.root.children[0]!.prefix).toEqual(['e4']);
    expect(tree.root.children[0]!.children[0]!.prefix).toEqual(['e4', 'e5']);
    expect(tree.root.children[0]!.children[0]!.children).toEqual([]);
  });

  it('returns an empty root when every game lacks san_moves', () => {
    const tree = buildOpeningMoveTree([game({ sanMoves: null }), game({ sanMoves: null })]);
    expect(tree).toMatchObject({
      gamesWithMoves: 0,
      gamesMissingMoves: 2,
      nodesReturned: 1,
      root: { games: 0, children: [], winRate: null, scorePercentage: null },
    });
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

describe('breakdownByTermination', () => {
  it('groups wins by opponent loss code and losses/draws by player code', () => {
    const games = [
      game({ result: 'win', playerResultCode: 'win', termination: 'checkmated' }),
      game({ result: 'win', playerResultCode: 'win', termination: 'resigned' }),
      game({ result: 'win', playerResultCode: 'win', termination: 'checkmated' }),
      game({ result: 'loss', playerResultCode: 'timeout', termination: 'timeout' }),
      game({ result: 'loss', playerResultCode: 'resigned', termination: 'resigned' }),
      game({ result: 'loss', playerResultCode: 'timeout', termination: 'timeout' }),
      game({ result: 'draw', playerResultCode: 'agreed', termination: 'agreed' }),
    ];

    expect(breakdownByTermination(games)).toEqual({
      totals: {
        games: 7,
        wins: 3,
        losses: 3,
        draws: 1,
        winRate: 42.9,
        scorePercentage: 50,
      },
      wins: [
        { code: 'checkmated', games: 2, percentage: 66.7 },
        { code: 'resigned', games: 1, percentage: 33.3 },
      ],
      losses: [
        { code: 'timeout', games: 2, percentage: 66.7 },
        { code: 'resigned', games: 1, percentage: 33.3 },
      ],
      draws: [{ code: 'agreed', games: 1, percentage: 100 }],
      missingTermination: 0,
    });
  });

  it('counts null terminations honestly and still includes them in totals', () => {
    const games = [
      game({ result: 'win', playerResultCode: 'win', termination: 'checkmated' }),
      game({ result: 'win', playerResultCode: null, termination: null }),
      game({ result: 'loss', playerResultCode: null, termination: null }),
    ];

    const breakdown = breakdownByTermination(games);
    expect(breakdown.totals).toMatchObject({ games: 3, wins: 2, losses: 1, draws: 0 });
    expect(breakdown.wins).toEqual([{ code: 'checkmated', games: 1, percentage: 50 }]);
    expect(breakdown.losses).toEqual([]);
    expect(breakdown.missingTermination).toBe(2);
  });

  it('returns empty buckets for an empty dataset', () => {
    expect(breakdownByTermination([])).toEqual({
      totals: {
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        winRate: null,
        scorePercentage: null,
      },
      wins: [],
      losses: [],
      draws: [],
      missingTermination: 0,
    });
  });
});
