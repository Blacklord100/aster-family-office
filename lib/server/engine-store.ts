import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  EngineInputSchema,
  EngineSnapshotSchema,
  type EngineSnapshot,
  type EngineProfile,
} from '../engine-contract';
import { decrypt, encrypt } from './crypto';
import { AccessError, type WorkspaceContext } from './access';
import { audit } from './audit';

export type EngineConfig = z.infer<typeof EngineInputSchema>;
export const executionFor = (provider: EngineConfig['provider']) =>
  provider === 'ollama' ? ('local' as const) : ('cloud' as const);
export function cloudReadiness() {
  const enabled = process.env.ALLOW_CLOUD_ENGINES === 'true';
  let ready = false;
  if (enabled && process.env.PROCESSOR_CLOUD_URL) {
    try {
      ready =
        processorEndpoint('cloud').origin !== processorEndpoint('local').origin;
    } catch {
      /* fail closed */
    }
  }
  return {
    cloudAllowed: ready,
    cloudReadinessReason: ready
      ? null
      : 'Cloud execution disabled by deployment.',
  };
}
export function processorEndpoint(execution: 'local' | 'cloud') {
  const value =
    execution === 'cloud'
      ? process.env.PROCESSOR_CLOUD_URL
      : (process.env.PROCESSOR_URL ?? 'http://processor:8000');
  if (!value)
    throw new AccessError(
      409,
      'CLOUD_DISABLED',
      'Cloud execution disabled by deployment.',
    );
  const url = new URL(value);
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
    throw new Error('Invalid processor port');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('Invalid deployment processor origin');
  const localHosts = [
    'processor',
    'processor-cloud',
    'localhost',
    '127.0.0.1',
    '[::1]',
    'host.docker.internal',
  ];
  if (url.protocol === 'http:' && !localHosts.includes(url.hostname))
    throw new Error('Remote processor requires HTTPS');
  return url;
}
export function assertEngineEnabled(config: EngineConfig) {
  if (config.provider !== 'ollama' && !cloudReadiness().cloudAllowed)
    throw new AccessError(
      409,
      'CLOUD_DISABLED',
      'Cloud execution disabled by deployment.',
    );
}
export function validateEngineConfig(value: unknown): EngineConfig {
  const config = EngineInputSchema.parse(value);
  if (config.provider === 'ollama') {
    if (config.apiKey || /cloud/i.test(config.model))
      throw new AccessError(
        400,
        'INVALID_LOCAL_ENGINE',
        'Choose an installed local Ollama model without an API key.',
      );
  } else if (!config.apiKey)
    throw new AccessError(
      400,
      'API_KEY_REQUIRED',
      'A provider API key is required.',
    );
  return config;
}
export function deploymentEngine(): {
  config: EngineConfig;
  snapshot: EngineSnapshot;
} {
  const config = validateEngineConfig({
    name: 'Deployment default',
    provider: 'ollama',
    model: process.env.OLLAMA_MODEL ?? 'qwen3:1.7b',
  });
  return { config, snapshot: snapshotOf(config, null, 0) };
}
export function snapshotOf(
  config: EngineConfig,
  profileId: string | null,
  revision: number,
): EngineSnapshot {
  return EngineSnapshotSchema.parse({
    profileId,
    revision,
    name: config.name,
    provider: config.provider,
    model: config.model,
    execution: executionFor(config.provider),
  });
}
const context = (org: string, id: string, revision: number) =>
  `engine:${org}:${id}:${revision}`;
