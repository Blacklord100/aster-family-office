import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Extraction } from '../processing-contract';
import { ExtractionSchema } from '../processing-contract';
import type {
  FactReview,
  ReviewDecision,
  ReviewState,
} from '../review-contract';
import type { PoolClient } from 'pg';
import type { WorkspaceContext } from './access';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  verified: vi.fn(),
  catalog: vi.fn(),
  workspace: vi.fn(),
  save: vi.fn(),
  route: vi.fn(),
  apply: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
}));
vi.mock('./db', () => ({
  pool: {},
  withTenant: async (_id: string, work: (c: unknown) => unknown) =>
    work({ query: mocks.query }),
}));
vi.mock('./demo-review-policy', () => ({
  hasDemoSourceVerification: mocks.verified,
}));
vi.mock('./demo-corpus', async (original) => ({
  ...(await original<typeof import('./demo-corpus')>()),
  loadDemoCatalog: mocks.catalog,
}));
vi.mock('../workspace-store', () => ({
  readWorkspaceInTransaction: mocks.workspace,
  saveWorkspace: mocks.save,
}));
vi.mock('./demo-news-routing', () => ({
  resolveDemoNewsHoldingInTransaction: mocks.route,
}));
vi.mock('./audit', () => ({ audit: mocks.audit }));
vi.mock('./review-store', async (original) => ({
  ...(await original<typeof import('./review-store')>()),
  applyReview: mocks.apply,
}));
import { encrypt, sha256 } from './crypto';
import { readReview, planReview } from './review-store';
import { DEMO_IDENTITY_REVIEW_REASON, retryDemoNewsJob } from './demo-publish';

const ORG = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const DOCUMENT = '33333333-3333-4333-8333-333333333333';
const actor = 'demo-agent:' + ORG;
const source = Buffer.from('Retained fictional issuer news.');
let extraction: Extraction;
let row: {
  id: string;
  document_id: string;
  filename: string;
  status: string;
  mode: string;
  result: Buffer;
  review_state: Buffer;
  review_revision: number;
  content_hash: string;
  source_payload: Buffer;
};
let originalReview: ReviewState;
let planned: ReviewState | undefined;
function sealReview(patch: Partial<FactReview> = {}) {
  const decision: FactReview = {
    factIndex: 0,
    status: 'deferred',
    holdingId: null,
    rationale: DEMO_IDENTITY_REVIEW_REASON,
    evidenceVerified: false,
    version: 1,
    reviewedBy: actor,
    reviewedAt: '2026-09-09T10:00:00Z',
    ...patch,
  };
  originalReview = {
    revision: 1,
    extractionHash: sha256(JSON.stringify(ExtractionSchema.parse(extraction))),
    facts: [decision],
    history: [
      {
        revision: 1,
        at: '2026-09-09T10:00:00Z',
        actorId: actor,
        decisions: [decision],
      },
    ],
  };
  row.review_state = encrypt(
    JSON.stringify(originalReview),
    'review:' + ORG + ':' + JOB,
  );
  row.result = encrypt(JSON.stringify(extraction), 'result:' + ORG + ':' + JOB);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ASTER_ENABLE_DEMO', 'true');
  vi.stubEnv('ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('ENCRYPTION_ACTIVE_KEY_ID', 'legacy');
  extraction = {
    schemaVersion: 1,
    documentId: DOCUMENT,
    mode: 'agentic',
    execution: 'local',
    model: 'gemma4:e4b-m3',
    documentType: 'news',
    relevant: true,
    confidence: 0.8,
    facts: [
      {
        kind: 'news',
        investmentName: 'Acme Tools Ltd',
        effectiveDate: '2026-07-03',
        amount: null,
        currency: null,
        dueDate: null,
        summary: 'Acme Tools Ltd appoints a chief operating officer.',
        evidence: {
          page: 1,
          quote:
            'Acme Tools Ltd appoints a chief operating officer on 3 July 2026.',
        },
      },
    ],
    warnings: [],
    trace: [
      {
        stage: 'validate',
        status: 'ok',
        detail: 'Independent source validation',
      },
    ],
  };
  row = {
    id: JOB,
    document_id: DOCUMENT,
    filename: 'issuer-news.eml',
    status: 'awaiting_review',
    mode: 'agentic',
    result: Buffer.alloc(0),
    review_state: Buffer.alloc(0),
    review_revision: 1,
    content_hash: sha256(source),
    source_payload: encrypt(source, 'document:' + ORG + ':' + DOCUMENT),
  };
  sealReview();
  planned = undefined;
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('SELECT j.*') ? [row] : [],
    rowCount: 1,
  }));
  mocks.verified.mockResolvedValue(true);
  mocks.catalog.mockResolvedValue({
    documents: [{ sha256: sha256(source), office_id: 'family-1' }],
  });
  mocks.workspace.mockResolvedValue({
    state: {
      demo: { autoPublish: true, runId: ORG },
      portfolio: {
        holdings: [
          { id: 'parent', name: 'Example Fund', familyId: 'family-1' },
        ],
      },
      intelligence: { proposals: [] },
    },
  });
  mocks.route.mockResolvedValue({
    holdingId: 'parent',
    proposalId: 'proposal-1',
    disclosureDocumentId: '44444444-4444-4444-8444-444444444444',
    disclosureAsOfDate: '2026-06-30',
  });
  mocks.apply.mockImplementation(
    async (
      _c: PoolClient,
      ctx: WorkspaceContext,
      job: typeof row,
      result: Extraction,
      revision: number,
      decisions: ReviewDecision[],
    ) => {
      planned = planReview(
        readReview(job, ctx.organizationId, result),
        result,
        revision,
        decisions,
        ctx.user.id,
        '2026-09-09T11:00:00Z',
      );
      return {
        applied: decisions.length,
        duplicates: 0,
        review: planned,
        status: 'accepted',
      };
    },
  );
});
afterEach(() => vi.unstubAllEnvs());

