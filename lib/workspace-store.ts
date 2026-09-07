import { env } from 'cloudflare:workers';
import { initialWorkspace, type WorkspaceState } from './workspace';
type Row = { payload: string; revision: number };
function database() {
  if (!env.DB) throw new Error('Workspace storage is unavailable');
  return env.DB;
}
export async function readWorkspace() {
  const db = database();
  await db
    .prepare(
      'INSERT OR IGNORE INTO workspace_state (id,payload,revision,updated_at) VALUES (?,?,0,?)',
    )
    .bind(
      'aster-demo-v1',
      JSON.stringify(initialWorkspace()),
      new Date().toISOString(),
    )
    .run();
  const row = await db
    .prepare('SELECT payload,revision FROM workspace_state WHERE id=?')
    .bind('aster-demo-v1')
    .first<Row>();
  if (!row) throw new Error('Workspace could not be loaded');
  return {
    state: JSON.parse(row.payload) as WorkspaceState,
    revision: row.revision,
  };
}
export async function changeWorkspace(
  change: (state: WorkspaceState) => WorkspaceState,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { state, revision } = await readWorkspace();
    const next = change(state);
    const result = await database()
      .prepare(
        'UPDATE workspace_state SET payload=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
      )
      .bind(
        JSON.stringify(next),
        new Date().toISOString(),
        'aster-demo-v1',
        revision,
      )
      .run();
    if (result.meta.changes === 1) return next;
  }
  throw new Error('Another update was saved. Please retry.');
}
