import { describe, expect, it } from 'vitest';

import {
  detectPlayerColor,
  mapPgnResult,
  mapResultCode,
  normalizeArchiveGame,
  normalizeArchiveGames,
  normalizeEco,
  normalizeTimeClass,
  normalizeTimeControl,
  openingNameFromUrl,
  type NormalizeOutcome,
} from '../../src/domain/game-normalizer.js';
import { archiveGame, buildPgn, fixtures, PLAYER } from '../fixtures/games.js';

function expectOk(outcome: NormalizeOutcome) {
  if (!outcome.ok) throw new Error(`Expected ok, got: ${outcome.reason}`);
  return outcome;
}

function expectRejected(outcome: NormalizeOutcome): string {
  if (outcome.ok) throw new Error('Expected the game to be rejected');
  return outcome.reason;
}

describe('mapResultCode', () => {
  it.each(['win', 'WIN', ' win '])('maps %j to win', (code) => {
    expect(mapResultCode(code)).toBe('win');
  });

  it.each([
    'checkmated',
    'resigned',
    'timeout',
    'lose',
    'abandoned',
    'kingofthehill',
    'threecheck',
    'bughousepartnerlose',
  ])('maps %j to loss', (code) => {
    expect(mapResultCode(code)).toBe('loss');
  });

  it.each(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'])(
    'maps %j to draw',
    (code) => {
      expect(mapResultCode(code)).toBe('draw');
    },
  );

  it.each(['', 'unknown', 'drawn', 'draw'])('does not guess for %j', (code) => {
    expect(mapResultCode(code)).toBeNull();
  });
});

describe('mapPgnResult', () => {
  it.each([
    ['1-0', 'white', 'win'],
    ['1-0', 'black', 'loss'],
    ['0-1', 'white', 'loss'],
    ['0-1', 'black', 'win'],
    ['1/2-1/2', 'white', 'draw'],
    ['1/2-1/2', 'black', 'draw'],
    ['*', 'white', null],
    [undefined, 'black', null],
  ] as const)('%j as %s -> %j', (result, color, expected) => {
    expect(mapPgnResult(result, color)).toBe(expected);
  });
});

describe('detectPlayerColor', () => {
  const players = (white: string, black: string) => ({
    white: { username: white, rating: null, resultCode: 'win', uuid: null },
    black: { username: black, rating: null, resultCode: 'resigned', uuid: null },
  });

  it('matches usernames case-insensitively', () => {
    expect(detectPlayerColor(players('TestPlayer', 'x'), 'testplayer')).toBe('white');
    expect(detectPlayerColor(players('x', 'TESTPLAYER'), 'TestPlayer')).toBe('black');
  });

  it('returns null when the player is not in the game', () => {
    expect(detectPlayerColor(players('a', 'b'), 'testplayer')).toBeNull();
  });

  it('returns null when both sides match (cannot attribute)', () => {
    expect(detectPlayerColor(players('same', 'SAME'), 'same')).toBeNull();
  });
});

