import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { SavedReport, WorkspaceState } from '../workspace';
import { assertDisposableDatabase } from '../test-support/disposable-database';
import { startApplicationFixtureWorker } from '../test-support/application-worker';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
  mfaRequired: () => true,
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return id
          ? {
              user: {
                id,
                name: 'Synthetic integration reviewer',
                email: 'fixture@example.invalid',
                twoFactorEnabled: true,
              },
              session: { id: 'test-session', mfaVerifiedAt: new Date() },
            }
          : null;
      },
    },
  },
}));
const enabled =
  process.env.APP_TEST_DATABASE_URL && process.env.APP_TEST_ADMIN_URL;
const suite = enabled ? describe : describe.skip;
const orgA = randomUUID(),
  orgB = randomUUID(),
  userA = randomUUID(),
  userB = randomUUID(),
  administrator = randomUUID(),
  viewer = randomUUID();
let db: typeof import('./db'), admin: Pool;
let fixtureWorker:
  | Awaited<ReturnType<typeof startApplicationFixtureWorker>>
  | undefined;
let workspace: typeof import('../../app/api/workspace/route'),
  documents: typeof import('../../app/api/documents/route'),
  documentGet: typeof import('../../app/api/documents/[id]/route'),
  team: typeof import('../../app/api/team/route'),
  processing: typeof import('../../app/api/processing/route'),
  review: typeof import('../../app/api/processing/[id]/route');
let holdingId = '',
  jobId = '',
  documentId = '';
