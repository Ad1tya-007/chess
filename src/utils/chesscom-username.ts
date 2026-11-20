import { AppError } from './errors.js';

/** Chess.com usernames: letters, digits, underscores, and hyphens. */
export const CHESSCOM_USERNAME_PATTERN = /^[A-Za-z0-9_-]{2,50}$/;

export function isValidChessComUsername(value: string): boolean {
  return CHESSCOM_USERNAME_PATTERN.test(value);
}

/**
 * Trims and lowercases a Chess.com username. Chess.com treats usernames case-insensitively, and the
 * lowercase form is what the PubAPI URLs and our `players` table use. Returns null when invalid.
 */
export function normalizeChessComUsername(value: string): string | null {
  const trimmed = value.trim();
  return isValidChessComUsername(trimmed) ? trimmed.toLowerCase() : null;
}

/** Normalizes `requested`, falling back to the configured default; throws on invalid input. */
export function resolveUsername(requested: string | undefined, fallback: string): string {
  const normalized = normalizeChessComUsername(requested ?? fallback);
  if (!normalized) throw new AppError('invalid_input', 'Invalid Chess.com username.');
  return normalized;
}
