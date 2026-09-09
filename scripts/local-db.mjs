import EmbeddedPostgres from 'embedded-postgres';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
if (process.env.NODE_ENV === 'production')
  throw new Error('Local database helper is development only.');
await mkdir('.local-data', { recursive: true, mode: 0o700 });
let secrets;
try {
  secrets = JSON.parse(await readFile('.local-data/secrets.json', 'utf8'));
} catch {
  secrets = {
    database: randomBytes(32).toString('hex'),
    runtime: randomBytes(32).toString('hex'),
    auth: randomBytes(48).toString('base64url'),
    encryption: randomBytes(32).toString('base64'),
    processor: randomBytes(32).toString('hex'),
  };
  await writeFile('.local-data/secrets.json', JSON.stringify(secrets), {
    mode: 0o600,
  });
}
const pg = new EmbeddedPostgres({
  databaseDir: '.local-data/postgres',
  user: 'postgres',
  password: secrets.database,
  port: 55439,
  persistent: true,
  authMethod: 'scram-sha-256',
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
  onLog: () => {},
  onError: (message) => console.error(String(message)),
});
try {
  await access('.local-data/postgres/PG_VERSION');
} catch {
  await pg.initialise();
}
await pg.start();
const client = pg.getPgClient('postgres');
await client.connect();
if (
  !(await client.query("SELECT 1 FROM pg_database WHERE datname='aster'"))
    .rowCount
)
  await client.query('CREATE DATABASE aster');
if (
  !(await client.query("SELECT 1 FROM pg_roles WHERE rolname='aster_runtime'"))
    .rowCount
)
  await client.query(
    "CREATE ROLE aster_runtime LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" +
      secrets.runtime +
      "'",
  );
await client.end();
const env =
  [
    'DATABASE_URL=postgresql://aster_runtime:' +
      secrets.runtime +
      '@127.0.0.1:55439/aster',
    'MIGRATION_DATABASE_URL=postgresql://postgres:' +
      secrets.database +
      '@127.0.0.1:55439/aster',
    'BOOTSTRAP_DATABASE_URL=postgresql://postgres:' +
      secrets.database +
      '@127.0.0.1:55439/aster',
    'BETTER_AUTH_URL=http://localhost:3000',
    'BETTER_AUTH_SECRET=' + secrets.auth,
    'ENCRYPTION_KEY=' + secrets.encryption,
    'PROCESSOR_TOKEN=' + secrets.processor,
    'PROCESSOR_URL=http://127.0.0.1:8000',
    'AUTH_REQUIRE_MFA=true',
    'OLLAMA_BASE_URL=http://127.0.0.1:11434',
    'OLLAMA_MODEL=gemma4:e4b-m3',
    'ASTER_ALLOW_SAMPLE_DATA=true',
  ].join('\n') + '\n';
try {
  await access('.env.local');
} catch {
  await writeFile('.env.local', env, { mode: 0o600 });
}
console.log(
  'Local PostgreSQL ready on 127.0.0.1:55439. Private development settings: .env.local',
);
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
await new Promise(() => {});
