import { build } from 'esbuild';
for (const name of [
  'worker',
  'mailbox-worker',
  'folder-worker',
  'archive-worker',
  'delivery-worker',
  'report-obligations-worker',
])
  await build({
    entryPoints: ['scripts/' + name + '.ts'],
    outfile: 'dist-' + name + '/index.js',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    alias: { 'server-only': './scripts/server-only-stub.ts' },
    sourcemap: false,
  });
for (const name of [
  'migrate',
  'lifecycle',
  'recovery-sessions',
  'bootstrap',
  'rotate-keys',
  'encryption-maintenance',
  'monitor',
  'demo-status',
])
  await build({
    entryPoints: ['scripts/' + name + '.ts'],
    outfile: 'dist-ops/' + name + '.js',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    alias: { 'server-only': './scripts/server-only-stub.ts' },
    sourcemap: false,
  });
