import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  organizationId: '00000000-0000-4000-8000-000000000010',
  ids: [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ],
  query: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock('./db', () => ({
  withTenant: async (
    organizationId: string,
    run: (client: { query: typeof fixtures.query }) => unknown,
  ) => {
    if (organizationId !== fixtures.organizationId)
      throw new Error('Unexpected tenant');
    return run({ query: fixtures.query });
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
    requireWorkspace: async () => ({
      organizationId: fixtures.organizationId,
      role: 'owner',
      user: { id: 'reviewer' },
    }),
    errorResponse: (error: AccessError) =>
      Response.json({ error: error.code }, { status: error.status ?? 500 }),
  };
});
vi.mock('./crypto', () => ({ decrypt: fixtures.decrypt }));
vi.mock('./audit', () => ({ audit: vi.fn() }));
import { GET } from '../../app/api/processing/route';

function extraction(id: string) {
  return {
    schemaVersion: 1,
    documentId: id,
    mode: 'workflow',
    execution: 'local',
    documentType: 'statement',
    relevant: true,
    confidence: 0.5,
    facts: [],
    warnings: [],
    trace: [
      { stage: 'source', status: 'done', detail: 'Private source for ' + id },
    ],
    model: null,
  };
}
describe('processing list result minimization', () => {
  beforeEach(() => {
    fixtures.query.mockReset();
    fixtures.decrypt.mockReset();
    fixtures.query.mockImplementation(async (sql: string, values: string[]) => {
      if (sql.includes('SELECT processing_mode'))
        return { rows: [{ processing_mode: 'workflow', policy_revision: 1 }] };
      if (sql.includes('JOIN app_documents'))
        return {
          rows: fixtures.ids.map((id) => ({
            id,
            document_id: id,
            mode: 'workflow',
            status: 'awaiting_review',
            created_at: '2026-09-08T00:00:00Z',
            updated_at: '2026-09-08T00:00:00Z',
            policy_revision: 1,
            error_code: null,
            filename: id + '.txt',
            result: Buffer.from(id),
          })),
        };
      if (sql.startsWith('SELECT result FROM app_jobs')) {
        expect(values[1]).toBe(fixtures.organizationId);
        return { rows: [{ result: Buffer.from(values[0]) }] };
      }
      throw new Error('Unexpected query');
    });
    fixtures.decrypt.mockImplementation((bytes: Buffer, context: string) => {
      expect(context).toBe(
        'result:' + fixtures.organizationId + ':' + bytes.toString(),
      );
      return Buffer.from(JSON.stringify(extraction(bytes.toString())));
    });
  });
  it('returns one extraction by default and no unselected private trace', async () => {
    const response = await GET(new Request('http://localhost/api/processing'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobs[0].result.documentId).toBe(fixtures.ids[0]);
    expect(body.jobs[1].result).toBeNull();
    expect(fixtures.decrypt).toHaveBeenCalledTimes(1);
  });
  it('loads the selected recent job while omitting the other extraction', async () => {
    const response = await GET(
      new Request('http://localhost/api/processing?jobId=' + fixtures.ids[1]),
    );
    const body = await response.json();
    expect(body.jobs[0].result).toBeNull();
    expect(body.jobs[1].result.documentId).toBe(fixtures.ids[1]);
    expect(fixtures.decrypt).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed selectors before querying and never fetches an unknown tenant job', async () => {
    expect(
      (await GET(new Request('http://localhost/api/processing?jobId=invalid')))
        .status,
    ).toBe(400);
    expect(fixtures.query).not.toHaveBeenCalled();
    await GET(
      new Request(
        'http://localhost/api/processing?jobId=00000000-0000-4000-8000-000000000099',
      ),
    );
    expect(fixtures.query).toHaveBeenLastCalledWith(
      expect.stringContaining('SELECT result FROM app_jobs'),
      [fixtures.ids[0], fixtures.organizationId],
    );
  });
});
