import assert from 'node:assert/strict';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Run only inside the freshly built image, with no network and a read-only root.
assert.equal(process.getuid(), 1000);
assert.equal(process.getgid(), 1000);
assert.equal(process.versions.node.split('.')[0], '24');
for (const file of ['/bin/sh', '/usr/local/bin/npm', '/usr/local/lib/node_modules/npm'])
  await assert.rejects(access(file));
await assert.rejects(writeFile('/app/forbidden', 'x'), (error) => ['EROFS', 'EACCES'].includes(error.code));
const require = createRequire('/app/package.json');
for (const dependency of ['pg', 'zod', 'better-auth', 'html-to-text', '@modelcontextprotocol/sdk/server/mcp.js'])
  await import(require.resolve(dependency));
const { default: PostalMime } = await import(require.resolve('postal-mime'));
const email = await PostalMime.parse('Subject: Synthetic runtime probe\r\n\r\nNo investment or personal data.');
assert.equal(email.subject, 'Synthetic runtime probe');
// Sharp is Next's optional dependency and may be nested under its package.
const nextRequire = createRequire(require.resolve('next/package.json'));
const sharp = nextRequire('sharp');
assert.ok((await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer()).length > 0);
const pdfWorkerName = (await readdir('/app/.next/standalone/public/pdfjs')).find((name) => /^pdf\.worker-.*\.min\.mjs$/.test(name));
assert.ok(pdfWorkerName);
for (const service of ['worker', 'folder-worker', 'mailbox-worker', 'delivery-worker', 'report-obligations-worker'])
  await access(`/app/dist-${service}/index.js`);
await access('/app/migrations/014-demo-workspaces.sql');
await access('/app/dist-ops/bootstrap.js');

// Exercise the real password-file wrapper and compiled command, stopping at the
// missing provisioning database before any connection or mutation is possible.
const temporaryBefore = (await readdir('/tmp')).filter((name) => name.startsWith('aster-bootstrap-')).sort();
async function bootstrapInput(input) {
  const bootstrap = spawn('/nodejs/bin/node', ['/opt/aster/bootstrap-stdin.mjs',
    'synthetic@example.invalid', 'Synthetic Operator', 'Synthetic Office'], {
    cwd: '/app',
    env: { PATH: '/nodejs/bin', TMPDIR: '/tmp', NODE_ENV: 'production' },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
  let errorOutput = '';
  bootstrap.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk.toString()).slice(-4000); });
  bootstrap.stdout.resume();
  const closed = new Promise((resolve, reject) => {
    bootstrap.once('error', reject);
    bootstrap.once('close', resolve);
  });
  bootstrap.stdin.end(input);
  assert.equal(await closed, 1);
  return errorOutput;
}
assert.match(await bootstrapInput(randomBytes(48).toString('base64url')), /BOOTSTRAP_DATABASE_URL or MIGRATION_DATABASE_URL is required/);
assert.match(await bootstrapInput('x'.repeat(1025)), /Bootstrap input could not be prepared/);
assert.deepEqual((await readdir('/tmp')).filter((name) => name.startsWith('aster-bootstrap-')).sort(), temporaryBefore);

const child = spawn(process.execPath, ['/opt/aster/app-entrypoint.mjs', 'node', '.next/standalone/server.js'], {
  cwd: '/app',
  env: {
    ...process.env,
    PORT: '3199',
    HOSTNAME: '127.0.0.1',
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:9/aster',
    BETTER_AUTH_URL: 'https://synthetic.example.invalid',
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
    PROCESSOR_TOKEN: randomBytes(48).toString('base64url'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AUTH_REQUIRE_MFA: 'true',
    ASTER_ENABLE_DEMO: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => { output = (output + chunk.toString()).slice(-4000); });
const exited = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
try {
  let readiness;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      readiness = await fetch('http://127.0.0.1:3199/api/health', { signal: AbortSignal.timeout(2000) });
      break;
    } catch { /* Startup is asynchronous; bounded retry. */ }
    await delay(250);
  }
  assert.equal(readiness?.status, 503, 'A missing database must not be reported healthy.');
  assert.deepEqual(await readiness.json(), { status: 'unavailable' });
  const asset = await fetch(`http://127.0.0.1:3199/pdfjs/${pdfWorkerName}`, { signal: AbortSignal.timeout(12_000) });
  assert.equal(asset.status, 200, 'The built server must serve its local PDF worker.');
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile(`/app/.next/standalone/public/pdfjs/${pdfWorkerName}`));
  // Login resolves the live database session, so it cannot succeed in this
  // deliberately disconnected probe. Database-backed auth is checked separately.
  const login = await fetch('http://127.0.0.1:3199/login', { signal: AbortSignal.timeout(12_000), redirect: 'manual' });
  assert.equal(login.status, 500, 'Login must fail closed while its session database is unavailable.');
  assert.deepEqual(login.headers.getSetCookie(), [], 'Unavailable authentication must not issue a session cookie.');
  console.log('Runtime imports, native image library, bootstrap input, secret entrypoint, served source asset and fail-closed HTTP probes passed. No database, external network or model requests.');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  timer.unref();
  await exited;
  clearTimeout(timer);
}