describe('field normalization', () => {
  it.each([
    ['rapid', 'rapid'],
    [' Blitz ', 'blitz'],
    ['bullet', 'bullet'],
    ['daily', 'daily'],
    ['standard', null],
    [null, null],
  ])('normalizeTimeClass(%j) = %j', (input, expected) => {
    expect(normalizeTimeClass(input)).toBe(expected);
  });

  it.each([
    ['600', '600'],
    ['180+2', '180+2'],
    ['1/259200', '1/259200'],
    [' 60 ', '60'],
    ['-', null],
    ['10 min', null],
    ['1/2/3', null],
    [undefined, null],
  ])('normalizeTimeControl(%j) = %j', (input, expected) => {
    expect(normalizeTimeControl(input)).toBe(expected);
  });

  it.each([
    ['B12', 'B12'],
    ['b12', 'B12'],
    ['F00', null],
    ['B1', null],
    ['?', null],
    [undefined, null],
  ])('normalizeEco(%j) = %j', (input, expected) => {
    expect(normalizeEco(input)).toBe(expected);
  });

  it.each([
    [
      'https://www.chess.com/openings/Four-Knights-Game-Glek-Variation-4...Bb4-5.Bg2',
      'Four Knights Game Glek Variation',
    ],
    [
      'https://www.chess.com/openings/Kings-Gambit-Accepted-Modern-Defense-4.exd5',
      'Kings Gambit Accepted Modern Defense',
    ],
    ['https://www.chess.com/openings/Caro-Kann-Defense', 'Caro Kann Defense'],
    [
      'https://www.chess.com/openings/Sicilian-Defense-Kan-Knight-Variation...7.O-O-Bc5-8.Nb3-Ba7',
      'Sicilian Defense Kan Knight Variation',
    ],
    ['https://www.chess.com/openings/Pirc-Defense...4.c3-Bg7-5.Nf3-O-O', 'Pirc Defense'],
    ['https://www.chess.com/openings/Trompowsky-Attack-2...d5-3.Nd2-Nbd7', 'Trompowsky Attack'],
    ['https://www.chess.com/openings/Sicilian-Defense-2.Nf3-d6-3.Nc3-a6-4.g3', 'Sicilian Defense'],
    ['https://www.chess.com/openings/Sicilian-Defense%3F', null],
    ['https://www.chess.com/openings/%E0%A4%A', null],
    ['https://www.chess.com/openings/1.e4', null],
    ['https://evil.example.com/openings/Caro-Kann-Defense', null],
    [null, null],
  ])('openingNameFromUrl(%j) = %j', (input, expected) => {
    expect(openingNameFromUrl(input)).toBe(expected);
  });
});

