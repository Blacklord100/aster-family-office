import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
vi.mock('server-only', () => ({}));
import { archiveWorkerHealth } from './archive-health';
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
describe('archive worker availability', () => {
  it('reports missing signals as unknown and fresh/old/future signals accurately', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aster-archive-health-'));
    const file = path.join(root, 'heartbeat'),
      env = { ARCHIVE_HEARTBEAT_FILE: file },
      now = Date.now();
    expect((await archiveWorkerHealth(env, now)).workerStatus).toBe('unknown');
    await writeFile(file, String(now), { mode: 0o600 });
    await utimes(file, new Date(now - 1000), new Date(now - 1000));
    expect((await archiveWorkerHealth(env, now)).workerStatus).toBe('healthy');
    expect((await archiveWorkerHealth(env, now + 180_000)).workerStatus).toBe(
      'stale',
    );
    expect((await archiveWorkerHealth(env, now - 10_000)).workerStatus).toBe(
      'stale',
    );
  });
  it('does not treat directories or oversized files as worker heartbeats', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aster-archive-health-'));
    expect(
      (await archiveWorkerHealth({ ARCHIVE_HEARTBEAT_FILE: root }))
        .workerStatus,
    ).toBe('unknown');
    const file = path.join(root, 'unrelated');
    await writeFile(file, 'x'.repeat(100));
    expect(
      (await archiveWorkerHealth({ ARCHIVE_HEARTBEAT_FILE: file }))
        .workerHeartbeatAt,
    ).toBeNull();
  });
});
