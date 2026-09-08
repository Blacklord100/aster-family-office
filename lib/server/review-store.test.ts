import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Extraction } from '../processing-contract';
import { encrypt, decrypt } from './crypto';

const fixtures = vi.hoisted(() => ({
  job: {} as Record<string, unknown>,
  role: 'analyst',
  opened: true,
  posted: vi.fn(),
  versions: [] as unknown[],
  tail: Promise.resolve(),
}));
vi.mock('./access', () => {
  class AccessError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AccessError,
    requireWorkspace: async () => {
      if (fixtures.role === 'viewer')
        throw new AccessError(403, 'FORBIDDEN', 'Read only');
      return {
        organizationId: '00000000-0000-4000-8000-000000000010',
        user: { id: 'reviewer', name: 'Synthetic reviewer' },
        role: 'analyst',
      };
    },
    errorResponse: (error: Error & { status?: number; code?: string }) =>
      Response.json(
        { error: error.code ?? 'INTERNAL_ERROR', message: error.message },
        { status: error.status ?? 500 },
      ),
  };
});
vi.mock('./audit', () => ({ audit: vi.fn() }));
vi.mock('./accept-facts', () => ({ acceptFacts: fixtures.posted }));
vi.mock('./db', () => ({
  withTenant: async (
    _org: string,
    run: (c: {
      query: (sql: string, values: unknown[]) => Promise<unknown>;
    }) => Promise<unknown>,
  ) => {
    const prior = fixtures.tail;
    let release!: () => void;
    fixtures.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await run({
        query: async (sql, values) => {
          if (sql.includes('FOR UPDATE OF j'))
            return {
              rows: values[0] === fixtures.job.id ? [{ ...fixtures.job }] : [],
            };
          if (sql.includes('SELECT 1 FROM app_audit'))
            return { rows: fixtures.opened ? [{ ok: 1 }] : [] };
          if (sql.startsWith('INSERT INTO app_review_versions')) {
            fixtures.versions.push(values);
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('UPDATE app_jobs SET review_revision')) {
            fixtures.job.review_revision = values[2];
            fixtures.job.review_state = values[3];
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('UPDATE app_jobs SET status')) {
            fixtures.job.status = values[1];
            return { rows: [], rowCount: 1 };
          }
          throw new Error('Unexpected SQL: ' + sql);
        },
      });
    } finally {
      release();
    }
  },
}));
import { PATCH } from '../../app/api/processing/[id]/route';
import { readReview } from './review-store';

