import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  DEMO_DATASETS,
  type DemoDataset,
  type DemoResponse,
  type DemoRun,
} from '../demo-contract';
import { initialWorkspace, type PortfolioRecords } from '../workspace';
import { AccessError, type WorkspaceContext } from './access';
import { pool, withTenant } from './db';
import { audit, rateLimit } from './audit';
import { encrypt } from './crypto';
import { connectFolderInTransaction } from './folder-store';
import type { PoolClient } from 'pg';
import { activateEngine, saveEngine } from './engine-store';
import {
  DEMO_FX_POLICY,
  demoActorId,
  loadDemoCatalog,
  readDemoSource,
} from './demo-corpus';

export const demoEnabled = () =>
  process.env.ASTER_ENABLE_DEMO === 'true' && !!process.env.ASTER_INTAKE_ROOT;
export async function listDemoRuns(
  ctx: WorkspaceContext,
): Promise<DemoResponse> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    created_at: Date;
  }>(
    `SELECT o.id,o.name,o.created_at FROM app_organizations o JOIN app_memberships m ON m.organization_id=o.id
     WHERE o.demo_owner_user_id=$1 AND m.user_id=$1 AND m.revoked_at IS NULL AND m.data_scope IS NULL ORDER BY o.created_at DESC LIMIT 20`,
    [ctx.user.id],
  );
  const runs: DemoRun[] = rows.map((row) => ({
    organizationId: row.id,
    runId: row.id,
    name: row.name,
    startedAt: row.created_at.toISOString(),
    sourceFiles: 100,
  }));
  return {
    enabled: demoEnabled(),
    canCreate: !ctx.scope && ['owner', 'admin'].includes(ctx.role),
    current:
      runs.find((run) => run.organizationId === ctx.organizationId) ?? null,
    runs,
  };
}

