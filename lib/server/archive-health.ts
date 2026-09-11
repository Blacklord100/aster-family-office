import 'server-only';
import { stat } from 'node:fs/promises';
/** Metadata-only probe: never read an arbitrary operator-configured file into an API response. */
export async function archiveWorkerHealth(
  environment: Record<string, string | undefined> = process.env,
  now = Date.now(),
): Promise<{
  workerStatus: 'healthy' | 'stale' | 'unknown';
  workerCheckedAt: string;
  workerHeartbeatAt: string | null;
}> {
  const workerCheckedAt = new Date(now).toISOString();
  try {
    const info = await stat(
      environment.ARCHIVE_HEARTBEAT_FILE ?? '/tmp/aster-archive-heartbeat',
    );
    if (!info.isFile() || info.size > 64 || !Number.isFinite(info.mtimeMs))
      return {
        workerStatus: 'unknown',
        workerCheckedAt,
        workerHeartbeatAt: null,
      };
    const age = now - info.mtimeMs;
    return {
      workerStatus: age >= 0 && age < 180_000 ? 'healthy' : 'stale',
      workerCheckedAt,
      workerHeartbeatAt: info.mtime.toISOString(),
    };
  } catch {
    return {
      workerStatus: 'unknown',
      workerCheckedAt,
      workerHeartbeatAt: null,
    };
  }
}