const organizationId = '00000000-0000-4000-8000-000000000010';
const id = '00000000-0000-4000-8000-000000000011';
const extraction: Extraction = {
  schemaVersion: 1,
  documentId: '00000000-0000-4000-8000-000000000012',
  mode: 'workflow',
  execution: 'local',
  documentType: 'statement',
  relevant: true,
  confidence: 0.8,
  warnings: [],
  trace: [],
  model: null,
  facts: [0, 1].map((index) => ({
    kind: 'valuation',
    investmentName: 'Synthetic fund ' + index,
    effectiveDate: '2026-06-30',
    dueDate: null,
    amount: '100.00',
    currency: 'EUR',
    summary: 'Synthetic fixture',
    evidence: { page: 1, quote: 'NAV EUR 100.00' },
  })),
};
const decision = (factIndex: number, status = 'accepted') => ({
  factIndex,
  status,
  holdingId: 'holding-' + factIndex,
  rationale: status === 'accepted' ? '' : 'Check missing source details.',
  evidenceVerified: status === 'accepted',
});
const call = (body: unknown) =>
  PATCH(
    new Request('http://localhost/api/processing/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
const state = () =>
  readReview(
    fixtures.job as Parameters<typeof readReview>[0],
    organizationId,
    extraction,
  );

describe('persisted document review transitions', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    fixtures.role = 'analyst';
    fixtures.opened = true;
    fixtures.versions = [];
    fixtures.tail = Promise.resolve();
    fixtures.job = {
      id,
      document_id: extraction.documentId,
      filename: 'synthetic.pdf',
      mode: 'workflow',
      status: 'awaiting_review',
      result: encrypt(
        JSON.stringify(extraction),
        'result:' + organizationId + ':' + id,
      ),
      review_revision: 0,
      review_state: null,
    };
    fixtures.posted.mockReset();
    fixtures.posted.mockImplementation(
      async (_c, _ctx, _job, _result, selections) => ({
        applied: selections.length,
        duplicates: 0,
        sources: Object.fromEntries(
          selections.map((s: { factIndex: number }) => [
            s.factIndex,
            'source-' + s.factIndex,
          ]),
        ),
      }),
    );
  });
  it('accepts a subset while preserving untouched facts as pending and the original extraction', async () => {
    const original = Buffer.from(fixtures.job.result as Buffer);
    const response = await call({
      action: 'review',
      expectedRevision: 0,
      decisions: [decision(0)],
    });
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('awaiting_review');
    expect(state().facts.map((fact) => fact.status)).toEqual([
      'accepted',
      'pending',
    ]);
    expect(fixtures.job.result).toEqual(original);
    expect(fixtures.versions).toHaveLength(1);
    expect(state().facts[0].sourceId).toBe('source-0');
  });
  it('retains legacy acceptance request compatibility without closing remaining facts', async () => {
    expect(
      (
        await call({
          action: 'accept',
          selections: [{ factIndex: 0, holdingId: 'holding-0' }],
        })
      ).status,
    ).toBe(200);
    expect(fixtures.job.status).toBe('awaiting_review');
    expect(state().facts[1].status).toBe('pending');
  });
  it('serializes concurrent reviewers and rejects the stale revision before another posting', async () => {
    const responses = await Promise.all([
      call({ action: 'review', expectedRevision: 0, decisions: [decision(0)] }),
      call({ action: 'review', expectedRevision: 0, decisions: [decision(1)] }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 409]);
    expect(fixtures.posted).toHaveBeenCalledTimes(1);
    expect((await responses[1].json()).error).toBe('REVIEW_CONFLICT');
    expect(
      (
        await call({
          action: 'review',
          expectedRevision: 1,
          decisions: [decision(1)],
        })
      ).status,
    ).toBe(200);
    expect(fixtures.job.status).toBe('accepted');
  });
  it('safely rejects a retried mutation and does not post twice', async () => {
    const body = {
      action: 'review',
      expectedRevision: 0,
      decisions: [decision(0)],
    };
    await call(body);
    expect((await call(body)).status).toBe(409);
    expect(fixtures.posted).toHaveBeenCalledTimes(1);
  });
  it('keeps deferred facts open and persists rejected and reopened decisions separately', async () => {
    await call({
      action: 'review',
      expectedRevision: 0,
      decisions: [decision(0, 'deferred'), decision(1, 'rejected')],
    });
    expect(fixtures.job.status).toBe('awaiting_review');
    expect(state().facts.map((fact) => fact.status)).toEqual([
      'deferred',
      'rejected',
    ]);
    await call({
      action: 'review',
      expectedRevision: 1,
      decisions: [decision(1, 'pending')],
    });
    expect(state().facts.map((fact) => fact.status)).toEqual([
      'deferred',
      'pending',
    ]);
    expect(fixtures.posted).not.toHaveBeenCalled();
  });
  it('requires rationale for amendments and source verification for acceptance', async () => {
    expect(
      (
        await call({
          action: 'review',
          expectedRevision: 0,
          decisions: [
            {
              ...decision(0),
              amendedFact: { ...extraction.facts[0], amount: '120.00' },
            },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          action: 'review',
          expectedRevision: 0,
          decisions: [{ ...decision(0), evidenceVerified: false }],
        })
      ).status,
    ).toBe(400);
    fixtures.opened = false;
    const response = await call({
      action: 'review',
      expectedRevision: 0,
      decisions: [decision(0)],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('ORIGINAL_REVIEW_REQUIRED');
    expect(fixtures.posted).not.toHaveBeenCalled();
  });
  it('retains reviewed amendments and an explicit same-date correction version', async () => {
    await call({
      action: 'review',
      expectedRevision: 0,
      decisions: [decision(0)],
    });
    const corrected = {
      ...decision(0),
      amendedFact: { ...extraction.facts[0], amount: '120.00' },
      rationale: 'Corrected value checked on the original.',
      correction: {
        expectedValueEUR: 100,
        reason: 'Updated statement corrects the mark.',
      },
    };
    expect(
      (
        await call({
          action: 'review',
          expectedRevision: 1,
          decisions: [corrected],
        })
      ).status,
    ).toBe(200);
    expect(state().facts[0].amendedFact?.amount).toBe('120.00');
    expect(state().facts[0].version).toBe(2);
    expect(state().history[0].decisions[0].amendedFact).toBeUndefined();
    expect(
      JSON.parse(
        decrypt(
          fixtures.job.result as Buffer,
          'result:' + organizationId + ':' + id,
        ).toString(),
      ).facts[0].amount,
    ).toBe('100.00');
  });
  it('never unaccepts a posted fact or retargets an accepted correction to another holding/date', async () => {
    await call({
      action: 'review',
      expectedRevision: 0,
      decisions: [decision(0)],
    });
    expect(
      (
        await call({
          action: 'review',
          expectedRevision: 1,
          decisions: [decision(0, 'rejected')],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          action: 'review',
          expectedRevision: 1,
          decisions: [
            {
              ...decision(0),
              holdingId: 'holding-1',
              correction: {
                expectedValueEUR: 100,
                reason: 'Wrong ownership target.',
              },
            },
          ],
        })
      ).status,
    ).toBe(409);
    expect(fixtures.posted).toHaveBeenCalledTimes(1);
  });
  it('reject remaining compatibility action preserves accepted facts', async () => {
    await call({
      action: 'review',
      expectedRevision: 0,
      decisions: [decision(0)],
    });
    await call({ action: 'reject' });
    expect(state().facts.map((fact) => fact.status)).toEqual([
      'accepted',
      'rejected',
    ]);
    expect(fixtures.job.status).toBe('accepted');
  });
  it('blocks viewers and prevents retries from replacing a reviewed extraction', async () => {
    fixtures.role = 'viewer';
    expect(
      (
        await call({
          action: 'review',
          expectedRevision: 0,
          decisions: [decision(0)],
        })
      ).status,
    ).toBe(403);
    fixtures.role = 'analyst';
    await call({
      action: 'review',
      expectedRevision: 0,
      decisions: [decision(0)],
    });
    expect((await call({ action: 'retry' })).status).toBe(409);
    expect(fixtures.posted).toHaveBeenCalledTimes(1);
  });
  it('detects a changed extraction against its pinned review digest', async () => {
    await call({
      action: 'review',
      expectedRevision: 0,
      decisions: [decision(0)],
    });
    fixtures.job.result = encrypt(
      JSON.stringify({
        ...extraction,
        facts: [
          { ...extraction.facts[0], amount: '999.00' },
          extraction.facts[1],
        ],
      }),
      'result:' + organizationId + ':' + id,
    );
    const response = await call({
      action: 'review',
      expectedRevision: 1,
      decisions: [decision(1)],
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('REVIEW_SOURCE_CHANGED');
  });
});
