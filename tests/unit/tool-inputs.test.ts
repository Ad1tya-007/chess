import { describe, expect, it } from 'vitest';

import { parseFromDate, parseToDate } from '../../src/server/tools/shared.js';
import { normalizeOpponentFilter } from '../../src/services/game.service.js';
import { canonicalGameUrl } from '../../src/utils/game-url.js';

describe('canonicalGameUrl', () => {
  it.each([
    ['https://www.chess.com/game/live/123456789', 'https://www.chess.com/game/live/123456789'],
    ['https://chess.com/game/daily/42', 'https://www.chess.com/game/daily/42'],
    ['http://www.chess.com/game/live/1/', 'https://www.chess.com/game/live/1'],
    ['https://www.chess.com/game/live/1?move=12#x', 'https://www.chess.com/game/live/1'],
    ['  https://www.chess.com/game/live/7  ', 'https://www.chess.com/game/live/7'],
  ])('accepts %s', (input, expected) => {
    expect(canonicalGameUrl(input)).toBe(expected);
  });

  it.each([
    'https://evil.example/game/live/1',
    'https://www.chess.com.evil.example/game/live/1',
    'https://user:pass@www.chess.com/game/live/1',
    'https://www.chess.com:8443/game/live/1',
    'https://www.chess.com/member/hikaru',
    'https://www.chess.com/game/live/abc',
    'https://www.chess.com/game/live/1/../../etc',
    'ftp://www.chess.com/game/live/1',
    'javascript:alert(1)',
    'not a url',
    '',
  ])('rejects %s', (input) => {
    expect(canonicalGameUrl(input)).toBeNull();
  });
});

describe('date inputs', () => {
  it('treats a date-only from_date as the start of that UTC day', () => {
    expect(parseFromDate('2026-11-01')?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('makes a date-only to_date include the whole day', () => {
    expect(parseToDate('2026-11-30')?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('makes a date-time to_date inclusive', () => {
    expect(parseToDate('2026-11-30T12:00:00+02:00')?.toISOString()).toBe(
      '2026-11-30T10:00:00.001Z',
    );
  });

  it('passes undefined through', () => {
    expect(parseFromDate(undefined)).toBeUndefined();
    expect(parseToDate(undefined)).toBeUndefined();
  });
});

describe('normalizeOpponentFilter', () => {
  it('lowercases a valid Chess.com username', () => {
    expect(normalizeOpponentFilter('Hikaru')).toBe('hikaru');
  });

  it('passes undefined through', () => {
    expect(normalizeOpponentFilter(undefined)).toBeUndefined();
  });
});
