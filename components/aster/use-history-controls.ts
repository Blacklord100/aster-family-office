'use client';
import { useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import type { PortfolioHistoryQuery } from '@/lib/portfolio-history-contract';

export type HistoryControls = {
  from: string;
  to: string;
  asOf: string;
  currency: PortfolioHistoryQuery['currency'];
  cohort: 'current' | 'historical';
  knownAt: string;
  observation: string;
  offset: number;
  versions: boolean;
};
const params: Record<keyof HistoryControls, string> = {
  from: 'historyFrom',
  to: 'historyTo',
  asOf: 'historyAsOf',
  currency: 'historyCurrency',
  cohort: 'historyCohort',
  knownAt: 'historyKnownAt',
  observation: 'observation',
  offset: 'historyOffset',
  versions: 'historyVersions',
};
export function useHistoryControls() {
  const search = useSearchParams();
  const currency = search.get(params.currency);
  const offset = Number(search.get(params.offset) ?? 0);
  const controls: HistoryControls = {
    from: search.get(params.from) ?? '',
    to: search.get(params.to) ?? '',
    asOf: search.get(params.asOf) ?? '',
    currency:
      currency === 'USD' || currency === 'GBP' || currency === 'CHF'
        ? currency
        : 'EUR',
    cohort: search.get(params.cohort) === 'current' ? 'current' : 'historical',
    knownAt: search.get(params.knownAt) ?? '',
    observation: search.get(params.observation) ?? '',
    offset:
      Number.isInteger(offset) && offset >= 0 && offset <= 100000 ? offset : 0,
    versions: search.get(params.versions) === 'true',
  };
  const setControls = useCallback((changes: Partial<HistoryControls>) => {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(changes)) {
      const name = params[key as keyof HistoryControls];
      if (value === '' || value === false || value === 0)
        url.searchParams.delete(name);
      else url.searchParams.set(name, String(value));
    }
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, []);
  const query: Partial<PortfolioHistoryQuery> = {
    ...(controls.from ? { from: controls.from } : {}),
    ...(controls.to ? { to: controls.to } : {}),
    ...(controls.asOf ? { asOf: controls.asOf } : {}),
    cohort: controls.cohort,
    currency: controls.currency,
    knowledge: controls.knownAt ? 'as_known' : 'restated',
    ...(controls.knownAt ? { knownAt: controls.knownAt } : {}),
    includeSuperseded: controls.versions,
    limit: 20,
    offset: controls.offset,
    ...(controls.observation ? { observationId: controls.observation } : {}),
  };
  return { controls, setControls, query };
}
