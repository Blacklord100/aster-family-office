/** Capacity is not an extraction failure, but waiting is bounded to 30 deferrals. */
export function retryDecision(
  stopping: boolean,
  code: string,
  attempts: number,
  capacityDeferrals: number,
) {
  if (stopping) return 'shutdown' as const;
  if (code === 'PROCESSOR_HTTP_503')
    return capacityDeferrals < 30 ? ('capacity' as const) : ('fail' as const);
  // Retrying identical bytes cannot repair a rejected document/request. Keep
  // transient timeouts, throttling and server failures on the bounded retry path.
  if (
    [400, 413, 415, 422].some((status) => code === `PROCESSOR_HTTP_${status}`)
  )
    return 'fail' as const;
  return attempts < 3 ? ('retry' as const) : ('fail' as const);
}
