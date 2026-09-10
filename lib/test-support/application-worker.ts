import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDisposableDatabase } from './disposable-database';

/** Real queue/worker transport, with two explicitly known-answer source fixtures.
 * No real processor, model, document store or mailbox may be contacted. */
export async function startApplicationFixtureWorker(
  allowedDocument: (id: string) => Promise<boolean>,
) {
  assertDisposableDatabase();
  const temporary = await mkdtemp(join(tmpdir(), 'aster-app-worker-fixture-'));
  const server = createServer((incoming, response) => {
    void (async () => {
      if (
        incoming.method !== 'POST' ||
        incoming.url !== '/v1/extract' ||
        incoming.headers['x-processor-key'] !== process.env.PROCESSOR_TOKEN
      ) {
        response.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 65536) throw new Error('Oversized fixture');
        chunks.push(chunk);
      }
      const form = await new Request('http://fixture.invalid/v1/extract', {
        method: 'POST',
        headers: { 'content-type': String(incoming.headers['content-type']) },
        body: Buffer.concat(chunks),
      }).formData();
      const documentId = form.get('document_id'),
        file = form.get('file');
      if (
        typeof documentId !== 'string' ||
        !(file instanceof File) ||
        !(await allowedDocument(documentId))
      ) {
        response.writeHead(400).end();
        return;
      }
      const text = await file.text();
      const amount =
        text ===
        'Synthetic valuation statement\nFund: Meridian Real Assets\nValuation date: 2026-06-30\nNAV: EUR 8,250,000.00'
          ? '8250000.00'
          : text ===
              'Synthetic revised valuation statement\nFund: Meridian Real Assets\nValuation date: 2026-06-30\nNAV: EUR 8,400,000.00'
            ? '8400000.00'
            : null;
      if (!amount) {
        response.writeHead(400).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            schemaVersion: 1,
            documentId,
            mode: 'workflow',
            execution: 'local',
            documentType: 'Known-answer test fixture',
            relevant: true,
            confidence: 1,
            facts: [
              {
                kind: 'valuation',
                investmentName: 'Meridian Real Assets',
                effectiveDate: '2026-06-30',
                amount,
                currency: 'EUR',
                dueDate: null,
                summary: 'Synthetic fixture reported NAV',
                evidence: { page: 1, quote: text },
              },
            ],
            warnings: [],
            trace: [
              {
                stage: 'fixture',
                status: 'complete',
                detail:
                  'Authenticated known-answer response; no model extraction claimed.',
              },
            ],
            model: null,
          }),
        );
    })().catch(() => {
      if (!response.destroyed && !response.writableEnded)
        response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture processor did not bind');
  const endpoint = 'http://127.0.0.1:' + address.port;
  const child = spawn(process.execPath, ['dist-worker/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PROCESSOR_URL: endpoint,
      WORKER_HEARTBEAT_FILE: join(temporary, 'heartbeat'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
  });
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  return {
    endpoint,
    async stop() {
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      await done;
      clearTimeout(kill);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(temporary, { recursive: true, force: true });
      return { stderrBytes };
    },
  };
}
