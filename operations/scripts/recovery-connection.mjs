/** Explicit development recovery or a positively identified disposable fixture.
 * @param {Record<string, string | undefined>} environment
 */
export function nativeRecoverySource(environment = process.env) {
  if (environment.ASTER_NATIVE_RECOVERY_DRILL !== '1')
    throw new Error('Explicit drill opt-in is required');
  let source;
  try {
    source = new URL(environment.MIGRATION_DATABASE_URL ?? '');
  } catch {
    throw new Error('Explicit recovery database URL required');
  }
  const valid = (url) =>
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
    !url.search &&
    !url.hash;
  if (environment.ASTER_DISPOSABLE_INTEGRATION === '1') {
    let runtime;
    try {
      runtime = new URL(environment.DATABASE_URL ?? '');
    } catch {
      throw new Error('Explicit disposable database URLs required');
    }
    if (
      !valid(source) ||
      !valid(runtime) ||
      source.hostname !== '127.0.0.1' ||
      runtime.hostname !== '127.0.0.1' ||
      !source.port ||
      source.port === '55439' ||
      source.port !== runtime.port ||
      source.pathname !== runtime.pathname ||
      !/^\/aster_fixture_[a-f0-9]{16}$/.test(source.pathname)
    )
      throw new Error('Refusing a non-disposable recovery database');
    return source;
  }
  if (
    !valid(source) ||
    !['127.0.0.1', 'localhost'].includes(source.hostname) ||
    source.port !== '55439' ||
    source.pathname !== '/aster'
  )
    throw new Error(
      'This development drill only targets the isolated local Aster database on 55439',
    );
  return source;
}

// Use this only with a dedicated pg.Client: its end() waits for the socket's
// close event. Pool.end() can finish while an idle client is still disconnecting.
export async function closeRestoreDatabase(connection, source, databaseName) {
  if (!/^aster_restore_[a-f0-9]{16}$/.test(databaseName))
    throw new Error(
      'Only a generated disposable recovery database may be removed',
    );
  if (connection) await connection.end();
  // No FORCE: an unexpected remaining connection must fail cleanup visibly.
  await source.query('DROP DATABASE "' + databaseName + '"');
}
