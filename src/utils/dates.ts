/** Latest timestamp we accept from upstream data: year 2100. */
const MAX_EPOCH_SECONDS = 4_102_444_800;

/** Converts a Unix timestamp in seconds to a Date; null for non-integer or out-of-range values. */
export function epochSecondsToDate(seconds: unknown): Date | null {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds)) return null;
  if (seconds < 0 || seconds > MAX_EPOCH_SECONDS) return null;
  return new Date(seconds * 1000);
}

/** Formats an archive month as YYYY-MM. */
export function formatArchiveMonth({ year, month }: { year: number; month: number }): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}
