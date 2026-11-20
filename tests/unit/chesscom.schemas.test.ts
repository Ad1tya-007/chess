import { describe, expect, it } from 'vitest';

import {
  archiveGamesSchema,
  archiveListSchema,
  parseArchiveUrl,
  profileSchema,
  statsSchema,
} from '../../src/clients/chesscom.schemas.js';
import { fixture } from '../helpers/fake-fetch.js';

describe('profileSchema', () => {
  it('normalizes a full profile', () => {
    expect(profileSchema.parse(fixture('profile.json'))).toEqual({
      username: 'testplayer',
      playerId: 123456,
      name: 'Test Player',
      title: 'FM',
      status: 'premium',
      countryCode: 'US',
      location: 'Somewhere',
      profileUrl: 'https://www.chess.com/member/TestPlayer',
      joinedAt: new Date(1178556600 * 1000),
      lastOnlineAt: new Date(1795038203 * 1000),
      followers: 42,
      fideRating: null,
      isStreamer: false,
      league: 'Silver',
    });
  });

  it('returns null for absent optional fields instead of fabricating them', () => {
    const profile = profileSchema.parse({ username: 'minimal' });
    expect(profile).toMatchObject({
      username: 'minimal',
      name: null,
      title: null,
      countryCode: null,
      joinedAt: null,
      profileUrl: null,
    });
  });

  it('degrades malformed optional fields to null', () => {
    const profile = profileSchema.parse({
      username: 'odd',
      joined: 'last year',
      followers: -5,
      title: { nested: true },
      url: 'https://evil.example.com/member/odd',
      country: 'https://api.chess.com/pub/country/../../x',
    });
    expect(profile).toMatchObject({
      joinedAt: null,
      followers: null,
      title: null,
      profileUrl: null,
      countryCode: null,
    });
  });

  it('requires a username', () => {
    expect(profileSchema.safeParse({ name: 'No Username' }).success).toBe(false);
  });
});

describe('statsSchema', () => {
  const stats = statsSchema.parse(fixture('stats.json'));

  it('includes only rating categories present in the response, sorted', () => {
    expect(stats.ratings.map((rating) => rating.category)).toEqual([
      'chess_blitz',
      'chess_rapid',
      'chess960_daily',
    ]);
  });

  it('separates current rating, best rating and record', () => {
    const rapid = stats.ratings.find((rating) => rating.category === 'chess_rapid');
    expect(rapid).toEqual({
      category: 'chess_rapid',
      rules: 'chess',
      timeClass: 'rapid',
      current: { rating: 1642, date: new Date(1795000000 * 1000), ratingDeviation: 58 },
      best: {
        rating: 1710,
        date: new Date(1780000000 * 1000),
        gameUrl: 'https://www.chess.com/game/live/111',
      },
      record: { wins: 177, losses: 124, draws: 21, timePerMoveSeconds: null, timeoutPercent: null },
    });
  });

  it('keeps a category whose best block is absent', () => {
    const blitz = stats.ratings.find((rating) => rating.category === 'chess_blitz');
    expect(blitz?.best).toBeNull();
    expect(blitz?.current?.rating).toBe(1500);
  });

  it('reports malformed categories as warnings instead of failing', () => {
    expect(stats.ratings.some((rating) => rating.category === 'chess_bullet')).toBe(false);
    expect(stats.warnings).toEqual([
      'Ignored malformed "last" data in stats category "chess_bullet".',
      'Ignored stats category "chess_bullet" with no usable data.',
    ]);
  });

  it('keeps the valid parts of a category when one block is malformed', () => {
    const parsed = statsSchema.parse({
      chess_rapid: { last: { rating: 1500 }, best: 'oops', record: { win: 1, loss: 0, draw: 0 } },
      chess_blitz: [],
    });
    expect(parsed.ratings).toHaveLength(1);
    expect(parsed.ratings[0]).toMatchObject({
      current: { rating: 1500 },
      best: null,
      record: { wins: 1 },
    });
    expect(parsed.warnings).toEqual([
      'Ignored malformed "best" data in stats category "chess_rapid".',
      'Ignored malformed stats category "chess_blitz".',
    ]);
  });

  it('extracts FIDE, tactics and puzzle rush when present', () => {
    expect(stats.fideRating).toBe(1900);
    expect(stats.tactics).toEqual({ highest: 2730, lowest: 400 });
    expect(stats.puzzleRushBest).toEqual({ score: 28, totalAttempts: 30 });
  });

  it('handles a player with no stats at all', () => {
    expect(statsSchema.parse({})).toEqual({
      ratings: [],
      fideRating: null,
      tactics: null,
      puzzleRushBest: null,
      warnings: [],
    });
  });
});

