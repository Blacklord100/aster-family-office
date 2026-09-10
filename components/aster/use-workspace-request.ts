'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useWorkspace } from './workspace-context';

export class WorkspaceRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Bind administrative requests and their response bodies to the displayed office. */
export function useWorkspaceRequest() {
  const { state } = useWorkspace();
  const identity = state.identity;
  const organizationId = identity?.organizationId;
  const key = JSON.stringify([
    organizationId,
    identity?.user.id,
    identity?.role,
    identity?.dataScope,
  ]);
  const requests = useRef(new Set<AbortController>());
  const context = useRef({ key, mounted: false });
  useEffect(() => {
    context.current = { key, mounted: true };
    const active = requests.current;
    return () => {
      if (context.current.key === key) context.current.mounted = false;
      for (const controller of active) controller.abort();
      active.clear();
    };
  }, [key]);
  const request = useCallback(
    async <T>(
      url: string,
      init: RequestInit = {},
      format: 'json' | 'blob' = 'json',
      timeoutMs = 20_000,
    ): Promise<T> => {
      const assertCurrent = () => {
        if (!context.current.mounted || context.current.key !== key)
          throw new DOMException(
            'This office selection is no longer active.',
            'AbortError',
          );
      };
      assertCurrent();
      if (!organizationId)
        throw new WorkspaceRequestError(
          'Choose an authenticated office first.',
          401,
        );
      const target = new URL(url, window.location.origin);
      if (
        target.origin !== window.location.origin ||
        !target.pathname.startsWith('/api/')
      )
        throw new WorkspaceRequestError(
          'Workspace requests must use this installation’s API.',
          400,
        );
      const controller = new AbortController();
      requests.current.add(controller);
      const headers = new Headers(init.headers);
      headers.set('x-aster-organization', organizationId);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(timeoutMs),
        ...(init.signal ? [init.signal] : []),
      ]);
      try {
        const response = await fetch(target.toString(), {
          ...init,
          headers,
          signal,
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
        });
        const body =
          format === 'blob' && response.ok
            ? await response.blob()
            : await response.json().catch(() => null);
        signal.throwIfAborted();
        assertCurrent();
        if (!response.ok)
          throw new WorkspaceRequestError(
            body?.message ?? 'The request could not be completed. Try again.',
            response.status,
          );
        if (body == null)
          throw new WorkspaceRequestError(
            'The server returned an incomplete response. Try again.',
            502,
          );
        return body;
      } finally {
        requests.current.delete(controller);
      }
    },
    [organizationId, key],
  );
  return { request, key, organizationId };
}
