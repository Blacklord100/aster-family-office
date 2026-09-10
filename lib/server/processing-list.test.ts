import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
vi.mock('server-only', () => ({}));
const f = vi.hoisted(() => ({
  organizationId: '00000000-0000-4000-8000-000000000010',
  query: vi.fn(),
  decrypt: vi.fn(),
  scope: null as null | { familyIds: string[]; entityIds: string[] },
  denied: false,
}));
vi.mock('./db', () => ({
  withTenant: async (
    org: string,
    run: (client: unknown) => unknown,
    options: unknown,
  ) => {
    expect(org).toBe(f.organizationId);
    expect(options).toEqual({ readOnlySnapshot: true });
    return run({ query: f.query });
  },
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
    assertSameOrigin: vi.fn(),
    requireWorkspace: async () => {
      if (f.denied)
        throw new AccessError(
          403,
          'MFA_REQUIRED',
          'Verify your authenticator.',
        );
      return {
        organizationId: f.organizationId,
        role: 'owner',
        scope: f.scope,
        user: { id: 'reviewer' },
      };
    },
    errorResponse: (error: AccessError) =>
      Response.json({ error: error.code }, { status: error.status ?? 500 }),
  };
});
vi.mock('./crypto', async () => ({
  ...(await vi.importActual<typeof import('./crypto')>('./crypto')),
  decrypt: f.decrypt,
}));
vi.mock('./audit', () => ({ audit: vi.fn() }));
vi.mock('./engine-store', () => ({
  activeEngine: async () => ({
    snapshot: {
      profileId: null,
      revision: 0,
      name: 'Deployment default',
      provider: 'ollama',
      model: 'fixture-local',
      execution: 'local',
    },
  }),
}));
import { GET } from '../../app/api/processing/route';
import { PROCESSING_SUMMARY_BYTE_BUDGET } from './processing-metadata';

