import { pool, assertDatabaseRole } from '@/lib/server/db';
import { authEnvironment } from '@/lib/server/auth';
import { encrypt } from '@/lib/server/crypto';
export async function GET() {
  try {
    authEnvironment();
    encrypt('readiness', 'health');
    await assertDatabaseRole();
    await pool.query('SELECT 1');
    return Response.json(
      { status: 'ok' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
