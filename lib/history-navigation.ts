/** Preserve the economic comparison when following a participant to its holding. */
export function copyHistoryNavigation(
  current: URLSearchParams,
  next: URLSearchParams,
  before: { view: string; holding: string | null; family: string },
  after: { view: string; holding: string | null; family: string },
) {
  const samePosition =
    before.view === after.view && before.holding === after.holding;
  const historyViews = new Set(['overview', 'portfolio', 'investments']);
  const crossHistory =
    historyViews.has(before.view) && historyViews.has(after.view);
  const shared = new Set([
    'historyFrom',
    'historyTo',
    'historyAsOf',
    'historyCurrency',
    'historyKnownAt',
    'historyCohort',
    'investmentList',
  ]);
  for (const [key, value] of current) {
    if (
      samePosition &&
      (key.startsWith('history') ||
        [
          'activityMode',
          'activityOrder',
          'investmentTab',
          'investmentList',
        ].includes(key))
    )
      next.set(key, value);
    else if (crossHistory && shared.has(key)) next.set(key, value);
  }
  if (
    samePosition &&
    before.family === after.family &&
    current.has('observation')
  )
    next.set('observation', current.get('observation')!);
}
