import { describe, expect, it } from 'vitest';

import { normalizeChessComUsername } from '../../src/utils/chesscom-username.js';

describe('normalizeChessComUsername', () => {
  it.each([
    ['Hikaru', 'hikaru'],
    ['  MagnusCarlsen  ', 'magnuscarlsen'],
    ['some_user-01', 'some_user-01'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeChessComUsername(input)).toBe(expected);
  });

  it.each(['', ' ', 'a', 'has space', 'semi;colon', '../etc', 'x'.repeat(51), 'émile'])(
    'rejects %j',
    (input) => {
      expect(normalizeChessComUsername(input)).toBeNull();
    },
  );
});