const id = (n: number) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function extraction(documentId: string) {
  return {
    schemaVersion: 1,
    documentId,
    mode: 'workflow',
    execution: 'local',
    documentType: 'statement',
    relevant: true,
    confidence: 0.9,
    facts: [
      {
        kind: 'valuation',
        investmentName: 'Reviewed Fund',
        effectiveDate: '2026-09-08',
        amount: '1000',
        currency: 'EUR',
        dueDate: null,
        summary: 'Private fact detail',
        evidence: { page: 1, quote: 'Secret original evidence' },
      },
    ],
    warnings: [],
    trace: [
      {
        stage: 'source',
        status: 'done',
        detail: 'Private source for ' + documentId,
      },
    ],
    model: null,
  };
}
function job(n: number) {
  return {
    id: id(n),
    document_id: id(n),
    mode: 'workflow',
    status: 'awaiting_review',
    created_at: '2026-09-08T00:00:00Z',
    updated_at: '2026-09-09T00:00:00Z',
    policy_revision: 1,
    error_code: null,
    filename: `source-${n}.txt`,
    has_result: true,
    payload_bytes: 1000,
    review_revision: 0,
    available_at: null,
  };
}
let records: ReturnType<typeof job>[];
let invalidCiphertext: Set<string>;
let oversizedAfterSelection: Set<string>;
let audits: unknown[];
function search(recordsToFilter: typeof records, q: string) {
  return recordsToFilter.filter((row) =>
    row.filename.toLowerCase().includes(q.toLowerCase()),
  );
}
beforeEach(() => {
  f.query.mockReset();
  f.decrypt.mockReset();
  f.scope = null;
  f.denied = false;
  records = [job(1), job(2)];
  invalidCiphertext = new Set();
  oversizedAfterSelection = new Set();
  audits = [];
  f.query.mockImplementation(async (sql: string, values: unknown[]) => {
    expect(sql).not.toMatch(/d\.payload/);
    if (sql.startsWith('SELECT processing_mode'))
      return { rows: [{ processing_mode: 'workflow', policy_revision: 1 }] };
    expect(values[0]).toBe(f.organizationId);
    if (sql.startsWith('SELECT j.status,count')) {
      const counts = new Map<string, number>();
      for (const row of search(records, values[1] as string))
        counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      return {
        rows: [...counts].map(([status, count]) => ({
          status,
          count: String(count),
        })),
      };
    }
    if (sql.startsWith('SELECT j.id,')) {
      if (sql.includes('AND j.id=$2'))
        return { rows: records.filter((row) => row.id === values[1]) };
      const statuses = values[2] as string[] | null;
      return {
        rows: search(records, values[1] as string)
          .filter((row) => !statuses || statuses.includes(row.status))
          .slice(
            values[4] as number,
            (values[4] as number) + (values[3] as number),
          ),
      };
    }
    if (sql.startsWith('WITH sized'))
      return {
        rows: records
          .filter((row) => (values[1] as string[]).includes(row.id))
          .map((row) => ({
            id: row.id,
            status: row.status,
            review_revision: row.review_revision,
            result: oversizedAfterSelection.has(row.id)
              ? null
              : Buffer.from(row.id),
            review_state: row.review_revision
              ? Buffer.from('review:' + row.id)
              : null,
          })),
      };
    if (sql.startsWith('SELECT DISTINCT ON(resource_id,action)'))
      return { rows: audits };
    if (sql.startsWith('SELECT d.id,')) return { rows: [] };
    if (sql.startsWith('SELECT CASE WHEN octet_length(payload)'))
      return { rows: [] };
    throw new Error('Unexpected SQL');
  });
  f.decrypt.mockImplementation((bytes: Buffer, context: string) => {
    const value = bytes.toString();
    if (invalidCiphertext.has(value)) throw new Error('AUTHENTICATION_FAILED');
    if (value.startsWith('review:')) {
      const selected = value.slice(7);
      expect(context).toBe('review:' + f.organizationId + ':' + selected);
      return Buffer.from(
        JSON.stringify({
          revision: 1,
          extractionHash: createHash('sha256')
            .update(JSON.stringify(extraction(selected)))
            .digest('hex'),
          facts: [
            {
              factIndex: 0,
              status: 'accepted',
              holdingId: 'holding',
              evidenceVerified: true,
            },
          ],
          history: [],
        }),
      );
    }
    expect(context).toBe('result:' + f.organizationId + ':' + value);
    return Buffer.from(JSON.stringify(extraction(value)));
  });
});
async function get(query = '') {
  const response = await GET(
    new Request('http://localhost/api/processing' + query),
  );
  return { status: response.status, body: await response.json() };
}

