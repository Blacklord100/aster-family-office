import { build } from 'esbuild';
await build({
  entryPoints: ['scripts/worker.ts'],
  outfile: 'dist-worker/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  alias: { 'server-only': './scripts/server-only-stub.ts' },
  sourcemap: false,
});
for (const name of ['migrate', 'bootstrap'])
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
