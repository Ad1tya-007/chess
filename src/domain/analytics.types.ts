import type { GameResult, PlayerColor } from './game.types.js';

/** The minimal per-game data analytics need; never includes PGNs. */
export interface AnalyticsGame {
  playedAt: Date;
  result: GameResult;
  playerColor: PlayerColor;
  timeClass: string | null;
  eco: string | null;
  openingName: string | null;
  playerRating: number | null;
  opponentUsername: string;
  opponentRating: number | null;
  /** Validated SAN ply list from the stored game; null when moves could not be parsed. */
  sanMoves: string[] | null;
}

export interface ResultSummary {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** wins / games * 100, one decimal; null when there are no games. */
  winRate: number | null;
  /** (wins + 0.5 * draws) / games * 100, one decimal; null when there are no games. */
  scorePercentage: number | null;
}

export interface RatingAverage {
  /** Arithmetic mean of non-null ratings, rounded to an integer; null if none. */
  value: number | null;
  /** Number of games that had a rating (the mean's denominator). */
  gamesWithRating: number;
}

export interface Streak {
  length: number;
  /** played_at of the first and last game in the streak. */
  from: Date;
  to: Date;
}

export interface StreakSummary {
  longestWinStreak: Streak | null;
  longestLossStreak: Streak | null;
  /** Streak ending at the most recent game; `type` is null when the latest game was a draw. */
  current: { type: 'win' | 'loss' | null; length: number };
}

export interface OpeningStat extends ResultSummary {
  eco: string | null;
  openingName: string | null;
  /** True when `games` is below LOW_SAMPLE_GAMES; treat rates as anecdotal. */
  lowSample: boolean;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
}

export interface OpponentStat extends ResultSummary {
  /** Display form of the opponent username (casing from the most recent game). */
  opponentUsername: string;
  /** True when `games` is below LOW_SAMPLE_GAMES; treat rates as anecdotal. */
  lowSample: boolean;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
  averageOpponentRating: RatingAverage;
  byColor: Record<PlayerColor, ResultSummary>;
}

export interface RatingTrend {
  timeClass: string | null;
  gamesWithRating: number;
  firstRating: number | null;
  lastRating: number | null;
  /** lastRating - firstRating; null when fewer than one rated game. */
  change: number | null;
  minRating: number | null;
  maxRating: number | null;
  firstGameAt: Date | null;
  lastGameAt: Date | null;
}

/** One node in a SAN-prefix opening move tree (root has `san` null and empty `prefix`). */
export interface OpeningMoveTreeNode extends ResultSummary {
  /** SAN of the move that reached this node from its parent; null at the root. */
  san: string | null;
  /** Full SAN sequence from the start of the game to this node. */
  prefix: string[];
  /** Depth in plies (half-moves); 0 at the root. */
  ply: number;
  /** True when `games` is below LOW_SAMPLE_GAMES; treat rates as anecdotal. */
  lowSample: boolean;
  /** Top children by games played (then score), after min_games filtering. */
  children: OpeningMoveTreeNode[];
  /** Sibling branches dropped by min_games or the per-node children cap. */
  childrenOmitted: number;
}

export interface OpeningMoveTree {
  root: OpeningMoveTreeNode;
  /** Games whose `sanMoves` were non-null and contributed to the tree. */
  gamesWithMoves: number;
  /** Filtered games skipped because `sanMoves` was null. */
  gamesMissingMoves: number;
  /** Nodes included in the returned tree (including the root). */
  nodesReturned: number;
}
