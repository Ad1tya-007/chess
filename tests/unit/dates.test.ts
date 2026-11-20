import { describe, expect, it } from 'vitest';

import { epochSecondsToDate, formatArchiveMonth } from '../../src/utils/dates.js';

describe('epochSecondsToDate', () => {
  it('converts Unix seconds to a UTC date', () => {
    expect(epochSecondsToDate(1793540394)?.toISOString()).toBe('2026-11-01T13:39:54.000Z');
    expect(epochSecondsToDate(0)?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it.each([
    ['milliseconds by mistake', 1793540394000],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['string', '1793540394'],
    ['null', null],
    ['undefined', undefined],
  ])('returns null for %s', (_label, value) => {
    expect(epochSecondsToDate(value)).toBeNull();
  });
});

describe('formatArchiveMonth', () => {
  it('zero-pads the month', () => {
    expect(formatArchiveMonth({ year: 2026, month: 3 })).toBe('2026-03');
    expect(formatArchiveMonth({ year: 2026, month: 11 })).toBe('2026-11');
  });
});
