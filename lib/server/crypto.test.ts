import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, signAudit } from './crypto';
import { ExtractionSchema } from '../processing-contract';
import { factFingerprint } from './accept-facts';
vi.mock('server-only', () => ({}));
describe('encrypted records and canonical facts', () => {
  beforeEach(() =>
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64')),
  );
  it('binds randomized encryption to tenant and record', () => {
    const a = encrypt('private statement', 'document:orgA:one'),
      b = encrypt('private statement', 'document:orgA:one');
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, 'document:orgA:one').toString()).toBe(
      'private statement',
    );
    expect(() => decrypt(a, 'document:orgB:one')).toThrow();
    expect(() => decrypt(a, 'document:orgA:two')).toThrow();
    a[a.length - 1] ^= 1;
    expect(() => decrypt(a, 'document:orgA:one')).toThrow();
  });
  it('fails without a key and authenticates audit payloads', () => {
    expect(signAudit('a')).not.toBe(signAudit('b'));
    vi.stubEnv('ENCRYPTION_KEY', '');
    expect(() => encrypt('value', 'org')).toThrow();
  });
  it('deduplicates numerical representations across engines but preserves corrections', () => {
    const fact = {
      kind: 'valuation' as const,
      investmentName: 'Cedar',
      amount: '100.00',
      currency: 'EUR',
      effectiveDate: '2026-08-31',
      dueDate: null,
      summary: 'NAV',
      evidence: { page: 1, quote: 'NAV EUR100' },
    };
    expect(factFingerprint(fact, 'h')).toBe(
      factFingerprint(
        { ...fact, amount: '100', summary: 'Different model wording' },
        'h',
      ),
    );
    expect(factFingerprint(fact, 'h')).not.toBe(
      factFingerprint({ ...fact, amount: '101' }, 'h'),
    );
    expect(factFingerprint(fact, 'h')).not.toBe(factFingerprint(fact, 'other'));
  });
  it('rejects invalid dates without crashing and forbids remote output', () => {
    const base = {
      schemaVersion: 1,
      documentId: crypto.randomUUID(),
      mode: 'workflow',
      execution: 'local',
      documentType: 'statement',
      relevant: true,
      confidence: 0.9,
      facts: [
        {
          kind: 'valuation',
          investmentName: 'Test',
          effectiveDate: '2026-99-40',
          amount: '1',
          currency: 'EUR',
          dueDate: null,
          summary: '',
          evidence: { page: 1, quote: 'NAV1' },
        },
      ],
      warnings: [],
      trace: [],
      model: null,
    };
    expect(ExtractionSchema.safeParse(base).success).toBe(false);
    expect(
      ExtractionSchema.safeParse({ ...base, facts: [], execution: 'cloud' })
        .success,
    ).toBe(false);
  });
});
