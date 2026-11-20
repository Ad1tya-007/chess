import type { ChessComArchiveGame, ChessComGamePlayer } from '../clients/chesscom.schemas.js';
import { parsePgn } from '../utils/pgn.js';
import {
  TIME_CLASSES,
  type GameResult,
  type NormalizedGame,
  type PlayerColor,
  type TimeClass,
} from './game.types.js';

/**
 * Chess.com "Game results codes" (PubAPI docs). Each player in a game carries their own code:
 * `win` for the winner; a loss reason for the loser; a draw reason for both players in a draw.
 */
const WIN_CODES = new Set(['win']);
const LOSS_CODES = new Set([
  'checkmated',
  'resigned',
  'timeout',
  'lose',
  'abandoned',
  'kingofthehill',
  'threecheck',
  'bughousepartnerlose',
]);
const DRAW_CODES = new Set([
  'agreed',
  'repetition',
  'stalemate',
  'insufficient',
  '50move',
  'timevsinsufficient',
]);

/** Only standard chess is stored in Version 1; variants have separate ratings and openings. */
const SUPPORTED_RULES = 'chess';

const ECO_PATTERN = /^[A-E]\d{2}$/;
/** "600", "180+2" (live, seconds + increment) or "1/259200" (daily, seconds per move). */
const TIME_CONTROL_PATTERN = /^(?:\d{1,6}(?:\+\d{1,4})?|1\/\d{1,7})$/;
const OPENINGS_URL_PREFIX = 'https://www.chess.com/openings/';
const MOVE_SEGMENT = /^\.{0,3}\d+\./;
const MAX_RATING = 5000;

/** Maps one player's Chess.com result code to that player's result; null when unknown. */
export function mapResultCode(code: string): GameResult | null {
  const normalized = code.trim().toLowerCase();
  if (WIN_CODES.has(normalized)) return 'win';
  if (LOSS_CODES.has(normalized)) return 'loss';
  if (DRAW_CODES.has(normalized)) return 'draw';
  return null;
}

const invert = (result: GameResult | null): GameResult | null =>
  result === 'win' ? 'loss' : result === 'loss' ? 'win' : result;

/** Maps a PGN Result tag ("1-0", "0-1", "1/2-1/2") to the given color's result. */
export function mapPgnResult(result: string | undefined, color: PlayerColor): GameResult | null {
  const whiteResult =
    result === '1-0' ? 'win' : result === '0-1' ? 'loss' : result === '1/2-1/2' ? 'draw' : null;
  return color === 'white' ? whiteResult : invert(whiteResult);
}

/** Case-insensitive match of the configured player against the game's two usernames. */
export function detectPlayerColor(
  game: Pick<ChessComArchiveGame, 'white' | 'black'>,
  username: string,
): PlayerColor | null {
  const target = username.toLowerCase();
  const isWhite = game.white.username.toLowerCase() === target;
  const isBlack = game.black.username.toLowerCase() === target;
  if (isWhite === isBlack) return null;
  return isWhite ? 'white' : 'black';
}

export function normalizeTimeClass(value: string | null): TimeClass | null {
  const normalized = value?.trim().toLowerCase();
  return (TIME_CLASSES as readonly string[]).includes(normalized ?? '')
    ? (normalized as TimeClass)
    : null;
}

export function normalizeTimeControl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && TIME_CONTROL_PATTERN.test(trimmed) ? trimmed : null;
}

