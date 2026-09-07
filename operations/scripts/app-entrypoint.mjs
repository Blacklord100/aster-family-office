import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

function secret(name) {
  const file = process.env[name + '_FILE'];
  const direct = process.env[name];
  if (file && direct) throw new Error('Configure either ' + name + ' or its _FILE, not both');
  const value = file ? readFileSync(file, 'utf8').trim() : direct;
  if (!value) throw new Error('Missing required secret: ' + name);
  process.env[name] = value;
  delete process.env[name + '_FILE'];
  return value;
}
try {
  if (process.env.DB_PASSWORD_FILE) {
    const password = secret('DB_PASSWORD');
    const url = new URL('postgresql://postgres:5432/aster');
    url.username = process.env.DB_USER || 'aster_runtime';
    url.password = password;
    url.hostname = process.env.DB_HOST || 'postgres';
    url.port = process.env.DB_PORT || '5432';
    url.pathname = '/' + (process.env.DB_NAME || 'aster');
    process.env.DATABASE_URL = url.toString();
    delete process.env.DB_PASSWORD;
  }
  if (process.env.ASTER_DB_MIGRATION === '1') {
    process.env.MIGRATION_DATABASE_URL = process.env.DATABASE_URL;
    process.env.BOOTSTRAP_DATABASE_URL = process.env.DATABASE_URL;
  }
  const auth = secret('BETTER_AUTH_SECRET');
  if (auth.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
  const encryption = secret('ENCRYPTION_KEY');
  if (Buffer.from(encryption, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must encode 32 bytes');
  secret('PROCESSOR_TOKEN');
  const args = process.argv.slice(2);
  if (!args.length) throw new Error('Missing service command');
  const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: process.env });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Aster service could not start'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 1); });
} catch (error) {
  console.error(error instanceof Error && !('path' in error) ? error.message : 'Could not read required secret file');
  process.exitCode = 1;
}
