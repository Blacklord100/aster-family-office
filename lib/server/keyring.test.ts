import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, encryptionKeyId, signAudit } from './crypto';
describe('versioned encryption', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('ENCRYPTION_KEYRING', '');
    vi.stubEnv('ENCRYPTION_ACTIVE_KEY_ID', 'legacy');
  });
  afterEach(() => vi.unstubAllEnvs());
  it('reads old records after rotation and authenticates new key IDs/context', () => {
    const old = encrypt('source', 'doc:one'),
      audit = signAudit('preserved audit');
    vi.stubEnv(
      'ENCRYPTION_KEYRING',
      JSON.stringify({ quarter2: randomBytes(32).toString('base64') }),
    );
    vi.stubEnv('ENCRYPTION_ACTIVE_KEY_ID', 'quarter2');
    const next = encrypt('source', 'doc:one');
    expect(encryptionKeyId(next)).toBe('quarter2');
    expect(decrypt(old, 'doc:one').toString()).toBe('source');
    expect(decrypt(next, 'doc:one').toString()).toBe('source');
    expect(signAudit('preserved audit')).toBe(audit);
    expect(() => decrypt(next, 'doc:other')).toThrow();
    next[2] ^= 1;
    expect(() => decrypt(next, 'doc:one')).toThrow();
  });
  it('refuses missing active keys and authenticates empty values', () => {
    expect(decrypt(encrypt('', 'empty'), 'empty').length).toBe(0);
    vi.stubEnv('ENCRYPTION_ACTIVE_KEY_ID', 'missing');
    expect(() => encrypt('x', 'ctx')).toThrow();
  });
  it('refuses a rotated record whose key is removed', () => {
    vi.stubEnv(
      'ENCRYPTION_KEYRING',
      JSON.stringify({ key2: randomBytes(32).toString('base64') }),
    );
    vi.stubEnv('ENCRYPTION_ACTIVE_KEY_ID', 'key2');
    const data = encrypt('x', 'ctx');
    vi.stubEnv('ENCRYPTION_KEYRING', '');
    expect(() => decrypt(data, 'ctx')).toThrow();
  });
});
