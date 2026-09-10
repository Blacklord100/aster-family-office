import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(override: Record<string, string>) {
  const folder = mkdtempSync(join(tmpdir(), 'aster-entrypoint-fixture-'));
  const file = join(folder, 'db-password');
  const secret = 'synthetic/@ database password';
  writeFileSync(file, secret, { mode: 0o600 });
  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve('operations/scripts/app-entrypoint.mjs'),
        process.execPath,
        '-e',
        "const u=new URL(process.env.DATABASE_URL);if(u.username!=='aster_runtime'||decodeURIComponent(u.password)!=='synthetic/@ database password')process.exit(8);console.log('configuration accepted')",
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH,
          ASTER_SERVICE: 'folder',
          ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
          DB_PASSWORD_FILE: file,
          ...override,
        },
      },
    );
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain('another-secret');
    return result;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('production secret adapter database identity', () => {
  it('refuses a direct database URL combined with a password-file configuration', () => {
    const result = run({
      DATABASE_URL: 'postgresql://wrong:another-secret@other.invalid/wrong',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('either DATABASE_URL or DB_PASSWORD_FILE');
    expect(result.stdout).toBe('');
  });
  it.each(['MIGRATION_DATABASE_URL', 'BOOTSTRAP_DATABASE_URL'])(
    'refuses a conflicting %s in migration mode',
    (key) => {
      const result = run({
        ASTER_DB_MIGRATION: '1',
        [key]: 'postgresql://wrong:another-secret@other.invalid/wrong',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('one database configuration source');
    },
  );
  it('escapes a password-file URL and accepts one unambiguous runtime configuration', () => {
    const result = run({});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('configuration accepted');
  });
});
