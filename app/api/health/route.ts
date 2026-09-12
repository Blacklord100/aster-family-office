import { lifecycleRoute, readLifecycleState } from '@/lib/server/lifecycle';
import { runtimeIdentity } from '@/lib/lifecycle-contract';
import { pool, assertDatabaseRole } from '@/lib/server/db';
import { authEnvironment } from '@/lib/server/auth';
import { encrypt } from '@/lib/server/crypto';
const unavailable = () =>
  Response.json(
    { status: 'unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
async function handleGET() {
  try {
    authEnvironment();
    encrypt('readiness', 'health');
    await assertDatabaseRole();
    await pool.query('SELECT 1');
    return Response.json(
      {
        status: 'ok',
        release: runtimeIdentity().release,
        writerGeneration: runtimeIdentity().generation,
        lifecycle: await readLifecycleState(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return unavailable();
  }
}

const readiness = lifecycleRoute(handleGET);
// Lifecycle admission can fail before the handler runs. Keep the public
// readiness contract stable without disclosing an internal failure reason.
export const GET = async () => {
  const response = await readiness();
  return response.ok ? response : unavailable();
};