describe('bounded processing pipeline list', () => {
  it('summarizes the page in one batch while retaining private extraction details only for the selected job', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.jobs[0].result.documentId).toBe(id(1));
    expect(body.jobs[1].result).toBeNull();
    expect(body.jobs[1].review).toBeNull();
    expect(body.jobs[1].summary).toMatchObject({
      availability: 'available',
      extractedCount: 1,
      pendingCount: 1,
      remainingCount: 1,
      investmentNames: ['Reviewed Fund'],
    });
    expect(JSON.stringify(body.jobs[1])).not.toMatch(
      /Secret original evidence|Private fact detail|Private source for/,
    );
    expect(
      f.query.mock.calls.filter(([sql]) => sql.startsWith('WITH sized')),
    ).toHaveLength(1);
    expect(f.decrypt).toHaveBeenCalledTimes(2);
  });
  it('loads an older-than-100 deep link without changing the current page, count, or filters', async () => {
    records = Array.from({ length: 151 }, (_, index) => job(index + 1));
    const { status, body } = await get('?limit=50&offset=100&jobId=' + id(1));
    expect(status).toBe(200);
    expect(body.page).toMatchObject({
      total: 151,
      offset: 100,
      hasMore: true,
      nextOffset: 150,
    });
    expect(body.page.jobIds).toHaveLength(50);
    expect(body.page.jobIds[0]).toBe(id(101));
    expect(body.jobs).toHaveLength(51);
    expect(
      body.jobs.find((row: { id: string }) => row.id === id(1)).result,
    ).not.toBeNull();
    expect(
      body.jobs.filter((row: { result: unknown }) => row.result !== null),
    ).toHaveLength(1);
    const last = await get('?limit=50&offset=150');
    expect(last.body.page).toMatchObject({
      total: 151,
      hasMore: false,
      nextOffset: null,
      jobIds: [id(151)],
    });
  });
  it('counts the complete filename search independently of exact and grouped stage filters', async () => {
    records = [job(1), job(2), job(3), job(4)];
    records[0].status = 'processing';
    records[1].status = 'queued';
    records[2].status = 'failed';
    records[3].filename = 'unrelated.pdf';
    const { body } = await get('?q=source-&status=working');
    expect(body.page.total).toBe(2);
    expect(body.page.statusCounts).toMatchObject({
      processing: 1,
      queued: 1,
      failed: 1,
      awaiting_review: 0,
    });
    expect(body.page.jobIds).toEqual([id(1), id(2)]);
    expect((await get('?q=%25')).body.page.total).toBe(0); // literal %, not an SQL wildcard
  });
  it('returns unknown counts for unprocessed and oversized ciphertexts, never a misleading zero', async () => {
    records[0].has_result = false;
    records[0].status = 'queued';
    records[1].payload_bytes = PROCESSING_SUMMARY_BYTE_BUDGET + 1;
    const { body } = await get();
    expect(body.jobs[0].summary).toMatchObject({
      availability: 'not_extracted',
      extractedCount: null,
      remainingCount: null,
    });
    expect(body.jobs[1].summary).toMatchObject({
      availability: 'size_limit',
      extractedCount: null,
    });
    expect(f.decrypt).not.toHaveBeenCalled();
  });
  it('enforces the ciphertext budget again in SQL if a review grows after the metadata read', async () => {
    oversizedAfterSelection.add(id(2));
    const { body } = await get();
    expect(body.jobs[1].summary.availability).toBe('size_limit');
    const [sql, args] = f.query.mock.calls.find(([query]) =>
      query.startsWith('WITH sized'),
    )!;
    expect(sql).toContain('CASE WHEN running_bytes<=$3');
    expect(args[2]).toBe(PROCESSING_SUMMARY_BYTE_BUDGET);
  });
  it('retains per-fact review counts rather than treating an accepted job as newly pending', async () => {
    records[1].review_revision = 1;
    records[1].status = 'accepted';
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.jobs[1].summary).toMatchObject({
      acceptedCount: 1,
      pendingCount: 0,
      remainingCount: 0,
      legacyCount: 0,
    });
  });
  it('isolates an unreadable unselected summary but fails closed for the selected review', async () => {
    invalidCiphertext.add(id(2));
    expect((await get()).body.jobs[1].summary.availability).toBe('unavailable');
    expect((await get('?jobId=' + id(2))).status).toBe(500);
  });
  it('does not infer historical processing time from timestamps changed by review', async () => {
    audits = [
      {
        resource_id: id(1),
        action: 'processing.completed',
        sequence: '1',
        created_at: '2026-09-08T00:02:00Z',
        attempt_id: null,
        duration_ms: null,
      },
    ];
    const { body } = await get();
    expect(body.jobs[0].timing).toMatchObject({
      startedAt: null,
      completedAt: '2026-09-08T00:02:00.000Z',
      processingDurationMs: null,
    });
  });
  it('rejects invalid filters and unknown selected records', async () => {
    for (const query of [
      '?jobId=not-a-uuid',
      '?limit=51',
      '?offset=-1',
      '?offset=100001',
      '?status=imaginary',
      '?q=' + 'x'.repeat(201),
    ])
      expect((await get(query)).status).toBe(400);
    expect(f.query).not.toHaveBeenCalled();
    expect((await get('?jobId=' + id(999))).status).toBe(404);
    expect(f.decrypt).not.toHaveBeenCalled();
  });
  it('preserves MFA enforcement and rejects family-scoped staff queue access before reading records', async () => {
    f.denied = true;
    expect((await get()).status).toBe(403);
    expect(f.query).not.toHaveBeenCalled();
    f.denied = false;
    f.scope = { familyIds: ['other-family'], entityIds: [] };
    expect((await get()).body.error).toBe('SCOPED_ACCESS');
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(
      f.query.mock.calls.some(([sql]) => sql.includes('FROM app_jobs')),
    ).toBe(false);
  });
});