type EngineRow = {
  id: string;
  current_revision: number;
  payload: Buffer;
  created_at: Date;
  updated_at: Date;
  tested_at: Date | null;
  test_ok: boolean | null;
  test_error: string | null;
};
export function engineDTO(row: EngineRow, org: string): EngineProfile {
  const config = validateEngineConfig(
    JSON.parse(
      decrypt(
        row.payload,
        context(org, row.id, row.current_revision),
      ).toString(),
    ),
  );
  return {
    ...snapshotOf(config, row.id, row.current_revision),
    profileId: row.id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    hasSecret: !!config.apiKey,
    lastTest: row.tested_at
      ? {
          testedAt: row.tested_at.toISOString(),
          ok: row.test_ok === true,
          errorCode: row.test_error,
        }
      : null,
  };
}
export async function listEngines(client: PoolClient, org: string) {
  const result = await client.query<EngineRow>(
    'SELECT p.*,r.payload,r.tested_at,r.test_ok,r.test_error FROM app_engine_profiles p JOIN app_engine_revisions r ON r.profile_id=p.id AND r.revision=p.current_revision WHERE p.organization_id=$1 AND p.deleted_at IS NULL ORDER BY p.created_at,p.id LIMIT 25',
    [org],
  );
  return result.rows.map((r) => engineDTO(r, org));
}
export async function loadEngineRevision(
  client: PoolClient,
  org: string,
  id: string,
  revision: number,
) {
  const result = await client.query<{ payload: Buffer }>(
    'SELECT r.payload FROM app_engine_revisions r JOIN app_engine_profiles p ON p.id=r.profile_id WHERE r.profile_id=$1 AND r.organization_id=$2 AND r.revision=$3 AND p.deleted_at IS NULL',
    [id, org, revision],
  );
  if (!result.rows[0])
    throw new AccessError(404, 'ENGINE_NOT_FOUND', 'Engine profile not found.');
  const config = validateEngineConfig(
    JSON.parse(
      decrypt(result.rows[0].payload, context(org, id, revision)).toString(),
    ),
  );
  return { config, snapshot: snapshotOf(config, id, revision) };
}
export async function activeEngine(client: PoolClient, org: string) {
  const result = await client.query<{ profile_id: string; revision: number }>(
    'SELECT profile_id,revision FROM app_engine_policy WHERE organization_id=$1',
    [org],
  );
  return result.rows[0]
    ? loadEngineRevision(
        client,
        org,
        result.rows[0].profile_id,
        result.rows[0].revision,
      )
    : deploymentEngine();
}
export async function saveEngine(
  client: PoolClient,
  ctx: WorkspaceContext,
  input: EngineConfig,
  id?: string,
  revision?: number,
) {
  await client.query(
    'SELECT id FROM app_organizations WHERE id=$1 FOR UPDATE',
    [ctx.organizationId],
  );
  const profileId = id ?? randomUUID();
  let next = 1;
  let config: EngineConfig;
  if (id) {
    const p = await client.query<{ current_revision: number }>(
      'SELECT current_revision FROM app_engine_profiles WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE',
      [id, ctx.organizationId],
    );
    if (!p.rows[0])
      throw new AccessError(
        404,
        'ENGINE_NOT_FOUND',
        'Engine profile not found.',
      );
    if (revision !== p.rows[0].current_revision)
      throw new AccessError(
        409,
        'ENGINE_CHANGED',
        'Reload the updated engine profile.',
      );
    const old = await loadEngineRevision(
      client,
      ctx.organizationId,
      id,
      revision,
    );
    config = validateEngineConfig({
      ...input,
      ...(input.apiKey === undefined &&
      input.provider === old.config.provider &&
      old.config.apiKey
        ? { apiKey: old.config.apiKey }
        : {}),
    });
    next = revision + 1;
    if (next > 1000)
      throw new AccessError(
        409,
        'REVISION_LIMIT',
        'Create a new engine profile.',
      );
  } else {
    config = validateEngineConfig(input);
    const count = await client.query<{ count: string }>(
      'SELECT count(*) FROM app_engine_profiles WHERE organization_id=$1 AND deleted_at IS NULL',
      [ctx.organizationId],
    );
    if (Number(count.rows[0].count) >= 25)
      throw new AccessError(
        409,
        'ENGINE_LIMIT',
        'Remove an unused profile before adding another.',
      );
    await client.query(
      'INSERT INTO app_engine_profiles(id,organization_id) VALUES($1,$2)',
      [profileId, ctx.organizationId],
    );
  }
  await client.query(
    'INSERT INTO app_engine_revisions(profile_id,organization_id,revision,payload) VALUES($1,$2,$3,$4)',
    [
      profileId,
      ctx.organizationId,
      next,
      encrypt(
        JSON.stringify(config),
        context(ctx.organizationId, profileId, next),
      ),
    ],
  );
  await client.query(
    'UPDATE app_engine_profiles SET current_revision=$2,updated_at=now() WHERE id=$1',
    [profileId, next],
  );
  await audit(
    client,
    ctx.organizationId,
    ctx.user.id,
    id ? 'engine.updated' : 'engine.created',
    profileId,
    { revision: next, provider: config.provider },
  );
  return (await listEngines(client, ctx.organizationId)).find(
    (p) => p.profileId === profileId,
  )!;
}
export async function activateEngine(
  client: PoolClient,
  ctx: WorkspaceContext,
  id: string | null,
  revision = 0,
  acknowledge = false,
) {
  await client.query(
    'SELECT id FROM app_organizations WHERE id=$1 FOR UPDATE',
    [ctx.organizationId],
  );
  const selected = id
    ? await loadEngineRevision(client, ctx.organizationId, id, revision)
    : deploymentEngine();
  if (id) {
    const current = await client.query<{ current_revision: number }>(
      'SELECT current_revision FROM app_engine_profiles WHERE id=$1 AND organization_id=$2',
      [id, ctx.organizationId],
    );
    if (current.rows[0]?.current_revision !== revision)
      throw new AccessError(
        409,
        'ENGINE_CHANGED',
        'Reload the updated engine profile before activation.',
      );
  }
  assertEngineEnabled(selected.config);
  if (selected.snapshot.execution === 'cloud' && !acknowledge)
    throw new AccessError(
      400,
      'EGRESS_ACKNOWLEDGEMENT_REQUIRED',
      'Confirm that document text may be sent to this cloud provider.',
    );
  if (id)
    await client.query(
      'INSERT INTO app_engine_policy(organization_id,profile_id,revision,cloud_acknowledged_at) VALUES($1,$2,$3,CASE WHEN $4 THEN now() ELSE NULL END) ON CONFLICT(organization_id) DO UPDATE SET profile_id=$2,revision=$3,activated_at=now(),cloud_acknowledged_at=CASE WHEN $4 THEN now() ELSE NULL END',
      [
        ctx.organizationId,
        id,
        revision,
        selected.snapshot.execution === 'cloud',
      ],
    );
  else
    await client.query(
      'DELETE FROM app_engine_policy WHERE organization_id=$1',
      [ctx.organizationId],
    );
  await audit(
    client,
    ctx.organizationId,
    ctx.user.id,
    'engine.activated',
    id ?? ctx.organizationId,
    {
      revision,
      provider: selected.config.provider,
      cloudEgressAcknowledged: acknowledge,
    },
  );
  return selected.snapshot;
}
export async function deleteEngine(
  client: PoolClient,
  ctx: WorkspaceContext,
  id: string,
) {
  await client.query(
    'SELECT id FROM app_organizations WHERE id=$1 FOR UPDATE',
    [ctx.organizationId],
  );
  const active = await client.query(
    'SELECT 1 FROM app_engine_policy WHERE organization_id=$1 AND profile_id=$2',
    [ctx.organizationId, id],
  );
  if (active.rowCount)
    throw new AccessError(
      409,
      'ENGINE_ACTIVE',
      'Activate another engine before removing this profile.',
    );
  const deleted = await client.query(
    'UPDATE app_engine_profiles SET deleted_at=now() WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL RETURNING id',
    [id, ctx.organizationId],
  );
  if (!deleted.rowCount)
    throw new AccessError(404, 'ENGINE_NOT_FOUND', 'Engine profile not found.');
  await audit(client, ctx.organizationId, ctx.user.id, 'engine.deleted', id);
}
export function sealJobEngine(
  config: EngineConfig,
  snapshot: EngineSnapshot,
  org: string,
  jobId: string,
) {
  return {
    snapshot,
    payload: encrypt(
      JSON.stringify({ config, snapshot }),
      `job-engine:${org}:${jobId}`,
    ),
  };
}
export function openJobEngine(
  payload: Buffer,
  snapshot: unknown,
  org: string,
  jobId: string,
) {
  const decoded = z
    .object({ config: EngineInputSchema, snapshot: EngineSnapshotSchema })
    .strict()
    .parse(
      JSON.parse(decrypt(payload, `job-engine:${org}:${jobId}`).toString()),
    );
  const validated = validateEngineConfig(decoded.config);
  if (
    JSON.stringify(EngineSnapshotSchema.parse(snapshot)) !==
      JSON.stringify(decoded.snapshot) ||
    JSON.stringify(
      snapshotOf(
        validated,
        decoded.snapshot.profileId,
        decoded.snapshot.revision,
      ),
    ) !== JSON.stringify(decoded.snapshot)
  )
    throw new Error('ENGINE_PIN_MISMATCH');
  assertEngineEnabled(validated);
  return decoded;
}
