'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  PortfolioHistoryQuerySchema,
  type PortfolioHistoryQuery,
  type PortfolioHistoryResponse,
} from '@/lib/portfolio-history-contract';
import { useWorkspace } from './workspace-context';

export function usePortfolioHistory(
  query: Partial<PortfolioHistoryQuery>,
  enabled = true,
) {
  const { state, revision } = useWorkspace();
  const parsed = PortfolioHistoryQuerySchema.safeParse(query);
  const serialized = parsed.success ? JSON.stringify(parsed.data) : '';
  const validationError = parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? 'Choose a valid history selection.');
  const identity = state.identity;
  const key = JSON.stringify([
    identity?.organizationId,
    identity?.dataScope,
    serialized,
  ]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    data: PortfolioHistoryResponse | null;
    error: string | null;
    refreshing: boolean;
  } | null>(null);
  const [refreshId, setRefreshId] = useState(0);
  const refresh = useCallback(() => setRefreshId((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !serialized || !identity?.organizationId) return;
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
        error: old?.key === key ? old.error : null,
        refreshing: true,
      }));
      try {
        const response = await fetch(
          '/api/portfolio-history?' +
            new URLSearchParams({ query: serialized }),
          {
            signal: controller.signal,
            credentials: 'same-origin',
            headers: { 'x-aster-organization': identity!.organizationId },
            cache: 'no-store',
          },
        );
        const result = await response.json().catch(() => null);
        if (!response.ok) {
          if (!disposed && [401, 403].includes(response.status))
            setSnapshot({
              key,
              data: null,
              error:
                result?.message ?? 'History is unavailable for this access.',
              refreshing: false,
            });
          throw new Error(
            result?.message ?? 'History could not be loaded. Try refreshing.',
          );
        }
        if (
          !result ||
          !Array.isArray(result.observations) ||
          !Array.isArray(result.points) ||
          !Array.isArray(result.positions) ||
          !result.page ||
          result.projectionVersion !== 'portfolio-history/1'
        )
          throw new Error(
            'History returned an incomplete response. Try refreshing.',
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
                : 'History took too long to load. Try refreshing.',
            refreshing: false,
          }));
      } finally {
        clearTimeout(timeout);
        if (!disposed)
          timer = setTimeout(() => {
            if (document.visibilityState === 'visible') void load();
            else timer = setTimeout(() => void load(), 30_000);
          }, 30_000);
      }
    }
    void load();
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [serialized, key, identity?.organizationId, revision, enabled, refreshId]);

  const current = snapshot?.key === key ? snapshot : null;
  return {
    data: enabled && !validationError ? (current?.data ?? null) : null,
    loading:
      enabled &&
      !validationError &&
      (!current || (current.refreshing && !current.data)),
    refreshing: current?.refreshing ?? false,
    error: validationError ?? current?.error ?? null,
    refresh,
  };
}