describe('archive list parsing', () => {
  it('keeps only valid archives for the requested player, ascending and de-duplicated', () => {
    expect(archiveListSchema('testplayer').parse(fixture('archives.json'))).toEqual({
      archives: [
        { year: 2025, month: 12 },
        { year: 2026, month: 10 },
        { year: 2026, month: 11 },
      ],
      ignoredEntries: 4,
    });
  });

  it.each([
    ['https://api.chess.com/pub/player/TestPlayer/games/2024/02', { year: 2024, month: 2 }],
    ['https://api.chess.com/pub/player/testplayer/games/2024/2', null],
    ['https://api.chess.com/pub/player/testplayer/games/2024/02/pgn', null],
    ['http://api.chess.com/pub/player/testplayer/games/2024/02', null],
    ['https://api.chess.com/pub/player/other/games/2024/02', null],
    ['https://api.chess.com/pub/player/testplayer/games/1999/02', null],
  ])('parseArchiveUrl(%j)', (url, expected) => {
    expect(parseArchiveUrl(url, 'testplayer')).toEqual(expected);
  });

  it('rejects a body without an archives array', () => {
    expect(archiveListSchema('testplayer').safeParse({ archive: [] }).success).toBe(false);
  });
});

describe('archiveGamesSchema', () => {
  const { games, skipped } = archiveGamesSchema.parse(fixture('archive-games.json'));

  it('returns well-formed games in order and skips malformed entries without failing the archive', () => {
    expect(games.map((game) => game.url)).toEqual([
      'https://www.chess.com/game/live/1001',
      'https://www.chess.com/game/daily/1002',
      'https://www.chess.com/game/live/1005',
    ]);
    expect(skipped.map(({ index, url }) => ({ index, url }))).toEqual([
      { index: 2, url: null },
      { index: 3, url: 'https://www.chess.com/game/live/1004' },
    ]);
    expect(skipped[1]!.reason).toContain('end_time');
  });

  it('maps a complete game', () => {
    expect(games[0]).toMatchObject({
      url: 'https://www.chess.com/game/live/1001',
      uuid: '00000000-0000-0000-0000-000000001001',
      timeControl: '600',
      timeClass: 'rapid',
      rules: 'chess',
      rated: true,
      startTime: null,
      endTime: new Date(1793540394 * 1000),
      ecoUrl: 'https://www.chess.com/openings/Caro-Kann-Defense-Advance-Variation',
      white: { username: 'TestPlayer', rating: 1640, resultCode: 'win' },
      black: { username: 'opponent1', rating: 1620, resultCode: 'checkmated' },
    });
    expect(games[0]!.pgn).toContain('[ECO "B12"]');
  });

  it('keeps games with missing ratings, ECO and time class as nulls', () => {
    expect(games[1]).toMatchObject({
      rated: false,
      startTime: new Date(1793000000 * 1000),
      ecoUrl: null,
      white: { username: 'opponent2', rating: null, resultCode: 'agreed', uuid: null },
      black: { username: 'testplayer', rating: null, resultCode: 'agreed' },
    });
  });

  it('nulls out malformed optional fields such as rated, rating and off-site ECO links', () => {
    expect(games[2]).toMatchObject({
      rated: null,
      ecoUrl: null,
      black: { username: 'TESTPLAYER', rating: null, resultCode: 'win' },
    });
  });

  it('accepts an empty month', () => {
    expect(archiveGamesSchema.parse({ games: [] })).toEqual({ games: [], skipped: [] });
  });
});
