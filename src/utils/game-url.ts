const GAME_PATH_PATTERN = /^\/game\/([a-z]{1,20})\/(\d{1,20})\/?$/;

/**
 * Canonicalizes a Chess.com game URL to the form stored in the database
 * (`https://www.chess.com/game/<type>/<id>`). Accepts `chess.com` without `www`, `http`, a trailing
 * slash, and query/fragment parts such as `?move=12`. Returns null for anything else. The URL is
 * only used as a lookup key; it is never fetched.
 */
export function canonicalGameUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname !== 'www.chess.com' && url.hostname !== 'chess.com') return null;
  if (url.username || url.password || url.port) return null;
  const match = GAME_PATH_PATTERN.exec(url.pathname);
  if (!match) return null;
  return `https://www.chess.com/game/${match[1]}/${match[2]}`;
}
