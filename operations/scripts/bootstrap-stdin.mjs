import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Container-only wrapper: the operator's password enters stdin, never argv or
// environment. The compiled bootstrap remains responsible for all validation.
let directory;
let child;
try {
  const [email, name, organization, ...extra] = process.argv.slice(2);
  if (!email || !name || !organization || extra.length)
    throw new Error('Expected email, name and organization arguments');
  directory = await mkdtemp(join(tmpdir(), 'aster-bootstrap-'));
  const passwordFile = join(directory, 'password');
  let password = Buffer.alloc(0);
  try {
    for await (const chunk of process.stdin) {
      if (password.length + chunk.length > 1024) throw new Error('Password input exceeds its limit');
      const next = Buffer.concat([password, chunk]);
      password.fill(0);
      password = next;
    }
    await writeFile(passwordFile, password, { mode: 0o600, flag: 'wx' });
  } finally {
    password.fill(0);
  }
  child = spawn(process.execPath, ['/app/dist-ops/bootstrap.js', '--email', email,
    '--name', name, '--organization', organization], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, BOOTSTRAP_PASSWORD_FILE: passwordFile },
  });
  const handlers = ['SIGTERM', 'SIGINT'].map((signal) => {
    const forward = () => child.kill(signal);
    process.on(signal, forward);
    return [signal, forward];
  });
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    for (const [signal, forward] of handlers) process.off(signal, forward);
  }
} catch {
  // I/O and process errors can contain confidential operator paths or values.
  console.error('Bootstrap input could not be prepared or the command could not start.');
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
