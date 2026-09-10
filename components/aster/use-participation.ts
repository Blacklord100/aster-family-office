'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  PortfolioHistoryQuerySchema,
  type PortfolioHistoryQuery,
} from '@/lib/portfolio-history-contract';
import type { ParticipationResponse } from '@/lib/participation-contract';
import { useWorkspace } from './workspace-context';

/** Every response belongs to one office, access scope and dated selection. */
export function useParticipation(
  query: Partial<PortfolioHistoryQuery> = {},
  enabled = true,
) {
  const { state, revision } = useWorkspace();
  const parsed = PortfolioHistoryQuerySchema.safeParse(query);
  const serialized = parsed.success ? JSON.stringify(parsed.data) : '';
  const organizationId = state.identity?.organizationId;
  const key = JSON.stringify([
    organizationId,
    state.identity?.dataScope,
    serialized,
  ]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    data: ParticipationResponse | null;
    error: string | null;
    refreshing: boolean;
  } | null>(null);
  const [refreshId, setRefreshId] = useState(0);
  const refresh = useCallback(() => setRefreshId((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !serialized || !organizationId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function load() {
      if (disposed) return;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 20_000);
      setSnapshot((old) => ({
        key,
        data: old?.key === key ? old.data : null,
        error: null,
        refreshing: true,
      }));
      try {
        const response = await fetch(
          '/api/participation?' + new URLSearchParams({ query: serialized }),
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
            headers: { 'x-aster-organization': organizationId! },
          },
        );
        const result = await response.json().catch(() => null);
        if (!response.ok) {
          if (!disposed && [401, 403].includes(response.status))
            setSnapshot({ key, data: null, error: null, refreshing: false });
          throw new Error(
            result?.message ?? 'Participation could not be loaded. Try again.',
          );
        }
        if (
          !result ||
          !Array.isArray(result.investments) ||
          !Array.isArray(result.unlinked) ||
          !Array.isArray(result.families) ||
          !Number.isInteger(result.revision)
        )
          throw new Error(
            'Participation returned an incomplete response. Try again.',
          );
        if (!disposed)
          setSnapshot({ key, data: result, error: null, refreshing: false });
      } catch (cause) {
        if (!disposed)
          setSnapshot((old) => ({
            key,
            data: old?.key === key ? old.data : null,
            error:
              cause instanceof Error && cause.name !== 'AbortError'
                ? cause.message
                : 'Participation took too long to load. Try again.',
            refreshing: false,
          }));
      } finally {
        clearTimeout(timeout);
        if (!disposed) timer = setTimeout(() => void load(), 30_000);
      }
    }
    void load();
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [key, serialized, organizationId, revision, enabled, refreshId]);
  const current = snapshot?.key === key ? snapshot : null;
  return {
    data: enabled && parsed.success ? (current?.data ?? null) : null,
    loading:
      enabled &&
      parsed.success &&
      !!organizationId &&
      (!current || (current.refreshing && !current.data)),
    refreshing: current?.refreshing ?? false,
    error: parsed.success
      ? (current?.error ?? null)
      : (parsed.error.issues[0]?.message ??
        'Choose a valid date and currency.'),
    refresh,
  };
}