export async function createDemoRun(
  ctx: WorkspaceContext,
  dataset: DemoDataset = 'mailroom-v1',
) {
  if (!DEMO_DATASETS.includes(dataset))
    throw new AccessError(
      400,
      'DEMO_DATASET_INVALID',
      'Choose an installed demonstration dataset.',
    );
  if (!demoEnabled())
    throw new AccessError(
      409,
      'DEMO_DISABLED',
      'The administrator must enable the local demo and configure its intake directory.',
    );
  if (ctx.scope || !['owner', 'admin'].includes(ctx.role))
    throw new AccessError(
      403,
      'FORBIDDEN',
      'An administrator starts a demo workspace.',
    );
  // Charge attempts before decoding/copying. This transaction commits even when
  // a later source or filesystem check fails, so failures cannot bypass throttling.
  await withTenant(ctx.organizationId, async (c) => {
    await assertDemoAdmin(c, ctx);
    if (!(await rateLimit(c, 'demo-start:' + ctx.user.id, 5, 3600)))
      throw new AccessError(
        429,
        'DEMO_LIMIT',
        'Please wait before starting another demo run.',
      );
  });
  const catalog = await loadDemoCatalog(dataset);
  const originals: {
    document: (typeof catalog.documents)[number];
    bytes: Buffer;
  }[] = [];
  let totalBytes = 0;
  // Sequential bounded reads cap aggregate memory rather than allocating 100 files in parallel.
  for (const document of catalog.documents) {
    const bytes = await readDemoSource(document, dataset);
    totalBytes += bytes.length;
    if (totalBytes > 64 * 1024 * 1024)
      throw new AccessError(
        409,
        'DEMO_CORPUS_SIZE',
        'The demonstration source corpus exceeds the 64 MiB installation limit.',
      );
    originals.push({ document, bytes });
  }
  const organizationId = randomUUID(),
    startedAt = new Date().toISOString();
  const name =
    (dataset === 'history-v1' ? 'Aster history demo · ' : 'Aster demo · ') +
    startedAt.slice(0, 16).replace('T', ' ');
  let ownedDirectory: string | null = null;
  const colors = ['#557b6c', '#8676ae', '#b48954'];
  const portfolio: PortfolioRecords = {
    holdings: [],
    history: [],
    events: [],
    evidence: [],
    tasks: [],
    families: catalog.offices.map((office, index) => ({
      id: office.id,
      name: office.name,
      initials: office.name
        .split(' ')
        .slice(0, 2)
        .map((word) => word[0])
        .join(''),
      principal: 'Fictional demo family',
      location: 'Demo',
      color: colors[index],
    })),
    entities: catalog.offices.map((office) => ({
      id: office.id + '-entity',
      familyId: office.id,
      name: office.name + ' — demo investment entity',
      type: 'Holding company',
      jurisdiction: 'Demo assumption',
      ownershipPercent: 100,
    })),
    accounts: catalog.offices.map((office) => ({
      id: office.id + '-account',
      familyId: office.id,
      entityId: office.id + '-entity',
      name: 'Source-derived private investments',
      institution: 'Demo reporting account',
      maskedNumber: 'DEMO',
      type: 'Private investments',
    })),
  };
  const demoContext: WorkspaceContext = {
    ...ctx,
    organizationId,
    role: 'owner',
    scope: null,
  };
  try {
    const connection = await withTenant(organizationId, async (c) => {
      // Serialize per person and recheck membership, so parallel starts cannot evade limits.
      await c.query('SELECT id FROM auth_user WHERE id=$1 FOR UPDATE', [
        ctx.user.id,
      ]);
      await assertDemoAdmin(c, ctx);
      const count = await c.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM app_organizations WHERE demo_owner_user_id=$1',
        [ctx.user.id],
      );
      if (count.rows[0].count >= 20)
        throw new AccessError(
          409,
          'DEMO_LIMIT',
          'Twenty demo runs are retained. Ask an administrator to archive old demonstrations before creating more.',
        );
      const configuredRoot = path.resolve(process.env.ASTER_INTAKE_ROOT!);
      await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
      const intakeRoot = await realpath(configuredRoot);
      const organizationDirectory = path.join(intakeRoot, organizationId);
      await mkdir(organizationDirectory, { mode: 0o700 });
      ownedDirectory = organizationDirectory;
      const directory = path.join(organizationDirectory, 'Demo mails');
      await mkdir(directory, { mode: 0o700 });
      for (const { document, bytes } of originals) {
        const target = path.join(
          directory,
          document.office_id,
          document.mailbox_id,
        );
        await mkdir(target, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(target, path.basename(document.path)),
          bytes,
          { flag: 'wx', mode: 0o600 },
        );
      }
      await writeFile(
        path.join(organizationDirectory, 'Demo setup.md'),
        [
          '# Aster source-derived demonstration',
          `Dataset: ${dataset}. 100 synthetic emails from three fictional families and nine fictional mailboxes. PDF attachments are preserved inside the original MIME emails and decoded by the processor. Do not separately import attachment copies: that would add redundant sources.`,
          'The portfolio starts with no holdings or values. Source-backed supported facts are published by the explicitly named demo agent after processing. New or changed files outside the checked demonstration corpus remain for human review.',
          'FX assumptions for every demonstration valuation date (EUR per source currency): ' +
            JSON.stringify(DEMO_FX_POLICY.ratesToEUR) +
            '. These are illustrative scenario assumptions, not market data. Each posted FX conversion carries that label.',
          'Families, owner entities and private investment accounts are declared demonstration routing. Asset classes are inferred from investment names and are labeled accordingly. Liquidity, cost basis, commitments and ownership remain unknown unless supported by sources. No settled cash flow or look-through weight is invented.',
          'Conflicts, missing currencies/dates, image-only evidence and encrypted attachments remain visible in Documents. Capital-call/distribution notices create drafts and never settle cash. History acquisition certificates and bank confirmations require explicit reviewed lifecycle and settlement actions.',
        ].join('\n\n'),
        { flag: 'wx', mode: 0o600 },
      );

      await c.query(
        "INSERT INTO app_organizations(id,name,processing_mode,demo_owner_user_id,demo_source_directory,created_at) VALUES($1,$2,'agentic',$3,'Demo mails',$4)",
        [organizationId, name, ctx.user.id, startedAt],
      );
      await c.query(
        "INSERT INTO app_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
        [organizationId, ctx.user.id],
      );
      // This identity has no account, password, session or membership and cannot sign in.
      await c.query('INSERT INTO auth_user(id,name,email) VALUES($1,$2,$3)', [
        demoActorId(organizationId),
        'Aster demo agent',
        organizationId + '@demo-agent.example.invalid',
      ]);
      const state = {
        ...initialWorkspace(false),
        officeName: name,
        portfolio,
        demo: {
          dataset,
          runId: organizationId,
          name,
          startedAt,
          sourceFiles: originals.length,
          autoPublish: true,
          fxPolicy: DEMO_FX_POLICY,
        },
      };
      await c.query(
        'INSERT INTO app_workspace(organization_id,payload) VALUES($1,$2)',
        [
          organizationId,
          encrypt(JSON.stringify(state), 'workspace:' + organizationId),
        ],
      );
      const engine = await saveEngine(c, demoContext, {
        name: 'Local Gemma demo',
        provider: 'ollama',
        model: process.env.ASTER_DEMO_MODEL ?? 'gemma4:e4b-m3',
      });
      await activateEngine(c, demoContext, engine.profileId, engine.revision);
      await audit(
        c,
        organizationId,
        ctx.user.id,
        'demo.created',
        organizationId,
        {
          sourceFiles: originals.length,
          families: 3,
          dataset,
          autoPublishSyntheticSources: true,
        },
      );
      return connectFolderInTransaction(c, demoContext, {
        directory: 'Demo mails',
        displayName: 'Demo mails',
      });
    });
    return {
      organizationId,
      runId: organizationId,
      sourceFiles: originals.length,
      dataset,
      folderConnectionId: connection.id,
    };
  } catch (error) {
    if (ownedDirectory) {
      // If COMMIT's reply was lost, keep a possibly committed run's source files.
      // A unavailable database also leaves the private directory intact for recovery.
      const persisted = await pool
        .query(
          'SELECT id FROM app_organizations WHERE id=$1 AND demo_owner_user_id=$2',
          [organizationId, ctx.user.id],
        )
        .catch(() => null);
      if (persisted && !persisted.rowCount)
        await rm(ownedDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

async function assertDemoAdmin(client: PoolClient, ctx: WorkspaceContext) {
  const active = await client.query(
    `SELECT 1 FROM app_memberships m JOIN auth_session s ON s."userId"=m.user_id JOIN auth_user u ON u.id=m.user_id
    WHERE m.organization_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND m.role IN ('owner','admin') AND m.data_scope IS NULL
    AND s.id=$3 AND s."expiresAt">now() AND s."mfaVerifiedAt" IS NOT NULL AND u."twoFactorEnabled"=true FOR SHARE OF m,s`,
    [ctx.organizationId, ctx.user.id, ctx.sessionId],
  );
  if (!active.rowCount)
    throw new AccessError(
      403,
      'FORBIDDEN',
      'Your administrator session is no longer active.',
    );
}
