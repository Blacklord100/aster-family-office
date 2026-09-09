import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropTestDatabase } from './database-cleanup';
import type { Pool } from 'pg';

const asAdmin = (query: ReturnType<typeof vi.fn>) => ({ query }) as unknown as Pick<Pool, 'query'>;

describe('isolated database cleanup', () => {
  afterEach(() => vi.useRealTimers());

  it('retries only while PostgreSQL still sees closing fixture connections', async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockRejectedValueOnce({ code: '55006' }).mockRejectedValueOnce({ code: '55006' }).mockResolvedValue(undefined);
    const cleanup = dropTestDatabase(asAdmin(query), 'aster_demo_0123456789abcdef');
    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
    expect(query).toHaveBeenCalledTimes(3);
    for (const [command] of query.mock.calls) expect(command.text).toBe('DROP DATABASE "aster_demo_0123456789abcdef"');
    expect(query.mock.calls.map(([command]) => command.query_timeout)).toEqual([5000, 4950, 4900]);
  });

  it('fails after five seconds without forcing any session to terminate', async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockRejectedValue({ code: '55006' });
    const cleanup = expect(dropTestDatabase(asAdmin(query), 'aster_folder_0123456789abcdef')).rejects.toThrow('five seconds');
    await vi.advanceTimersByTimeAsync(5000);
    await cleanup;
    expect(query.mock.calls.every(([command]) => !command.text.includes('FORCE'))).toBe(true);
  });

  it.each(['42501', '08006', '3D000'])('does not retry SQLSTATE %s', async (code) => {
    const query = vi.fn().mockRejectedValue({ code });
    await expect(dropTestDatabase(asAdmin(query), 'aster_operations_0123456789abcdef')).rejects.toEqual({ code });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each(['aster', 'aster_restore_0123456789abcdef', 'aster_demo_invalid', 'aster_demo_0123456789abcdef";DROP DATABASE aster;--'])(
    'rejects non-fixture database %s before querying', async (name) => {
      const query = vi.fn();
      await expect(dropTestDatabase(asAdmin(query), name)).rejects.toThrow('non-disposable');
      expect(query).not.toHaveBeenCalled();
    },
  );
});
