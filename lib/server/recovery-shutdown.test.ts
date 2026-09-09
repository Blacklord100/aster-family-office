import { describe, expect, it, vi } from 'vitest';
import { closeRestoreDatabase } from '../../operations/scripts/recovery-connection.mjs';

describe('disposable recovery database shutdown', () => {
  it('waits for actual connection closure before issuing a non-forced database drop', async () => {
    let finishClose!: () => void;
    const closed = new Promise<void>((resolve) => { finishClose = resolve; });
    const connection = { end: vi.fn(() => closed) };
    const source = { query: vi.fn(async () => undefined) };
    const cleanup = closeRestoreDatabase(connection, source, 'aster_restore_0123456789abcdef');
    await Promise.resolve();
    expect(connection.end).toHaveBeenCalledOnce();
    expect(source.query).not.toHaveBeenCalled();
    finishClose();
    await cleanup;
    expect(source.query).toHaveBeenCalledExactlyOnceWith('DROP DATABASE "aster_restore_0123456789abcdef"');
  });

  it('fails visibly if the dedicated client cannot close, without killing remaining sessions', async () => {
    const source = { query: vi.fn() };
    await expect(closeRestoreDatabase({ end: async () => { throw new Error('close failed'); } },
      source, 'aster_restore_0123456789abcdef')).rejects.toThrow('close failed');
    expect(source.query).not.toHaveBeenCalled();
  });

  it.each(['aster', 'aster_restore_other', 'aster_restore_0123456789abcdef"; DROP DATABASE aster;--'])(
    'refuses a non-generated database name before touching either connection', async (name) => {
      const connection = { end: vi.fn() }, source = { query: vi.fn() };
      await expect(closeRestoreDatabase(connection, source, name)).rejects.toThrow('generated disposable');
      expect(connection.end).not.toHaveBeenCalled();
      expect(source.query).not.toHaveBeenCalled();
    },
  );
});
