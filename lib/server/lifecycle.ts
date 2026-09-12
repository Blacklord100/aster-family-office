import 'server-only';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { pool } from './db';
import {
  LifecycleError,
  runtimeIdentity,
  type LifecycleState,
} from '../lifecycle-contract';
import { lifecycleContext } from './lifecycle-context';
const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export function lifecycleDatabaseError(error: unknown): LifecycleError | null {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  if (code === 'P1601')
    return new LifecycleError(
      'MAINTENANCE_READ_ONLY',
      'Aster is being updated. Your existing records remain available; changes will resume after maintenance.',
    );
  if (code === 'P1602')
    return new LifecycleError(
      'WRITER_FENCED',
      'This application release is no longer allowed to write. Reload after the update.',
    );
  if (code === 'P1604')
    return new LifecycleError(
      'OPERATION_EXPIRED',
      'The operation lease expired. Retry after checking maintenance status.',
    );
  if (code === 'P1603')
    return new LifecycleError(
      'LIFECYCLE_UNAVAILABLE',
      'The operation admission limit was reached. Retry shortly.',
    );
  return error instanceof LifecycleError ? error : null;
}
function missingLifecycle(error: unknown) {
  return (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['42P01', '42883'].includes(String(error.code)) &&
    runtimeIdentity().release === 'legacy'
  );
}
export async function readLifecycleState(): Promise<LifecycleState> {
  try {
    const row = (
      await pool.query<{
        mode: LifecycleState['mode'];
        generation: string;
        active_release: string;
        schema_version: number;
        resumed_at: Date | null;
        updated_at: Date;
      }>(
        'SELECT mode,generation,active_release,schema_version,resumed_at,updated_at FROM app_lifecycle_control WHERE id',
      )
    ).rows[0];
    if (!row)
      throw new LifecycleError(
        'LIFECYCLE_UNAVAILABLE',
        'Lifecycle control is unavailable.',
      );
    const r = runtimeIdentity();
    if (row.schema_version < r.min || row.schema_version > r.max)
      throw new LifecycleError(
        'SCHEMA_INCOMPATIBLE',
        'This application does not support the installed database schema.',
      );
    return {
      enabled: true,
      mode: row.mode,
      generation: Number(row.generation),
      activeRelease: row.active_release,
      schemaVersion: row.schema_version,
      resumedAt: row.resumed_at?.toISOString() ?? null,
      updatedAt: row.updated_at.toISOString(),
    };
  } catch (error) {
    if (missingLifecycle(error))
      return {
        enabled: false,
        mode: 'open',
        generation: 1,
        activeRelease: 'legacy',
        schemaVersion: 15,
        resumedAt: null,
        updatedAt: new Date().toISOString(),
      };
    throw lifecycleDatabaseError(error) ?? error;
  }
}
/** A durable, renewable admission spans asynchronous work outside SQL transactions. */
export async function withLifecycleOperation<T>(
  kind:
    | 'request'
    | 'document'
    | 'mailbox'
    | 'folder'
    | 'archive'
    | 'reporting'
    | 'delivery',
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const nested = lifecycleContext.getStore();
  if (nested?.operation)
    return run(nested.signal ?? new AbortController().signal);
  const id = randomUUID(),
    token = randomBytes(32).toString('hex'),
    hash = tokenHash(token),
    controller = new AbortController();
  let admitted = false;
  try {
    admitted =
      (
        await pool.query<{ admitted: boolean }>(
          'SELECT aster_admit_operation($1,$2,$3) AS admitted',
          [id, hash, kind],
        )
      ).rows[0]?.admitted === true;
  } catch (error) {
    if (missingLifecycle(error))
      return lifecycleContext.run(
        { mode: 'open', readOnly: false, signal: controller.signal },
        () => run(controller.signal),
      );
    throw lifecycleDatabaseError(error) ?? error;
  }
  if (!admitted)
    throw new LifecycleError(
      'MAINTENANCE_READ_ONLY',
      'Aster is draining work for an update. New changes and ingestion are paused.',
    );
  let renewing: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = pool
      .query<{ renewed: boolean }>(
        'SELECT aster_renew_operation($1,$2) AS renewed',
        [id, hash],
      )
      .then((result) => {
        if (!result.rows[0]?.renewed)
          controller.abort(
            new LifecycleError(
              'OPERATION_EXPIRED',
              'Operation admission expired.',
            ),
          );
      })
      .catch(() => {
        controller.abort(
          new LifecycleError(
            'LIFECYCLE_UNAVAILABLE',
            'Operation admission could not be renewed.',
          ),
        );
      })
      .finally(() => {
        renewing = undefined;
      });
  }, 10_000);
  timer.unref();
  try {
    return await lifecycleContext.run(
      {
        mode: 'open',
        readOnly: false,
        operation: { id, token },
        signal: controller.signal,
      },
      () => run(controller.signal),
    );
  } catch (error) {
    throw lifecycleDatabaseError(error) ?? error;
  } finally {
    clearInterval(timer);
    await renewing;
    await pool
      .query('SELECT aster_finish_operation($1,$2)', [id, hash])
      .catch(() => {});
  }
}
export async function runWorkerOperation(
  kind: Exclude<Parameters<typeof withLifecycleOperation>[0], 'request'>,
  run: (signal: AbortSignal) => Promise<unknown>,
): Promise<boolean> {
  try {
    await withLifecycleOperation(kind, run);
    return true;
  } catch (error) {
    const known = lifecycleDatabaseError(error);
    if (
      known &&
      [
        'MAINTENANCE_READ_ONLY',
        'WRITER_FENCED',
        'SCHEMA_INCOMPATIBLE',
        'OPERATION_EXPIRED',
      ].includes(known.code)
    )
      return false;
    throw error;
  }
}
export function lifecycleResponse(error: unknown): Response {
  const known = lifecycleDatabaseError(error);
  return Response.json(
    {
      error: known?.code ?? 'LIFECYCLE_UNAVAILABLE',
      message:
        known?.message ??
        'Aster could not verify its update status. Try again shortly.',
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'private, no-store',
        'Retry-After': '10',
        'X-Aster-Maintenance': 'true',
      },
    },
  );
}
export function lifecycleRoute<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response> | Response,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    const request = args[0] instanceof Request ? args[0] : undefined;
    const path = request ? new URL(request.url).pathname : '';
    const mutatingGet =
      path.startsWith('/api/mailboxes/callback/') ||
      (path.startsWith('/api/auth/') && !path.endsWith('/get-session')) ||
      /^\/api\/documents\/[^/]+(?:\/.*)?$/.test(path) ||
      path.startsWith('/api/archive/records/') ||
      path === '/api/engines/models' ||
      path === '/api/intelligence/search';
    const readOnly =
      (!request || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) &&
      !mutatingGet;
    try {
      if (!readOnly)
        return await withLifecycleOperation('request', (signal) => {
          if (!request) return Promise.resolve(handler(...args));
          const admittedArgs = [...args] as Args;
          admittedArgs[0] = new Request(request, {
            signal: AbortSignal.any([request.signal, signal]),
          });
          return Promise.resolve(handler(...admittedArgs));
        });
      const state = await readLifecycleState();
      const response = await lifecycleContext.run(
        { mode: state.mode, readOnly: true },
        () => Promise.resolve(handler(...args)),
      );
      if (state.mode !== 'open')
        response.headers.set('X-Aster-Maintenance', state.mode);
      return response;
    } catch (error) {
      return lifecycleResponse(error);
    }
  };
}
