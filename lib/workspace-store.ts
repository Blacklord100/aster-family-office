import type { PoolClient } from 'pg';
import { initialWorkspace, type WorkspaceState } from './workspace';
import { withTenant } from './server/db';
import { encrypt, decrypt } from './server/crypto';
import { audit } from './server/audit';
import type { WorkspaceContext } from './server/access';
export async function readWorkspaceInTransaction(
  client: PoolClient,
  organizationId: string,
  lock = false,
) {
  const record = await client.query<{ payload: Buffer; revision: number }>(
    'SELECT payload,revision FROM app_workspace WHERE organization_id=$1' +
      (lock ? ' FOR UPDATE' : ''),
    [organizationId],
  );
  if (record.rows[0])
    return {
      state: JSON.parse(
        decrypt(
          record.rows[0].payload,
          'workspace:' + organizationId,
        ).toString(),
      ) as WorkspaceState,
      revision: record.rows[0].revision,
    };
  const org = await client.query<{ name: string }>(
    'SELECT name FROM app_organizations WHERE id=$1',
    [organizationId],
  );
  const state = {
    ...initialWorkspace(false),
    officeName: org.rows[0]?.name ?? 'Family office',
  };
  await client.query(
    'INSERT INTO app_workspace(organization_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [
      organizationId,
      encrypt(JSON.stringify(state), 'workspace:' + organizationId),
    ],
  );
  return readWorkspaceInTransaction(client, organizationId, lock);
}
export async function readWorkspace(context: WorkspaceContext) {
  return withTenant(context.organizationId, (client) =>
    readWorkspaceInTransaction(client, context.organizationId),
  );
}
export async function saveWorkspace(
  client: PoolClient,
  organizationId: string,
  state: WorkspaceState,
) {
  await client.query(
    'UPDATE app_workspace SET payload=$2,revision=revision+1,updated_at=now() WHERE organization_id=$1',
    [
      organizationId,
      encrypt(JSON.stringify(state), 'workspace:' + organizationId),
    ],
  );
}
export async function changeWorkspace(
  context: WorkspaceContext,
  change: (state: WorkspaceState) => WorkspaceState,
  action = 'workspace.update',
) {
  return withTenant(context.organizationId, async (client) => {
    const { state } = await readWorkspaceInTransaction(
      client,
      context.organizationId,
      true,
    );
    const next = change(state);
    await saveWorkspace(client, context.organizationId, next);
    await audit(
      client,
      context.organizationId,
      context.user.id,
      action,
      context.organizationId,
    );
    return next;
  });
}
