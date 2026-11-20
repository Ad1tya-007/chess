import type { ChessComArchiveGame } from '../../src/clients/chesscom.schemas.js';

export const PLAYER = 'TestPlayer';

interface PgnOptions {
  white: string;
  black: string;
  result: string;
  moves: string;
  eco?: string;
  ecoUrl?: string;
  whiteElo?: number;
  blackElo?: number;
  extraHeaders?: Record<string, string>;
}

export function buildPgn(options: PgnOptions): string {
  const headers: Record<string, string> = {
    Event: 'Live Chess',
    Site: 'Chess.com',
    Date: '2026.11.01',
    Round: '-',
    White: options.white,
    Black: options.black,
    Result: options.result,
    ...(options.eco ? { ECO: options.eco } : {}),
    ...(options.ecoUrl ? { ECOUrl: options.ecoUrl } : {}),
    ...(options.whiteElo ? { WhiteElo: String(options.whiteElo) } : {}),
    ...(options.blackElo ? { BlackElo: String(options.blackElo) } : {}),
    ...options.extraHeaders,
  };
  const tags = Object.entries(headers).map(([key, value]) => `[${key} "${value}"]`);
  return `${tags.join('\n')}\n\n${options.moves} ${options.result}\n`;
}

const CARO_KANN_URL = 'https://www.chess.com/openings/Caro-Kann-Defense-Advance-Variation-3...Bf5';
let nextId = 5000;

export function archiveGame(overrides: Partial<ChessComArchiveGame> = {}): ChessComArchiveGame {
  const id = nextId++;
  return {
    url: `https://www.chess.com/game/live/${id}`,
    uuid: null,
    pgn: buildPgn({
      white: PLAYER,
      black: 'opponent',
      result: '1-0',
      moves: '1. e4 c6 2. d4 d5 3. e5 Bf5',
      eco: 'B12',
      ecoUrl: CARO_KANN_URL,
      whiteElo: 1640,
      blackElo: 1620,
    }),
    timeControl: '600',
    timeClass: 'rapid',
    rules: 'chess',
    rated: true,
    startTime: null,
    endTime: new Date('2026-11-01T12:00:00Z'),
    ecoUrl: CARO_KANN_URL,
    initialSetup: null,
    fen: null,
    white: { username: PLAYER, rating: 1640, resultCode: 'win', uuid: null },
    black: { username: 'opponent', rating: 1620, resultCode: 'checkmated', uuid: null },
    ...overrides,
  };
}

/** Representative games covering the result, color, and missing-data cases. */
export const fixtures = {
  whiteWin: () => archiveGame(),

  blackWin: () =>
    archiveGame({
      pgn: buildPgn({
        white: 'opponent',
        black: PLAYER.toLowerCase(),
        result: '0-1',
        moves: '1. f3 e5 2. g4 Qh4#',
        eco: 'A00',
      }),
      timeClass: 'blitz',
      timeControl: '180+2',
      ecoUrl: 'https://www.chess.com/openings/Barnes-Opening-Fools-Mate',
      white: { username: 'opponent', rating: 1500, resultCode: 'checkmated', uuid: null },
      black: { username: PLAYER.toLowerCase(), rating: 1510, resultCode: 'win', uuid: null },
    }),

  draw: () =>
    archiveGame({
      pgn: buildPgn({
        white: PLAYER,
        black: 'drawer',
        result: '1/2-1/2',
        moves: '1. d4 d5',
        eco: 'D00',
      }),
      timeClass: 'bullet',
      timeControl: '60',
      ecoUrl: 'https://www.chess.com/openings/Queens-Pawn-Opening-Symmetrical-Variation',
      white: { username: PLAYER, rating: 1400, resultCode: 'agreed', uuid: null },
      black: { username: 'drawer', rating: 1410, resultCode: 'agreed', uuid: null },
    }),

  missingRatings: () =>
    archiveGame({
      pgn: buildPgn({ white: PLAYER, black: 'unrated', result: '1-0', moves: '1. e4 e5' }),
      timeClass: 'daily',
      timeControl: '1/259200',
      rated: null,
      ecoUrl: null,
      white: { username: PLAYER, rating: null, resultCode: 'win', uuid: null },
      black: { username: 'unrated', rating: null, resultCode: 'resigned', uuid: null },
    }),

  missingEcoAndOpening: () =>
    archiveGame({
      pgn: buildPgn({ white: 'opp', black: PLAYER, result: '1-0', moves: '1. e4 e5' }),
      ecoUrl: null,
      white: { username: 'opp', rating: 1700, resultCode: 'win', uuid: null },
      black: { username: PLAYER, rating: 1650, resultCode: 'resigned', uuid: null },
    }),

  malformedPgn: () =>
    archiveGame({
      pgn: buildPgn({
        white: PLAYER,
        black: 'opponent',
        result: '1-0',
        moves: '1. e4 e5 2. Ke3 Qxz9 3. Nf3',
        eco: 'C20',
      }),
    }),

  chess960: () =>
    archiveGame({
      rules: 'chess960',
      timeClass: 'daily',
    }),
};
