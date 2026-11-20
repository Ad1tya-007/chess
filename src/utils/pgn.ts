import { Chess } from 'chess.js';

const MAX_HEADERS = 64;
const MAX_HEADER_VALUE = 500;
const HEADER_LINE = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/;
/** Values that PGN uses to mean "unknown". */
const PLACEHOLDER_VALUES = new Set(['', '?', '-', '????.??.??', '??:??:??']);

export interface ParsedPgn {
  /** Tag pairs with placeholder values ("?", "????.??.??", …) removed. */
  headers: Record<string, string>;
  /** SAN moves in order; null when the movetext could not be parsed. */
  sanMoves: string[] | null;
  /** Short, generic reason when the movetext failed to parse. */
  error: string | null;
}

/**
 * Reads PGN tag pairs directly so headers survive malformed movetext, then validates the moves
 * with chess.js. The PGN is treated as untrusted data: comments are never interpreted.
 */
export function parsePgn(pgn: string): ParsedPgn {
  const headers = parseHeaders(pgn);

  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return { headers, sanMoves: chess.history(), error: null };
  } catch {
    return { headers, sanMoves: null, error: 'Movetext could not be parsed as legal chess moves.' };
  }
}

function parseHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let count = 0;

  for (const rawLine of pgn.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      if (count > 0) break;
      continue;
    }
    const match = HEADER_LINE.exec(line);
    if (!match) break;
    if (++count > MAX_HEADERS) break;

    const value = match[2]!.replace(/\\(["\\])/g, '$1').trim();
    if (!PLACEHOLDER_VALUES.has(value) && value.length <= MAX_HEADER_VALUE) {
      headers[match[1]!] = value;
    }
  }
  return headers;
}
