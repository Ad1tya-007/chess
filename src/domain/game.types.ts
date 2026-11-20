export const GAME_RESULTS = ['win', 'loss', 'draw'] as const;
export type GameResult = (typeof GAME_RESULTS)[number];

export const PLAYER_COLORS = ['white', 'black'] as const;
export type PlayerColor = (typeof PLAYER_COLORS)[number];

export const TIME_CLASSES = ['daily', 'rapid', 'blitz', 'bullet'] as const;
export type TimeClass = (typeof TIME_CLASSES)[number];

/**
 * A standard-chess game normalized from the configured player's perspective, ready to persist.
 * Fields Chess.com did not supply (or supplied malformed) are null, never guessed.
 */
export interface NormalizedGame {
  chesscomGameUrl: string;
  /** When the game ended (Chess.com `end_time`); monthly archives are grouped by end date. */
  playedAt: Date;
  timeClass: TimeClass | null;
  timeControl: string | null;
  rated: boolean | null;
  whiteUsername: string;
  blackUsername: string;
  whiteRating: number | null;
  blackRating: number | null;
  result: GameResult;
  playerColor: PlayerColor;
  opponentUsername: string;
  opponentRating: number | null;
  eco: string | null;
  openingName: string | null;
  pgn: string;
  sanMoves: string[] | null;
}
