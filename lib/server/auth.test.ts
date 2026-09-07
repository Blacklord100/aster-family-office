import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./db', () => ({ pool: {}, assertDatabaseRole: vi.fn() }));
import { authEnvironment, mfaRequired, passwordPolicyError } from './auth';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authentication configuration', () => {
  it('cannot disable MFA policy in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_REQUIRE_MFA', 'false');
    expect(mfaRequired()).toBe(true);
  });
  it('rejects absent or predictable secrets, including development', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    expect(() => authEnvironment()).toThrow('BETTER_AUTH_SECRET');
    vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(64));
    expect(() => authEnvironment()).toThrow('BETTER_AUTH_SECRET');
  });
  it.each([
    'REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS',
    '  replace-with-at-least-32-random-characters  ',
    'CHANGE_ME_TO_A_RANDOM_32_CHARACTER_SECRET',
    'CHANGEME_TO_A_RANDOM_32_CHARACTER_SECRET',
    'TODO_GENERATE_AT_LEAST_32_RANDOM_CHARACTERS',
    'better-auth-secret-12345678901234567890',
    '  BETTER-AUTH-SECRET-12345678901234567890  ',
  ])('rejects copied example and library default secret %j', (secret) => {
    vi.stubEnv('BETTER_AUTH_SECRET', secret);
    vi.stubEnv('BETTER_AUTH_URL', 'https://aster.example.com');
    expect(() => authEnvironment()).toThrow('example or default');
  });
  it('requires HTTPS production origin and forbids URL credentials/paths', () => {
    vi.stubEnv(
      'BETTER_AUTH_SECRET',
      'A-test-only-secret-with-enough-distinct-characters-932574',
    );
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BETTER_AUTH_URL', 'http://aster.example.com');
    expect(() => authEnvironment()).toThrow('HTTPS');
    vi.stubEnv('BETTER_AUTH_URL', 'https://user:password@aster.example.com');
    expect(() => authEnvironment()).toThrow('origin');
    vi.stubEnv('BETTER_AUTH_URL', 'https://aster.example.com/subpath');
    expect(() => authEnvironment()).toThrow('origin');
    vi.stubEnv('BETTER_AUTH_URL', 'https://aster.example.com');
    expect(authEnvironment()).toMatchObject({
      secure: true,
      origin: 'https://aster.example.com',
    });
  });
  it.each(['short', 'x'.repeat(30), 'Password123456789!', 'a'.repeat(129)])(
    'rejects weak or oversized passwords',
    (password) => {
      expect(passwordPolicyError(password)).toBeTruthy();
    },
  );
  it('supports long passphrases without arbitrary symbol requirements', () => {
    expect(
      passwordPolicyError('Moonlit apricots cross seven rivers'),
    ).toBeNull();
  });
});
