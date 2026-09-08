import { copyFile, mkdir, readFile } from 'node:fs/promises';

// Keep this pin aligned with the dependency and lib/pdf-preview.ts. Never fetch a worker at runtime.
const version = '6.3.289';
const root = new URL('../', import.meta.url);
const packageRoot = new URL('node_modules/pdfjs-dist/', root);
const metadata = JSON.parse(
  await readFile(new URL('package.json', packageRoot), 'utf8'),
);
if (metadata.version !== version)
  throw new Error(
    'PDF worker version does not match the reviewed application pin.',
  );
const destination = new URL('public/pdfjs/', root);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL('build/pdf.worker.min.mjs', packageRoot),
  new URL(`pdf.worker-${version}.min.mjs`, destination),
);
await copyFile(
  new URL('LICENSE', packageRoot),
  new URL('LICENSE', destination),
);
console.log(
  `Prepared local PDF worker ${version}; no fonts, WASM or scripting assets copied.`,
);
