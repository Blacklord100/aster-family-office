import { describe, expect, it } from 'vitest';
import { assertDisposableDatabase } from './disposable-database';
const fixture = {
  ASTER_DISPOSABLE_INTEGRATION: '1',
  DATABASE_URL:
    'postgresql://runtime:private@127.0.0.1:55440/aster_fixture_1234567890abcdef',
  MIGRATION_DATABASE_URL:
    'postgresql://admin:private@127.0.0.1:55440/aster_fixture_1234567890abcdef',
};
describe('positive disposable integration target guard', () => {
  it('allows only an explicitly marked matching generated database', () => {
    expect(assertDisposableDatabase(fixture).runtime.port).toBe('55440');
    expect(() =>
      assertDisposableDatabase({
        ...fixture,
        ASTER_DISPOSABLE_INTEGRATION: undefined,
      }),
    ).toThrow(/Refusing/);
  });
  it('refuses the actual development port even with a disposable marker', () => {
    expect(() =>
      assertDisposableDatabase(
        Object.fromEntries(
          Object.entries(fixture).map(([k, v]) => [
            k,
            v.replace('55440', '55439'),
          ]),
        ),
      ),
    ).toThrow(/Refusing/);
  });
  it('refuses mismatched, remote, ambiguous and unmarked targets without printing URLs', () => {
    for (const replacement of [
      '@localhost:',
      '@example.com:',
      ':55441/',
      '/aster',
      '/aster_fixture_1234567890abcdef?host=other',
    ]) {
      const changed = replacement.startsWith('@')
        ? fixture.DATABASE_URL.replace('@127.0.0.1:', replacement)
        : replacement.startsWith(':')
          ? fixture.DATABASE_URL.replace(':55440/', replacement)
          : fixture.DATABASE_URL.replace(
              '/aster_fixture_1234567890abcdef',
              replacement,
            );
      expect(() =>
        assertDisposableDatabase({ ...fixture, DATABASE_URL: changed }),
      ).toThrow(/Refusing/);
    }
  });
  it('requires known synthetic credentials even when CI is set', () => {
    const ci = {
      CI: 'true',
      DATABASE_URL:
        'postgresql://aster_runtime:synthetic-ci-runtime-only@127.0.0.1:55439/aster',
      MIGRATION_DATABASE_URL:
        'postgresql://postgres:synthetic-ci-database-only@127.0.0.1:55439/aster',
    };
    expect(assertDisposableDatabase(ci).runtime.pathname).toBe('/aster');
    expect(() =>
      assertDisposableDatabase({
        ...ci,
        DATABASE_URL: ci.DATABASE_URL.replace(
          'synthetic-ci-runtime-only',
          'real-secret',
        ),
      }),
    ).toThrow(/Refusing/);
  });
});
