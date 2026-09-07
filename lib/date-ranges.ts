export function rangeStartDate(asOf: string, range: string): string {
  const date = new Date(asOf + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid as-of date');
  if (range.toUpperCase() === 'YTD')
    return date.getUTCFullYear() - 1 + '-12-31';
  const months =
    range.toUpperCase() === '1M' ? 1 : range.toUpperCase() === '3M' ? 3 : 12;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const last = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString().slice(0, 10);
}
