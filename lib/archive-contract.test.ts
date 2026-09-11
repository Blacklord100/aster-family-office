import { describe, expect, it } from 'vitest';
import {
  ArchiveDirectorySchema,
  ArchiveCommandSchema,
} from './archive-contract';
describe('archive configuration boundary', () => {
  it('allows tenant-relative portable folder names and rejects unsafe host or platform paths', () => {
    expect(ArchiveDirectorySchema.parse('Investment records/Originals')).toBe(
      'Investment records/Originals',
    );
    for (const value of [
      '/etc/private',
      '../outside',
      'a/../b',
      '.hidden',
      'a\\b',
      'a//b',
      'a:b',
      'a?b',
      'a\u202Eb',
      Array(10).fill('folder').join('/'),
      'x'.repeat(81),
    ])
      expect(ArchiveDirectorySchema.safeParse(value).success).toBe(false);
  });
  it('requires revision and replay identity for all configuration/backfill/retry writes', () => {
    for (const action of ['configure', 'backfill', 'retry'])
      expect(ArchiveCommandSchema.safeParse({ action }).success).toBe(false);
    expect(
      ArchiveCommandSchema.safeParse({
        action: 'configure',
        expectedRevision: 0,
        idempotencyKey: 'd322c1d1-2352-441c-8773-dfb3ed2d3c97',
        destination: {
          provider: 'dropbox',
          directory: 'Documents',
          label: 'Archive',
          enabled: true,
        },
      }).success,
    ).toBe(false);
  });
});
