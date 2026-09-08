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
  return attempts < 3 ? ('retry' as const) : ('fail' as const);
}
