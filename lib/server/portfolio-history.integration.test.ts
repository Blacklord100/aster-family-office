import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { initialWorkspace, type PortfolioRecords } from '../workspace';
import { emptyFinanceState } from '../ledger-contract';
import { historyPositionDetails } from '../portfolio-history-lifecycle';
import type { WorkspaceContext } from './access';
vi.mock('server-only', () => ({}));
const actor = vi.hoisted(() => ({ id: '', session: '', role: 'owner' }));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'https://history.fixture.invalid' }),
  mfaRequired: () => true,
  auth: {
    api: {
      getSession: async () => ({
        user: {
          id: actor.id,
          name: 'Synthetic reviewer',
          email: 'reviewer@example.invalid',
          twoFactorEnabled: true,
        },
        session: { id: actor.session, mfaVerifiedAt: new Date() },
      }),
    },
  },
}));
const enabled = process.env.ASTER_HISTORY_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'disposable PostgreSQL historical projection and commands',
  () => {
    const org = randomUUID(),
      foreign = randomUUID(),
      owner = randomUUID(),
      viewer = randomUUID(),
      ownerSession = randomUUID(),
      viewerSession = randomUUID(),
      document = randomUUID(),
      sourceId = randomUUID();
    let admin: Pool,
      db: typeof import('./db'),
      crypto: typeof import('./crypto'),
      store: typeof import('./portfolio-history-store'),
      lifecycle: typeof import('./portfolio-history-lifecycle-store');
    let portfolio: PortfolioRecords;
    const ownerCtx: WorkspaceContext = {
      organizationId: org,
      role: 'owner',
      sessionId: ownerSession,
      user: { id: owner, name: 'Owner', email: 'owner@example.invalid' },
    };
    const viewerCtx: WorkspaceContext = {
      organizationId: org,
      role: 'viewer',
      sessionId: viewerSession,
      user: { id: viewer, name: 'Viewer', email: 'viewer@example.invalid' },
      scope: { familyIds: ['family'] },
    };
    beforeAll(async () => {
      for (const setting of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
        const value = process.env[setting];
        if (!value) throw new Error('Disposable database required');
        const url = new URL(value);
        if (
          url.hostname !== '127.0.0.1' ||
          !/^\/history_fixture_[a-f0-9]+$/.test(url.pathname) ||
          url.port === '55439'
        )
          throw new Error('Refusing any non-disposable history test database');
      }
      admin = new Pool({
        connectionString: process.env.MIGRATION_DATABASE_URL,
        max: 2,
      });
      db = await import('./db');
      crypto = await import('./crypto');
      store = await import('./portfolio-history-store');
      lifecycle = await import('./portfolio-history-lifecycle-store');
      await admin.query(
        'INSERT INTO app_organizations(id,name) VALUES($1,$2),($3,$4)',
        [org, 'History test', foreign, 'Other history test'],
      );
      for (const [user, session, role, scope] of [
        [owner, ownerSession, 'owner', null],
        [viewer, viewerSession, 'viewer', { familyIds: ['family'] }],
      ] as const) {
        await admin.query(
          'INSERT INTO auth_user(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$2,$3,true,true)',
          [user, role, user + '@example.invalid'],
        );
        await admin.query(
          'INSERT INTO auth_session(id,"userId",token,"expiresAt","mfaVerifiedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now())',
          [session, user, randomUUID()],
        );
        await admin.query(
          'INSERT INTO app_memberships(organization_id,user_id,role,data_scope) VALUES($1,$2,$3,$4)',
          [org, user, role, scope],
        );
      }
      portfolio = {
        holdings: [
          {
            id: 'holding',
            name: 'Synthetic investment',
            familyId: 'family',
            entityId: 'entity',
            accountId: 'account',
            assetClass: 'Private equity',
            currency: 'EUR',
            valueEUR: 100,
            originalValue: 100,
            syntheticFXRateToEUR: 1,
            costBasisEUR: 0,
            unfundedCommitmentEUR: 0,
            liquidityBucket: '3+ years',
            valuationDate: '2026-06-30',
            sourceId,
            geography: '',
            manager: 'Synthetic manager',
            description: '',
            color: '',
            valuationMethod: 'Reported fund NAV',
          },
        ],
        evidence: [
          {
            id: sourceId,
            documentId: document,
            holdingId: 'holding',
            familyId: 'family',
            mailboxId: '',
            subject: 'Synthetic notice',
            sender: '',
            receivedAt: '2026-09-09T10:00:00Z',
            effectiveDate: '2026-06-30',
            filename: 'synthetic-history.txt',
            page: 1,
            excerpt: 'Synthetic subscription completed on 2026-03-31',
            status: 'Accepted',
            synthetic: false,
          },
        ],
        families: [
          {
            id: 'family',
            name: 'Synthetic family',
            initials: 'S',
            principal: '',
            location: '',
            color: '',
          },
        ],
        entities: [
          {
            id: 'entity',
            familyId: 'family',
            name: 'Synthetic entity',
            type: 'Trust',
            jurisdiction: '',
            ownershipPercent: 100,
          },
        ],
        accounts: [
          {
            id: 'account',
            familyId: 'family',
            entityId: 'entity',
            name: 'Synthetic account',
            institution: '',
            maskedNumber: '',
            type: 'Private investments',
          },
        ],
        history: [],
        tasks: [],
        events: [],
      };
      const finance = emptyFinanceState();
      finance.valuations.push({
        id: randomUUID(),
        holdingId: 'holding',
        amount: '100.00',
        valueEUR: 100,
        currency: 'EUR',
        effectiveDate: '2026-06-30',
        sourceId,
        actorId: owner,
        recordedAt: '2026-09-09T11:00:00Z',
        valuationMethod: 'Reported fund NAV',
      });
      const source = Buffer.from(
        'Synthetic subscription completed on 2026-03-31; NAV EUR 100 on 2026-06-30',
      );
      await admin.query(
        'INSERT INTO app_documents(id,organization_id,created_by,filename,mime_type,content_hash,byte_size,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          document,
          org,
          owner,
          'synthetic-history.txt',
          'text/plain',
          crypto.sha256(source),
          source.length,
          crypto.encrypt(source, 'document:' + org + ':' + document),
          '2026-09-08T09:00:00Z',
        ],
      );
      await admin.query(
        'INSERT INTO app_workspace(organization_id,payload) VALUES($1,$2)',
        [
          org,
          crypto.encrypt(
            JSON.stringify({ ...initialWorkspace(false), portfolio, finance }),
            'workspace:' + org,
          ),
        ],
      );
      actor.id = owner;
      actor.session = ownerSession;
    });
    afterAll(async () => {
      await db?.pool.end();
      await admin?.end();
    });
    it('reads exact dated records via actual authenticated GET without model/processor access', async () => {
      const { GET } = await import('@/app/api/portfolio-history/route');
      const response = await GET(
        new Request('https://history.fixture.invalid/api/portfolio-history', {
          headers: { 'x-aster-organization': org },
        }),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.summary.amount).toBe('100.00');
      expect(data.observations[0].importedAt).toBe('2026-09-08T09:00:00.000Z');
      await db.withTenant(foreign, async (client) => {
        expect(
          (await client.query('SELECT * FROM app_workspace')).rows,
        ).toHaveLength(0);
      });
    });
    it('hides unreleased originals from scoped viewers and reflects revocation within the next snapshot', async () => {
      expect(
        (await store.readPortfolioHistory(viewerCtx)).observations,
      ).toHaveLength(0);
      await admin.query(
        'INSERT INTO app_document_access(organization_id,document_id,family_ids,entity_ids,reviewed_by) VALUES($1,$2,$3,$4,$5)',
        [org, document, ['family'], ['entity'], owner],
      );
      expect(
        (await store.readPortfolioHistory(viewerCtx)).observations,
      ).toHaveLength(1);
      await admin.query(
        'UPDATE app_memberships SET revoked_at=now() WHERE organization_id=$1 AND user_id=$2',
        [org, viewer],
      );
      await expect(store.readPortfolioHistory(viewerCtx)).rejects.toMatchObject(
        { code: 'ACCESS_CHANGED' },
      );
    });
    it('commits a pinned sourced lifecycle once, retains encrypted payload and fences stale revisions', async () => {
      const before = await store.readPortfolioHistory(ownerCtx);
      const request = {
        expectedRevision: before.revision,
        idempotencyKey: randomUUID(),
        command: {
          holdingId: 'holding',
          kind: 'opened' as const,
          effectiveDate: '2026-03-31',
          details: historyPositionDetails(portfolio.holdings[0]),
          sourceId,
          evidenceVerified: true as const,
          page: 1,
          quote: 'Synthetic subscription completed on 2026-03-31',
          reason: 'Synthetic reviewed acquisition evidence',
        },
      };
      const saved = await lifecycle.writeHistoryLifecycle(ownerCtx, request);
      expect(saved.historyLifecycle.records).toHaveLength(1);
      expect(saved.revision).toBe(before.revision + 1);
      expect(
        (await lifecycle.writeHistoryLifecycle(ownerCtx, request)).duplicate,
      ).toBe(true);
      await expect(
        lifecycle.writeHistoryLifecycle(ownerCtx, {
          ...request,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'HISTORY_CHANGED' });
      const after = await store.readPortfolioHistory(ownerCtx, {
        cohort: 'historical',
        asOf: '2026-03-01',
      });
      expect(after.positions[0].ownership).toBe('not_yet_opened');
      expect(after.summary.coverage.totalCount).toBe(0);
      const row = (
        await admin.query(
          'SELECT payload FROM app_workspace WHERE organization_id=$1',
          [org],
        )
      ).rows[0];
      expect(row.payload.includes(Buffer.from(request.command.quote))).toBe(
        false,
      );
      expect(
        (
          await admin.query(
            'SELECT action FROM app_audit WHERE organization_id=$1',
            [org],
          )
        ).rows.map((r) => r.action),
      ).toEqual(['history.lifecycle.opened']);
    });
    it('returns the preserved snapshot on an exact retry even when current observation capacity is exceeded', async () => {
      const { saveReporting, snapshotIntegrity } =
        await import('./reporting-store');
      const { PortfolioHistoryQuerySchema } =
        await import('../portfolio-history-contract');
      const before = await store.readPortfolioHistory(ownerCtx);
      const request = {
        action: 'saveHistory' as const,
        expectedRevision: before.revision,
        idempotencyKey: randomUUID(),
        name: 'Disposable preserved history',
        query: PortfolioHistoryQuerySchema.parse({
          holdingIds: ['holding'],
          asOf: '2026-06-30',
        }),
      };
      const saved = await saveReporting(ownerCtx, request);
      expect(saved.snapshot?.kind).toBe('history');
      expect(snapshotIntegrity(saved.snapshot!)).toBe(true);
      const row = (
        await admin.query(
          'SELECT payload FROM app_workspace WHERE organization_id=$1',
          [org],
        )
      ).rows[0];
      const state = JSON.parse(
        crypto.decrypt(row.payload, 'workspace:' + org).toString(),
      );
      // Deliberate isolated malformed capacity case; no normal writer or live
      // workspace is involved. Existing immutable reports must stay retrievable.
      state.finance.valuations = Array.from({ length: 4001 }, (_, index) => ({
        ...state.finance.valuations[0],
        id: 'over-cap-' + index,
      }));
      await admin.query(
        'UPDATE app_workspace SET payload=$2,revision=revision+1 WHERE organization_id=$1',
        [org, crypto.encrypt(JSON.stringify(state), 'workspace:' + org)],
      );
      await expect(store.readPortfolioHistory(ownerCtx)).rejects.toMatchObject({
        code: 'HISTORY_CAPACITY',
      });
      const retry = await saveReporting(ownerCtx, request);
      expect(retry.duplicate).toBe(true);
      expect(retry.resultId).toBe(saved.resultId);
      expect(snapshotIntegrity(retry.snapshot!)).toBe(true);
    });
  },
);
