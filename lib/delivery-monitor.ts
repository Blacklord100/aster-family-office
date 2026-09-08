import { z } from 'zod';

/** Recovery messages should not wait five minutes for an operated delivery worker. */
export const DELIVERY_PENDING_MAX_AGE_MS = 5 * 60 * 1000;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .nullable();
const evidenceSchema = z
  .object({
    pending: count,
    failed: count,
    expired_unprocessed: count,
    oldest_pending_at: timestamp,
    latest_pending_at: timestamp,
  })
  .strict();

type DeliveryAlert = {
  code:
    | 'DELIVERY_FAILED'
    | 'DELIVERY_PENDING_STALE'
    | 'DELIVERY_EXPIRED_UNPROCESSED'
    | 'DELIVERY_EVIDENCE_INVALID';
  message: string;
};

/** Accept aggregate evidence only; malformed inputs never enter monitor output. */
export function classifyDeliveryQueue(evidence: unknown, now = Date.now()) {
  const parsed = evidenceSchema.safeParse(evidence);
  const invalid = () => ({
    result: 'attention' as const,
    pending: null,
    failed: null,
    expired_unprocessed: null,
    oldest_pending_at: null,
    latest_pending_at: null,
    oldestPendingAgeSeconds: null,
    pendingMaxAgeSeconds: DELIVERY_PENDING_MAX_AGE_MS / 1000,
    alerts: [
      {
        code: 'DELIVERY_EVIDENCE_INVALID',
        message:
          'Delivery queue evidence is missing, inconsistent or outside the monitoring clock.',
      },
    ] satisfies DeliveryAlert[],
  });
  if (!parsed.success || !Number.isFinite(new Date(now).getTime()))
    return invalid();
  const row = parsed.data;
  const oldest =
    row.oldest_pending_at === null
      ? null
      : new Date(row.oldest_pending_at).getTime();
  const latest =
    row.latest_pending_at === null
      ? null
      : new Date(row.latest_pending_at).getTime();
  if (
    (row.pending === 0 && (oldest !== null || latest !== null)) ||
    (row.pending > 0 && (oldest === null || latest === null)) ||
    (oldest !== null && (!Number.isFinite(oldest) || oldest > now)) ||
    (latest !== null && (!Number.isFinite(latest) || latest > now)) ||
    (oldest !== null && latest !== null && oldest > latest)
  )
    return invalid();
  const age = oldest === null ? null : now - oldest;
  const alerts: DeliveryAlert[] = [];
  if (row.failed > 0)
    alerts.push({
      code: 'DELIVERY_FAILED',
      message: 'Recovery delivery has failed messages requiring attention.',
    });
  if (age !== null && age >= DELIVERY_PENDING_MAX_AGE_MS)
    alerts.push({
      code: 'DELIVERY_PENDING_STALE',
      message:
        'Recovery messages have waited at least five minutes for delivery.',
    });
  if (row.expired_unprocessed > 0)
    alerts.push({
      code: 'DELIVERY_EXPIRED_UNPROCESSED',
      message: 'Expired recovery messages still await delivery-worker cleanup.',
    });
  return {
    result: alerts.length ? ('attention' as const) : ('passed' as const),
    pending: row.pending,
    failed: row.failed,
    expired_unprocessed: row.expired_unprocessed,
    oldest_pending_at: oldest === null ? null : new Date(oldest).toISOString(),
    latest_pending_at: latest === null ? null : new Date(latest).toISOString(),
    oldestPendingAgeSeconds: age === null ? null : Math.floor(age / 1000),
    pendingMaxAgeSeconds: DELIVERY_PENDING_MAX_AGE_MS / 1000,
    alerts,
  };
}
