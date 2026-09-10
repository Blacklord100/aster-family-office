import type { TimelineEvent } from '@/data';

export type ActivityDateMode = 'effective' | 'imported';
export type ActivityDirection = 'newest' | 'oldest';

export function activityDate(event: TimelineEvent, mode: ActivityDateMode) {
  if (mode === 'imported') {
    return Number.isFinite(Date.parse(event.receivedAt))
      ? event.receivedAt.slice(0, 10)
      : null;
  }
  if (event.dateBasis === 'Receipt date fallback') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(event.date) &&
    Number.isFinite(Date.parse(event.date))
    ? event.date
    : null;
}

/** Unknown economic dates stay last; intake order never substitutes for chronology. */
export function orderActivity(
  events: readonly TimelineEvent[],
  mode: ActivityDateMode = 'effective',
  direction: ActivityDirection = 'newest',
) {
  const sign = direction === 'newest' ? -1 : 1;
  return [...events].sort((a, b) => {
    const first = activityDate(a, mode),
      second = activityDate(b, mode);
    if (first === null || second === null) {
      if (first !== second) return first === null ? 1 : -1;
    } else {
      const dateOrder = first.localeCompare(second);
      if (dateOrder) return sign * dateOrder;
    }
    const intakeOrder = a.receivedAt.localeCompare(b.receivedAt);
    return sign * intakeOrder || a.id.localeCompare(b.id);
  });
}
