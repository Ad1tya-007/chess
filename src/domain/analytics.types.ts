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
  opponentRating: number | null;
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