describe('explicit versioned retry of demo issuer news', () => {
  it('uses normal review revision2, preserves revision1 and original extraction/source bytes, and creates no holding', async () => {
    const originalResult = Buffer.from(row.result),
      originalSource = Buffer.from(row.source_payload);
    const result = await retryDemoNewsJob(ORG, JOB);
    expect(result).toEqual({
      changed: true,
      applied: 1,
      duplicates: 0,
      revision: 2,
    });
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'demo-system' }),
      row,
      extraction,
      1,
      [
        expect.objectContaining({
          factIndex: 0,
          holdingId: 'parent',
          status: 'accepted',
          evidenceVerified: true,
        }),
      ],
    );
    expect(planned!.history[0]).toEqual(originalReview.history[0]);
    expect(planned!.facts[0].version).toBe(2);
    expect(planned!.facts[0].amendedFact).toBeUndefined();
    expect(row.result.equals(originalResult)).toBe(true);
    expect(row.source_payload.equals(originalSource)).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(
      mocks.query.mock.calls.every(
        ([sql]) =>
          !/UPDATE.*\bresult\s*=|UPDATE app_documents|INSERT INTO app_jobs/i.test(
            sql,
          ),
      ),
    ).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      actor,
      'demo.news_routing_retried',
      JOB,
      expect.objectContaining({
        previousReviewRevision: 1,
        reviewRevision: 2,
        extractionUnchanged: true,
        humanReview: false,
      }),
    );
  });
  it.each([
    { status: 'accepted' as const },
    { status: 'rejected' as const },
    { reviewedBy: 'human-reviewer' },
    { rationale: 'Human requested a different investigation.' },
  ])(
    'leaves prior manual/accepted/rejected decisions untouched: %j',
    async (patch) => {
      sealReview(patch);
      expect((await retryDemoNewsJob(ORG, JOB)).changed).toBe(false);
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );
  it('never retries amended news or financial facts', async () => {
    sealReview({ amendedFact: extraction.facts[0] });
    expect((await retryDemoNewsJob(ORG, JOB)).changed).toBe(false);
    extraction.facts[0] = {
      ...extraction.facts[0],
      kind: 'valuation',
      amount: '123',
      currency: 'EUR',
    };
    sealReview();
    expect((await retryDemoNewsJob(ORG, JOB)).changed).toBe(false);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('leaves ambiguous or unavailable relationships in review', async () => {
    mocks.route.mockResolvedValue(null);
    expect((await retryDemoNewsJob(ORG, JOB)).changed).toBe(false);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('requires the marked-demo verification and local validated original', async () => {
    mocks.verified.mockResolvedValue(false);
    expect((await retryDemoNewsJob(ORG, JOB)).changed).toBe(false);
    expect(mocks.catalog).not.toHaveBeenCalled();
    mocks.verified.mockResolvedValue(true);
    extraction.execution = 'cloud';
    sealReview();
    await expect(retryDemoNewsJob(ORG, JOB)).rejects.toThrow(
      'DEMO_RESULT_MISMATCH',
    );
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('does nothing when synthetic demo automation is disabled', async () => {
    vi.stubEnv('ASTER_ENABLE_DEMO', 'false');
    expect((await retryDemoNewsJob(ORG, JOB)).changed).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
