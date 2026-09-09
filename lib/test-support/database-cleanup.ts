import type { Pool } from 'pg';

// Isolated integration fixtures only. Pool.end() may resolve before PostgreSQL
// observes its last disconnect, so let the server govern a non-forced drop.
export async function dropTestDatabase(admin: Pick<Pool, 'query'>, name: string) {
  if (!/^aster_(demo|folder|operations)_[a-f0-9]{16}$/.test(name))
    throw new Error('Refusing to remove a non-disposable test database');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const command = {
        text: `DROP DATABASE "${name}"`,
        query_timeout: Math.max(1, deadline - Date.now()),
      };
      await admin.query(command);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== '55006') throw error;
      if (Date.now() >= deadline)
        throw new Error('Disposable database connections did not close within five seconds');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
