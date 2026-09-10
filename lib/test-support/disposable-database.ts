/** Test-only positive target guard. Never point integration fixtures at a
 * development database merely because it happens to be on localhost. */
export function assertDisposableDatabase(
  environment: Record<string, string | undefined> = process.env,
): { runtime: URL; admin: URL } {
  let runtime: URL, admin: URL;
  try {
    runtime = new URL(environment.DATABASE_URL ?? '');
    admin = new URL(environment.MIGRATION_DATABASE_URL ?? '');
  } catch {
    throw new Error('Explicit disposable database URLs are required.');
  }
  const sameTarget =
    [runtime, admin].every(
      (url) =>
        ['postgres:', 'postgresql:'].includes(url.protocol) &&
        url.hostname === '127.0.0.1' &&
        !!url.port &&
        !url.search &&
        !url.hash,
    ) &&
    runtime.port === admin.port &&
    runtime.pathname === admin.pathname;
  const ephemeral =
    environment.ASTER_DISPOSABLE_INTEGRATION === '1' &&
    runtime.port !== '55439' &&
    /^\/aster_fixture_[a-f0-9]{16}$/.test(runtime.pathname);
  const ci =
    environment.CI === 'true' &&
    runtime.port === '55439' &&
    runtime.pathname === '/aster' &&
    runtime.username === 'aster_runtime' &&
    runtime.password === 'synthetic-ci-runtime-only' &&
    admin.username === 'postgres' &&
    admin.password === 'synthetic-ci-database-only';
  if (!sameTarget || (!ephemeral && !ci))
    throw new Error(
      'Refusing a non-disposable integration database. Use an isolated generated fixture or the explicit CI fixture.',
    );
  return { runtime, admin };
}
