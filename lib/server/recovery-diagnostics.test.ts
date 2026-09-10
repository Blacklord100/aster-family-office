import { describe, expect, it } from 'vitest';
import { recoveryFailureSummary } from '../../operations/scripts/recovery-diagnostics.mjs';

describe('recovery failure diagnostics', () => {
  it('identifies only the script-owned stage/table and SQLSTATE', () => {
    const output = recoveryFailureSummary('record-restore', 'app_jobs', {
      code: '23503',
      message: 'private account secret',
      detail: 'private client row',
      table: 'another private table',
      constraint: 'private document filename',
      connection: 'postgres://secret',
    });
    expect(output).toBe(
      'Native recovery drill failed at record-restore (table app_jobs) [SQLSTATE 23503]; credentials and record contents suppressed.',
    );
  });
  it('suppresses arbitrary failure payloads and malformed identifiers', () => {
    expect(
      recoveryFailureSummary('secret\nrow', 'private-account', {
        code: 'password=secret',
      }),
    ).toBe(
      'Native recovery drill failed at unknown; credentials and record contents suppressed.',
    );
    expect(
      recoveryFailureSummary('configuration', null, new Error('secret')),
    ).toBe(
      'Native recovery drill failed at configuration; credentials and record contents suppressed.',
    );
  });
});
