import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { hashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';

class BootstrapError extends Error {}

// Offline, explicit, one-time operator command. This file intentionally does
// not import Next's server-only modules or share credentials with the browser.
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    organization: { type: 'string' },
  },
  strict: true,
});

async function main() {
  const email = values.email?.trim().toLowerCase();
  const name = values.name?.trim();
  const organization = values.organization?.trim();
  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !name ||
    name.length > 100 ||
    !organization ||
    organization.length < 2 ||
    organization.length > 100
  ) {
    throw new BootstrapError(
      'Usage: npm run bootstrap -- --email owner@example.com --name "Owner" --organization "Family Office"',
    );
  }
  const passwordFile = process.env.BOOTSTRAP_PASSWORD_FILE;
  if (!passwordFile)
    throw new BootstrapError(
      'Set BOOTSTRAP_PASSWORD_FILE to a private file containing a strong password. Password arguments and default credentials are not supported.',
    );
  const metadata = await stat(passwordFile).catch(() => {
    throw new BootstrapError(
      'Cannot read BOOTSTRAP_PASSWORD_FILE. Check its path and permissions.',
    );
  });
  if (
    !metadata.isFile() ||
    metadata.size > 1024 ||
    (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
  ) {
    throw new BootstrapError(
      'BOOTSTRAP_PASSWORD_FILE must be a regular file with mode 0600 and at most 1024 bytes.',
    );
  }
  const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
  if (
    password.length < 15 ||
    password.length > 128 ||
    /^([\s\S])\1+$/u.test(password) ||
    /^(password|qwerty|1234567890|letmein|administrator)[\d\W]*$/i.test(
      password,
    )
  ) {
    throw new BootstrapError(
      'Use an unpredictable password or passphrase between 15 and 128 characters.',
    );
  }
  const connectionString =
    process.env.BOOTSTRAP_DATABASE_URL || process.env.MIGRATION_DATABASE_URL;
  if (!connectionString)
    throw new BootstrapError(
      'BOOTSTRAP_DATABASE_URL or MIGRATION_DATABASE_URL is required. Run this one-off command with the provisioning role, never the web runtime.',
    );
  const db = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // A transaction advisory lock prevents simultaneous bootstrap commands
      // from both observing an empty owner set.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('aster:first-owner'))",
      );
      const existing = await client.query(
        "SELECT 1 FROM app_memberships WHERE role = 'owner' LIMIT 1",
      );
      if (existing.rowCount)
        throw new BootstrapError(
          'An owner already exists. Bootstrap is closed; use an owner-issued invitation.',
        );
      const existingEmail = await client.query(
        'SELECT 1 FROM auth_user WHERE lower(email) = $1',
        [email],
      );
      if (existingEmail.rowCount)
        throw new BootstrapError(
          'This email already exists. Bootstrap will not replace an existing account.',
        );
      const userId = randomUUID();
      const organizationId = randomUUID();
      const passwordHash = await hashPassword(password);
      await client.query(
        'INSERT INTO auth_user (id,name,email,"emailVerified") VALUES ($1,$2,$3,true)',
        [userId, name, email],
      );
      await client.query(
        'INSERT INTO auth_account (id,"accountId","providerId","userId",password) VALUES ($1,$2,\'credential\',$2,$3)',
        [randomUUID(), userId, passwordHash],
      );
      await client.query(
        'INSERT INTO app_organizations (id,name) VALUES ($1,$2)',
        [organizationId, organization],
      );
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        organizationId,
      ]);
      await client.query(
        "INSERT INTO app_memberships (user_id,organization_id,role) VALUES ($1,$2,'owner')",
        [userId, organizationId],
      );
      await client.query('COMMIT');
      process.stdout.write(
        'First owner created. Sign in, enroll an authenticator, and securely remove the bootstrap password file.\n',
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  // Only deliberate operator errors may be shown. Connection strings and
  // driver errors can contain credentials or infrastructure details.
  const safe =
    error instanceof BootstrapError
      ? error.message
      : 'Bootstrap failed. Check database connectivity and migrations.';
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
});