describe('normalizeArchiveGame', () => {
  it('normalizes a White win from the player perspective', () => {
    const { game, warnings } = expectOk(normalizeArchiveGame(fixtures.whiteWin(), PLAYER));
    expect(warnings).toEqual([]);
    expect(game).toMatchObject({
      result: 'win',
      playerColor: 'white',
      opponentUsername: 'opponent',
      opponentRating: 1620,
      whiteRating: 1640,
      blackRating: 1620,
      timeClass: 'rapid',
      timeControl: '600',
      rated: true,
      eco: 'B12',
      openingName: 'Caro Kann Defense Advance Variation',
      playedAt: new Date('2026-11-01T12:00:00Z'),
      sanMoves: ['e4', 'c6', 'd4', 'd5', 'e5', 'Bf5'],
    });
  });

  it('normalizes a game won as Black, matching the username case-insensitively', () => {
    const { game } = expectOk(normalizeArchiveGame(fixtures.blackWin(), 'TESTPLAYER'));
    expect(game).toMatchObject({
      result: 'win',
      playerColor: 'black',
      opponentUsername: 'opponent',
      opponentRating: 1500,
      timeClass: 'blitz',
      timeControl: '180+2',
      eco: 'A00',
      sanMoves: ['f3', 'e5', 'g4', 'Qh4#'],
    });
  });

  it('records a loss for the configured player when the opponent won', () => {
    const { game } = expectOk(normalizeArchiveGame(fixtures.missingEcoAndOpening(), PLAYER));
    expect(game).toMatchObject({ result: 'loss', playerColor: 'black', opponentRating: 1700 });
  });

  it('normalizes a draw', () => {
    const { game } = expectOk(normalizeArchiveGame(fixtures.draw(), PLAYER));
    expect(game).toMatchObject({ result: 'draw', timeClass: 'bullet', eco: 'D00' });
  });

  it('keeps missing ratings and rated status as null', () => {
    const { game } = expectOk(normalizeArchiveGame(fixtures.missingRatings(), PLAYER));
    expect(game).toMatchObject({
      whiteRating: null,
      blackRating: null,
      opponentRating: null,
      rated: null,
      timeClass: 'daily',
      timeControl: '1/259200',
    });
  });

  it('falls back to PGN Elo tags when the JSON omits ratings', () => {
    const game = archiveGame({
      white: { username: PLAYER, rating: null, resultCode: 'win', uuid: null },
      black: { username: 'opponent', rating: null, resultCode: 'resigned', uuid: null },
    });
    expect(expectOk(normalizeArchiveGame(game, PLAYER)).game).toMatchObject({
      whiteRating: 1640,
      blackRating: 1620,
      opponentRating: 1620,
    });
  });

  it('keeps missing ECO and opening as null', () => {
    const { game } = expectOk(normalizeArchiveGame(fixtures.missingEcoAndOpening(), PLAYER));
    expect(game.eco).toBeNull();
    expect(game.openingName).toBeNull();
  });

  it('stores a game with a malformed PGN, without moves, and warns', () => {
    const fixture = fixtures.malformedPgn();
    const { game, warnings } = expectOk(normalizeArchiveGame(fixture, PLAYER));
    expect(game.sanMoves).toBeNull();
    expect(game.pgn).toBe(fixture.pgn);
    expect(game.eco).toBe('C20');
    expect(warnings).toEqual([`PGN moves could not be parsed for ${fixture.url}.`]);
  });

  it('uses the opponent result code when the player code is unknown', () => {
    const game = archiveGame({
      white: { username: PLAYER, rating: 1640, resultCode: 'mystery', uuid: null },
      black: { username: 'opponent', rating: 1620, resultCode: 'win', uuid: null },
      pgn: buildPgn({ white: PLAYER, black: 'opponent', result: '0-1', moves: '1. e4 e5' }),
    });
    expect(expectOk(normalizeArchiveGame(game, PLAYER)).game.result).toBe('loss');
  });

  it('does not infer a draw from unknown results', () => {
    const game = archiveGame({
      pgn: buildPgn({ white: PLAYER, black: 'opponent', result: '*', moves: '1. e4 e5' }),
      white: { username: PLAYER, rating: 1640, resultCode: 'mystery', uuid: null },
      black: { username: 'opponent', rating: 1620, resultCode: 'other', uuid: null },
    });
    expect(expectRejected(normalizeArchiveGame(game, PLAYER))).toContain('Unknown result codes');
  });

  it('rejects contradictory result data', () => {
    const game = archiveGame({
      pgn: buildPgn({ white: PLAYER, black: 'opponent', result: '0-1', moves: '1. e4 e5' }),
    });
    expect(expectRejected(normalizeArchiveGame(game, PLAYER))).toBe(
      'Result codes and PGN Result tag disagree.',
    );
  });

  it('rejects games the configured player did not play', () => {
    expect(expectRejected(normalizeArchiveGame(fixtures.whiteWin(), 'someoneelse'))).toContain(
      'not one of the game',
    );
  });

  it('rejects variant games', () => {
    expect(expectRejected(normalizeArchiveGame(fixtures.chess960(), PLAYER))).toBe(
      'Unsupported variant "chess960" (only standard chess is stored).',
    );
  });

  it('rejects a variant identified only by the PGN Variant tag', () => {
    const game = archiveGame({
      rules: null,
      pgn: buildPgn({
        white: PLAYER,
        black: 'opponent',
        result: '1-0',
        moves: '1. e4 e5',
        extraHeaders: { Variant: 'Crazyhouse' },
      }),
    });
    expect(expectRejected(normalizeArchiveGame(game, PLAYER))).toContain('Crazyhouse');
  });

  it('rejects games without a PGN', () => {
    expect(expectRejected(normalizeArchiveGame(archiveGame({ pgn: null }), PLAYER))).toBe(
      'Game has no PGN.',
    );
  });

  it('nulls an unknown time class and warns', () => {
    const game = archiveGame({ timeClass: 'standard' });
    const { game: normalized, warnings } = expectOk(normalizeArchiveGame(game, PLAYER));
    expect(normalized.timeClass).toBeNull();
    expect(warnings[0]).toContain('Unknown time class "standard"');
  });
});

describe('normalizeArchiveGames', () => {
  it('normalizes multiple time classes and continues past rejected games', () => {
    const input = [
      fixtures.whiteWin(),
      fixtures.chess960(),
      fixtures.blackWin(),
      fixtures.malformedPgn(),
      fixtures.draw(),
      fixtures.missingRatings(),
    ];
    const output = normalizeArchiveGames(input, PLAYER);

    expect(output.games.map((game) => game.timeClass)).toEqual([
      'rapid',
      'blitz',
      'rapid',
      'bullet',
      'daily',
    ]);
    expect(output.rejected).toEqual([
      { url: input[1]!.url, reason: expect.stringContaining('chess960') as string },
    ]);
    expect(output.warnings).toHaveLength(1);
  });
});
