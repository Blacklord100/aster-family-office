/** Only script-owned stage/table identifiers and PostgreSQL's bounded SQLSTATE
 * are diagnostic. Database messages, detail, constraint names and rows may
 * contain credentials or client data and must never be logged here. */
export function recoveryFailureSummary(stage, table, error) {
  const safeStage = /^[a-z-]{1,40}$/.test(stage ?? '') ? stage : 'unknown';
  const safeTable = /^(?:(?:app|auth)_[a-z_]{1,60}|aster_migrations)$/.test(
    table ?? '',
  )
    ? table
    : null;
  const code =
    error && typeof error === 'object' && /^[0-9A-Z]{5}$/.test(error.code ?? '')
      ? error.code
      : null;
  return (
    'Native recovery drill failed at ' +
    safeStage +
    (safeTable ? ' (table ' + safeTable + ')' : '') +
    (code ? ' [SQLSTATE ' + code + ']' : '') +
    '; credentials and record contents suppressed.'
  );
}