function request(
  path: string,
  body?: unknown,
  user: string = userA,
  method = body === undefined ? 'GET' : 'POST',
  origin = 'http://localhost:3000',
) {
  return new Request('http://localhost:3000' + path, {
    method,
    headers: {
      origin,
      ...(user ? { 'x-test-user': user } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function upload(text: string, mode = 'workflow', user = userA) {
  const body = new FormData();
  body.append(
    'file',
    new File([text], 'valuation.txt', { type: 'text/plain' }),
  );
  body.append('mode', mode);
  return new Request('http://localhost:3000/api/documents', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000', 'x-test-user': user },
    body,
  });
}
async function waitForReview(id: string) {
  const deadline = Date.now() + 60000;
  do {
    const body = await (
      await processing.GET(request('/api/processing'))
    ).json();
    const job = body.jobs.find((entry: { id: string }) => entry.id === id);
    if (job && ['awaiting_review', 'failed'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error('Disposable job did not reach review before the deadline.');
}
async function addSession(userId: string) {
  const id = randomUUID();
  await db.pool.query(
    'INSERT INTO auth_session(id,"userId",token,"expiresAt") VALUES($1,$2,$3,now() + interval \'1 hour\')',
    [id, userId, randomUUID()],
  );
  return id;
}
suite('real application database and worker boundaries', () => {
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', process.env.APP_TEST_DATABASE_URL!);
    vi.stubEnv('MIGRATION_DATABASE_URL', process.env.APP_TEST_ADMIN_URL!);
    assertDisposableDatabase();
    vi.stubEnv('AUTH_REQUIRE_MFA', 'true');
    db = await import('./db');
    admin = new Pool({
      connectionString: process.env.APP_TEST_ADMIN_URL,
      max: 1,
    });
    workspace = await import('../../app/api/workspace/route');
    documents = await import('../../app/api/documents/route');
    documentGet = await import('../../app/api/documents/[id]/route');
    team = await import('../../app/api/team/route');
    processing = await import('../../app/api/processing/route');
    review = await import('../../app/api/processing/[id]/route');
    for (const id of [userA, userB, viewer, administrator])
      await db.pool.query(
        'INSERT INTO auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',
        [id, 'Disposable app test', id + '@example.invalid'],
      );
    for (const id of [orgA, orgB])
      await db.pool.query(
        'INSERT INTO app_organizations(id,name) VALUES($1,$2)',
        [id, 'Disposable app integration'],
      );
    await db.pool.query(
      "INSERT INTO app_memberships(organization_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner'),($1,$5,'viewer'),($1,$6,'admin')",
      [orgA, userA, orgB, userB, viewer, administrator],
    );
    if (
      (await admin.query('SELECT count(*)::int AS count FROM app_job_queue'))
        .rows[0].count !== 0
    )
      throw new Error('Application fixture requires an idle disposable queue.');
    fixtureWorker = await startApplicationFixtureWorker(
      async (id) =>
        (
          await admin.query(
            'SELECT id FROM app_documents WHERE id=$1 AND organization_id=ANY($2::uuid[])',
            [id, [orgA, orgB]],
          )
        ).rowCount === 1,
    );
    vi.stubEnv('PROCESSOR_URL', fixtureWorker.endpoint);
  }, 30000);
  afterAll(async () => {
    await fixtureWorker?.stop();
    if (admin) {
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        // Disable immutability only for this fixture's append-only reviews.
        // Restore normal FK/CASCADE enforcement before deleting any parent:
        // otherwise sessions and organization queues survive as orphan rows.
        await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query(
          'DELETE FROM app_review_versions WHERE organization_id=ANY($1::uuid[])',
          [[orgA, orgB]],
        );
        await c.query("SET LOCAL session_replication_role = 'origin'");
        for (const table of [
          'app_job_queue',
          'app_accepted_facts',
          'app_audit',
          'app_jobs',
          'app_documents',
          'app_workspace',
          'auth_invitation',
          'app_memberships',
        ])
          await c.query(
            'DELETE FROM ' + table + ' WHERE organization_id=ANY($1::uuid[])',
            [[orgA, orgB]],
          );
        await c.query(
          'DELETE FROM app_organizations WHERE id=ANY($1::uuid[])',
          [[orgA, orgB]],
        );
        await c.query('DELETE FROM auth_user WHERE id=ANY($1::text[])', [
          [userA, userB, viewer, administrator],
        ]);
        expect(
          (
            await c.query(
              'SELECT count(*)::int AS count FROM auth_session WHERE "userId"=ANY($1::text[])',
              [[userA, userB, viewer, administrator]],
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await c.query(
              'SELECT count(*)::int AS count FROM app_report_obligations_queue WHERE organization_id=ANY($1::uuid[])',
              [[orgA, orgB]],
            )
          ).rows[0].count,
        ).toBe(0);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
        await admin.end();
      }
    }
    if (db) await db.pool.end();
    vi.unstubAllEnvs();
  });
  it('requires authentication and rejects cross-origin and viewer writes', async () => {
    expect(
      (await workspace.GET(request('/api/workspace', undefined, ''))).status,
    ).toBe(401);
    expect(
      (
        await workspace.POST(
          request(
            '/api/workspace',
            { type: 'settings', name: 'No' },
            userA,
            'POST',
            'https://evil.invalid',
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await processing.PATCH(
          request('/api/processing', { mode: 'agentic' }, viewer, 'PATCH'),
        )
      ).status,
    ).toBe(403);
    expect(
      (await documents.POST(upload('Text', 'workflow', viewer))).status,
    ).toBe(403);
  });
  it('starts empty, adds an explicit holding and enforces DB row isolation', async () => {
    const empty = await (await workspace.GET(request('/api/workspace'))).json();
    expect(empty.sampleData).toBe(false);
    const response = await workspace.POST(
      request('/api/workspace', {
        type: 'addHolding',
        name: 'Meridian Real Assets',
        familyName: 'Test family',
        assetClass: 'Real estate',
        valueEUR: 8000000,
        costBasisEUR: 7000000,
        unfundedCommitmentEUR: 0,
        valuationDate: '2026-03-31',
      }),
    );
    expect(response.status).toBe(200);
    const state = await response.json();
    holdingId = state.portfolio.holdings[0].id;
    expect(state.portfolio.history).toEqual([
      {
        holdingId,
        date: '2026-03-31',
        valueEUR: 8000000,
        netExternalFlowEUR: 0,
        valuationBasis: 'Reported mark',
      },
    ]);
    expect(state.portfolio.evidence[0]).toMatchObject({
      holdingId,
      effectiveDate: '2026-03-31',
      synthetic: false,
      status: 'Needs review',
    });
    expect(
      (await db.pool.query('SELECT organization_id FROM app_workspace')).rows,
    ).toEqual([]);
    const other = await db.withTenant(orgB, (c) =>
      c.query(
        'SELECT organization_id FROM app_workspace WHERE organization_id=$1',
        [orgA],
      ),
    );
    expect(other.rowCount).toBe(0);
    await expect(
      db.withTenant(orgB, (c) =>
        c.query(
          'INSERT INTO app_workspace(organization_id,payload) VALUES($1,$2)',
          [orgA, Buffer.from('blocked')],
        ),
      ),
    ).rejects.toThrow();
    const raw = await admin.query(
      'SELECT payload FROM app_workspace WHERE organization_id=$1',
      [orgA],
    );
    expect(raw.rows[0].payload.toString().includes('Meridian')).toBe(false);
  });
  it('deduplicates concurrent uploads, keeps other tenants out and runs a real durable workflow', async () => {
    const text =
      'Synthetic valuation statement\nFund: Meridian Real Assets\nValuation date: 2026-06-30\nNAV: EUR 8,250,000.00';
    const responses = await Promise.all([
      documents.POST(upload(text)),
      documents.POST(upload(text)),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(responses.every((r) => r.ok)).toBe(true);
    expect(bodies[0].jobId).toBe(bodies[1].jobId);
    jobId = bodies[0].jobId;
    documentId = bodies[0].documentId;
    expect(
      (
        await documentGet.GET(
          request('/api/documents/' + documentId, undefined, userB),
          { params: Promise.resolve({ id: documentId }) },
        )
      ).status,
    ).toBe(404);
    const original = await documentGet.GET(
      request('/api/documents/' + documentId),
      { params: Promise.resolve({ id: documentId }) },
    );
    expect(await original.text()).toBe(text);
    const job = await waitForReview(jobId);
    expect(job.status).toBe('awaiting_review');
    expect(job.result.execution).toBe('local');
    expect(job.result.facts[0].amount).toBe('8250000.00');
    const second = await (
      await processing.GET(request('/api/processing', undefined, userB))
    ).json();
    expect(second.jobs).toHaveLength(0);
  }, 65000);
  it('does not post before review, accepts once, preserves evidence and rejects replay', async () => {
    let state = await (await workspace.GET(request('/api/workspace'))).json();
    expect(state.portfolio.holdings[0].valueEUR).toBe(8000000);
    const body = {
      action: 'accept',
      selections: [{ factIndex: 0, holdingId }],
    };
    const foreign = await review.PATCH(
      request('/api/processing/' + jobId, body, userB, 'PATCH'),
      { params: Promise.resolve({ id: jobId }) },
    );
    expect(foreign.status).toBe(404);
    const accepted = await review.PATCH(
      request('/api/processing/' + jobId, body, userA, 'PATCH'),
      { params: Promise.resolve({ id: jobId }) },
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).applied).toBe(1);
    state = await (await workspace.GET(request('/api/workspace'))).json();
    expect(state.portfolio.holdings[0].valueEUR).toBe(8250000);
    expect(state.portfolio.evidence[0].documentId).toBe(documentId);
    const replay = await review.PATCH(
      request('/api/processing/' + jobId, body, userA, 'PATCH'),
      { params: Promise.resolve({ id: jobId }) },
    );
    expect(replay.status).toBe(409);
    await expect(
      db.withTenant(orgA, (c) =>
        c.query('DELETE FROM app_audit WHERE organization_id=$1', [orgA]),
      ),
    ).rejects.toThrow();
  });

  it('scopes team lists and rejects cross-organization role, removal and restoration requests', async () => {
    const members = await (await team.GET(request('/api/team'))).json();
    expect(
      members.members.map((member: { id: string }) => member.id).sort(),
    ).toEqual([userA, administrator, viewer].sort());
    expect(
      (await team.GET(request('/api/team', undefined, viewer))).status,
    ).toBe(403);
    const foreignSession = await addSession(userB);
    for (const action of ['role', 'remove', 'restore']) {
      const body = { userId: userB, action, role: 'viewer' };
      const response = await team.PATCH(
        request('/api/team', body, userA, 'PATCH'),
      );
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe('MEMBER_NOT_FOUND');
      const selected = request('/api/team', body, userA, 'PATCH');
      selected.headers.set('x-aster-organization', orgB);
      expect((await team.PATCH(selected)).status).toBe(403);
    }
    expect(
      (
        await db.pool.query(
          'SELECT role,revoked_at FROM app_memberships WHERE user_id=$1 AND organization_id=$2',
          [userB, orgB],
        )
      ).rows,
    ).toEqual([{ role: 'owner', revoked_at: null }]);
    expect(
      (
        await db.pool.query('SELECT id FROM auth_session WHERE id=$1', [
          foreignSession,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT id FROM app_audit WHERE organization_id=$1 AND action LIKE 'team.%'",
          [orgB],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('protects owners, blocks self-management and limits administrator elevation to owners', async () => {
    for (const action of ['role', 'remove', 'restore']) {
      for (const actor of [userA, administrator]) {
        const response = await team.PATCH(
          request(
            '/api/team',
            { userId: userA, action, role: 'viewer' },
            actor,
            'PATCH',
          ),
        );
        expect(response.status).toBe(403);
        expect((await response.json()).error).toBe('PROTECTED_ROLE');
      }
      expect(
        (
          await team.PATCH(
            request(
              '/api/team',
              { userId: administrator, action, role: 'viewer' },
              administrator,
              'PATCH',
            ),
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await team.PATCH(
          request(
            '/api/team',
            { userId: viewer, action: 'role', role: 'admin' },
            administrator,
            'PATCH',
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await team.PATCH(
          request(
            '/api/team',
            { userId: viewer, action: 'role', role: 'admin' },
            userA,
            'PATCH',
          ),
        )
      ).status,
    ).toBe(200);
    for (const action of ['role', 'remove', 'restore'])
      expect(
        (
          await team.PATCH(
            request(
              '/api/team',
              { userId: viewer, action, role: 'viewer' },
              administrator,
              'PATCH',
            ),
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await team.PATCH(
          request(
            '/api/team',
            { userId: viewer, action: 'role', role: 'viewer' },
            userA,
            'PATCH',
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await db.pool.query(
          'SELECT role,revoked_at FROM app_memberships WHERE user_id=$1 AND organization_id=$2',
          [userA, orgA],
        )
      ).rows,
    ).toEqual([{ role: 'owner', revoked_at: null }]);
  });

  it('changes roles, revokes access and restores the same membership with session invalidation and audit records', async () => {
    const originalSession = await addSession(viewer);
    expect(
      (
        await team.PATCH(
          request(
            '/api/team',
            { userId: viewer, action: 'role', role: 'analyst' },
            administrator,
            'PATCH',
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await db.pool.query('SELECT id FROM auth_session WHERE id=$1', [
          originalSession,
        ])
      ).rowCount,
    ).toBe(0);
    const analystState = await (
      await workspace.GET(request('/api/workspace', undefined, viewer))
    ).json();
    expect(analystState.identity.role).toBe('analyst');
    const secondSession = await addSession(viewer);
    expect(
      (
        await team.PATCH(
          request(
            '/api/team',
            { userId: viewer, action: 'remove' },
            administrator,
            'PATCH',
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await db.pool.query('SELECT id FROM auth_session WHERE id=$1', [
          secondSession,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await workspace.GET(request('/api/workspace', undefined, viewer)))
        .status,
    ).toBe(403);
    const removed = await (await team.GET(request('/api/team'))).json();
    expect(
      removed.members.find((member: { id: string }) => member.id === viewer)
        .revokedAt,
    ).toBeTruthy();
    expect(
      (
        await team.PATCH(
          request(
            '/api/team',
            { userId: viewer, action: 'restore' },
            administrator,
            'PATCH',
          ),
        )
      ).status,
    ).toBe(200);
    const restored = await workspace.GET(
      request('/api/workspace', undefined, viewer),
    );
    expect(restored.status).toBe(200);
    expect((await restored.json()).identity.role).toBe('analyst');
    expect(
      (
        await db.pool.query(
          'SELECT role,revoked_at FROM app_memberships WHERE user_id=$1 AND organization_id=$2',
          [viewer, orgA],
        )
      ).rows,
    ).toEqual([{ role: 'analyst', revoked_at: null }]);
    const audit = await admin.query(
      "SELECT action FROM app_audit WHERE organization_id=$1 AND actor_id=$2 AND action LIKE 'team.%' ORDER BY sequence",
      [orgA, administrator],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'team.role',
      'team.remove',
      'team.restore',
    ]);
  });

  it('keeps saved report holdings and history immutable after an accepted correction to the same valuation date', async () => {
    const savedResponse = await workspace.POST(
      request('/api/workspace', {
        type: 'report',
        range: '1Y',
        name: 'Before correction',
      }),
    );
    expect(savedResponse.status).toBe(200);
    const saved: SavedReport = (await savedResponse.json()).reports[0];
    expect(saved.totalValueEUR).toBe(8250000);
    expect(saved.synthetic).toBe(false);
    expect(saved.history.at(-1)).toMatchObject({
      value: 8250000,
      flow: null,
      index: null,
    });
    const uploaded = await documents.POST(
      upload(
        'Synthetic revised valuation statement\nFund: Meridian Real Assets\nValuation date: 2026-06-30\nNAV: EUR 8,400,000.00',
      ),
    );
    expect(uploaded.status).toBeLessThan(300);
    const correction = await uploaded.json();
    const correctionJob = await waitForReview(correction.jobId);
    expect(correctionJob.status).toBe('awaiting_review');
    const correctedOriginal = await documentGet.GET(
      request('/api/documents/' + correction.documentId),
      { params: Promise.resolve({ id: correction.documentId }) },
    );
    expect(correctedOriginal.status).toBe(200);
    expect(await correctedOriginal.text()).toContain('8,400,000.00');
    const accepted = await review.PATCH(
      request(
        '/api/processing/' + correction.jobId,
        {
          action: 'review',
          expectedRevision: correctionJob.review.revision,
          decisions: [
            {
              factIndex: 0,
              holdingId,
              status: 'accepted',
              evidenceVerified: true,
              rationale:
                'Reviewed revised statement against the retained original.',
              correction: {
                expectedValueEUR: 8250000,
                reason:
                  'Revised source corrects the previously reported NAV on the same date.',
              },
            },
          ],
        },
        userA,
        'PATCH',
      ),
      { params: Promise.resolve({ id: correction.jobId }) },
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).applied).toBe(1);
    const current: WorkspaceState = await (
      await workspace.GET(request('/api/workspace'))
    ).json();
    expect(current.portfolio!.holdings[0].valueEUR).toBe(8400000);
    expect(
      current.portfolio!.history.filter(
        (point) => point.holdingId === holdingId && point.date === '2026-06-30',
      ),
    ).toEqual([expect.objectContaining({ valueEUR: 8400000 })]);
    expect(
      current.portfolio!.history.find((point) => point.date === '2026-03-31')
        ?.valueEUR,
    ).toBe(8000000);
    expect(current.reports.find((report) => report.id === saved.id)).toEqual(
      saved,
    );
    const latest = await workspace.POST(
      request('/api/workspace', {
        type: 'report',
        range: '1Y',
        name: 'After correction',
      }),
    );
    expect(latest.status).toBe(200);
    const reports: SavedReport[] = (await latest.json()).reports;
    expect(reports[0].totalValueEUR).toBe(8400000);
    expect(reports[0].history.at(-1)).toMatchObject({
      value: 8400000,
      flow: null,
      index: null,
    });
    expect(reports.find((report) => report.id === saved.id)).toEqual(saved);
  }, 65000);

  it('rejects a forty-first report without deleting or changing prior snapshots', async () => {
    let state: WorkspaceState = await (
      await workspace.GET(request('/api/workspace'))
    ).json();
    for (let count = state.reports.length; count < 40; count++) {
      const response = await workspace.POST(
        request('/api/workspace', {
          type: 'report',
          name: 'Retained snapshot ' + count,
        }),
      );
      expect(response.status).toBe(200);
      state = await response.json();
    }
    expect(state.reports).toHaveLength(40);
    const rejected = await workspace.POST(
      request('/api/workspace', {
        type: 'report',
        name: 'Must not replace an old report',
      }),
    );
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error).toBe('REPORT_LIMIT');
    const persisted: WorkspaceState = await (
      await workspace.GET(request('/api/workspace'))
    ).json();
    expect(persisted.reports).toEqual(state.reports);
    expect(
      persisted.reports.some((report) => report.name === 'Before correction'),
    ).toBe(true);
    const created = await admin.query(
      "SELECT count(*)::int AS count FROM app_audit WHERE organization_id=$1 AND action='workspace.report'",
      [orgA],
    );
    expect(created.rows[0].count).toBe(40);
  });
});
