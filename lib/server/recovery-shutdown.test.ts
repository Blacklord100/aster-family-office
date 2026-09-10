import { describe, expect, it, vi } from 'vitest';
import {
  closeRestoreDatabase,
  nativeRecoverySource,
} from '../../operations/scripts/recovery-connection.mjs';

describe('native recovery source authorization', () => {
  const env = {
    ASTER_NATIVE_RECOVERY_DRILL: '1',
    ASTER_DISPOSABLE_INTEGRATION: '1',
    DATABASE_URL:
      'postgresql://runtime:synthetic@127.0.0.1:59999/aster_fixture_0123456789abcdef',
    MIGRATION_DATABASE_URL:
      'postgresql://postgres:synthetic@127.0.0.1:59999/aster_fixture_0123456789abcdef',
  };
  it('permits a generated isolated database with matching runtime and administrative targets', () => {
    expect(nativeRecoverySource(env).pathname).toBe(
      '/aster_fixture_0123456789abcdef',
    );
  });
  it.each([
    { ASTER_NATIVE_RECOVERY_DRILL: '' },
    {
      DATABASE_URL: env.DATABASE_URL.replace('59999', '55439'),
      MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL.replace(
        '59999',
        '55439',
      ),
    },
    { DATABASE_URL: env.DATABASE_URL.replace('59999', '59998') },
    {
      MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL.replace(
        '127.0.0.1',
        'example.invalid',
      ),
    },
    {
      DATABASE_URL: env.DATABASE_URL.replace(
        'aster_fixture_0123456789abcdef',
        'aster',
      ),
    },
    {
      MIGRATION_DATABASE_URL:
        env.MIGRATION_DATABASE_URL + '?options=-c%20role%3Dpostgres',
    },
  ])(
    'refuses mismatched, live, external or implicit disposable targets',
    (override) => {
      expect(() => nativeRecoverySource({ ...env, ...override })).toThrow();
    },
  );
});

describe('disposable recovery database shutdown', () => {
  it('waits for actual connection closure before issuing a non-forced database drop', async () => {
    let finishClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const connection = { end: vi.fn(() => closed) };
    const source = { query: vi.fn(async () => undefined) };
    const cleanup = closeRestoreDatabase(
      connection,
      source,
      'aster_restore_0123456789abcdef',
    );
    await Promise.resolve();
    expect(connection.end).toHaveBeenCalledOnce();
    expect(source.query).not.toHaveBeenCalled();
    finishClose();
    await cleanup;
    expect(source.query).toHaveBeenCalledExactlyOnceWith(
      'DROP DATABASE "aster_restore_0123456789abcdef"',
    );
  });

  it('fails visibly if the dedicated client cannot close, without killing remaining sessions', async () => {
    const source = { query: vi.fn() };
    await expect(
      closeRestoreDatabase(
        {
          end: async () => {
            throw new Error('close failed');
          },
        },
        source,
        'aster_restore_0123456789abcdef',
      ),
    ).rejects.toThrow('close failed');
    expect(source.query).not.toHaveBeenCalled();
  });

  it.each([
    'aster',
    'aster_restore_other',
    'aster_restore_0123456789abcdef"; DROP DATABASE aster;--',
  ])(
    'refuses a non-generated database name before touching either connection',
    async (name) => {
      const connection = { end: vi.fn() },
        source = { query: vi.fn() };
      await expect(
        closeRestoreDatabase(connection, source, name),
      ).rejects.toThrow('generated disposable');
      expect(connection.end).not.toHaveBeenCalled();
      expect(source.query).not.toHaveBeenCalled();
    },
  );
});
