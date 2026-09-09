// Use this only with a dedicated pg.Client: its end() waits for the socket's
// close event. Pool.end() can finish while an idle client is still disconnecting.
export async function closeRestoreDatabase(connection, source, databaseName) {
  if (!/^aster_restore_[a-f0-9]{16}$/.test(databaseName))
    throw new Error('Only a generated disposable recovery database may be removed');
  if (connection) await connection.end();
  // No FORCE: an unexpected remaining connection must fail cleanup visibly.
  await source.query('DROP DATABASE "' + databaseName + '"');
}