export function normalizeEco(value: string | undefined): string | null {
  const trimmed = value?.trim().toUpperCase();
  return trimmed && ECO_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Derives a display name from a Chess.com opening URL, dropping the trailing move sequence:
 * ".../openings/Four-Knights-Game-Glek-Variation-4...Bb4-5.Bg2" -> "Four Knights Game Glek Variation".
 * Chess.com does not send an opening-name tag, so this URL slug is the only name it supplies.
 */
export function openingNameFromUrl(url: string | null | undefined): string | null {
  if (!url?.startsWith(OPENINGS_URL_PREFIX)) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(url.slice(OPENINGS_URL_PREFIX.length).split(/[?#]/)[0]!);
  } catch {
    return null;
  }

  // Moves follow either as their own segment ("-4...Bb4", "-5.Bg2") or glued on ("Variation...7.O-O").
  const [namePart = ''] = slug.split(/\.\.\.(?=\d)/);
  const words: string[] = [];
  for (const segment of namePart.split('-')) {
    if (MOVE_SEGMENT.test(segment)) break;
    if (segment !== '') words.push(segment);
  }
  const name = words.join(' ').trim();
  return name.length > 0 && name.length <= 200 && /^[\p{L}\p{N}' ]+$/u.test(name) ? name : null;
}

function parseRating(value: string | undefined): number | null {
  if (!value || !/^\d{1,4}$/.test(value)) return null;
  const rating = Number(value);
  return rating <= MAX_RATING ? rating : null;
}

export type NormalizeOutcome =
  { ok: true; game: NormalizedGame; warnings: string[] } | { ok: false; reason: string };

/**
 * Normalizes one archived game from `username`'s perspective. Games that cannot be attributed
 * reliably (player not in the game, unknown or conflicting result, variant, no PGN) are rejected
 * with a reason instead of being stored with guessed values.
 */
export function normalizeArchiveGame(
  game: ChessComArchiveGame,
  username: string,
): NormalizeOutcome {
  if (!game.pgn || game.pgn.trim() === '') {
    return { ok: false, reason: 'Game has no PGN.' };
  }

  const parsed = parsePgn(game.pgn);
  const variant = game.rules ?? parsed.headers.Variant ?? SUPPORTED_RULES;
  if (variant.toLowerCase() !== SUPPORTED_RULES && variant.toLowerCase() !== 'standard') {
    return {
      ok: false,
      reason: `Unsupported variant "${variant}" (only standard chess is stored).`,
    };
  }

  const playerColor = detectPlayerColor(game, username);
  if (!playerColor) {
    return { ok: false, reason: `Player "${username}" is not one of the game's two players.` };
  }
  const player: ChessComGamePlayer = playerColor === 'white' ? game.white : game.black;
  const opponent: ChessComGamePlayer = playerColor === 'white' ? game.black : game.white;

  const candidates = [
    mapResultCode(player.resultCode),
    invert(mapResultCode(opponent.resultCode)),
    mapPgnResult(parsed.headers.Result, playerColor),
  ].filter((value): value is GameResult => value !== null);
  const result = candidates[0];
  if (!result) {
    return {
      ok: false,
      reason: `Unknown result codes "${player.resultCode}"/"${opponent.resultCode}".`,
    };
  }
  if (candidates.some((candidate) => candidate !== result)) {
    return { ok: false, reason: 'Result codes and PGN Result tag disagree.' };
  }

  const warnings: string[] = [];
  if (!parsed.sanMoves) warnings.push(`PGN moves could not be parsed for ${game.url}.`);

  const timeClass = normalizeTimeClass(game.timeClass);
  if (game.timeClass && !timeClass)
    warnings.push(`Unknown time class "${game.timeClass}" for ${game.url}.`);

  const whiteRating = game.white.rating ?? parseRating(parsed.headers.WhiteElo);
  const blackRating = game.black.rating ?? parseRating(parsed.headers.BlackElo);

  return {
    ok: true,
    warnings,
    game: {
      chesscomGameUrl: game.url,
      playedAt: game.endTime,
      timeClass,
      timeControl: normalizeTimeControl(game.timeControl ?? parsed.headers.TimeControl),
      rated: game.rated,
      whiteUsername: game.white.username,
      blackUsername: game.black.username,
      whiteRating,
      blackRating,
      result,
      playerColor,
      opponentUsername: opponent.username,
      opponentRating: playerColor === 'white' ? blackRating : whiteRating,
      eco: normalizeEco(parsed.headers.ECO),
      openingName: openingNameFromUrl(game.ecoUrl ?? parsed.headers.ECOUrl),
      pgn: game.pgn,
      sanMoves: parsed.sanMoves,
    },
  };
}

export interface NormalizedArchive {
  games: NormalizedGame[];
  /** Games that were not stored, with the reason. */
  rejected: Array<{ url: string; reason: string }>;
  warnings: string[];
}

/** Normalizes a whole monthly archive; one bad game never aborts the rest. */
export function normalizeArchiveGames(
  games: ChessComArchiveGame[],
  username: string,
): NormalizedArchive {
  const output: NormalizedArchive = { games: [], rejected: [], warnings: [] };
  for (const game of games) {
    const outcome = normalizeArchiveGame(game, username);
    if (outcome.ok) {
      output.games.push(outcome.game);
      output.warnings.push(...outcome.warnings);
    } else {
      output.rejected.push({ url: game.url, reason: outcome.reason });
    }
  }
  return output;
}
