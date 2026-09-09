import 'server-only';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from './crypto';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const demoCatalogSchema = z
  .object({
    offices: z
      .array(
        z.object({
          id: identifier,
          name: z.string().min(1).max(150),
          currency: z.enum(['EUR', 'USD', 'GBP', 'CHF']),
          names: z.array(z.string().min(1).max(300)).min(1).max(100),
        }),
      )
      .length(3),
    mailboxes: z
      .array(
        z.object({
          id: identifier,
          office_id: identifier,
          address: z.email().max(254),
          persona: z.string().min(1).max(150),
        }),
      )
      .length(9),
    documents: z
      .array(
        z.object({
          path: z
            .string()
            .regex(/^fixtures\/emails\/[a-zA-Z0-9_-]+\.eml$/)
            .max(240),
          office_id: identifier,
          mailbox_id: identifier,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .length(100),
  })
  .superRefine((catalog, ctx) => {
    const offices = new Set(catalog.offices.map((office) => office.id));
    const mailboxes = new Map(
      catalog.mailboxes.map((mailbox) => [mailbox.id, mailbox]),
    );
    if (
      offices.size !== catalog.offices.length ||
      mailboxes.size !== catalog.mailboxes.length ||
      new Set(catalog.documents.map((document) => document.path)).size !==
        catalog.documents.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Demo identities and source paths must be unique.',
      });
    for (const mailbox of catalog.mailboxes)
      if (!offices.has(mailbox.office_id))
        ctx.addIssue({
          code: 'custom',
          message: 'Demo mailbox must belong to a known family.',
        });
    for (const document of catalog.documents)
      if (
        !offices.has(document.office_id) ||
        mailboxes.get(document.mailbox_id)?.office_id !== document.office_id
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Demo source routing must agree with its mailbox and family.',
        });
  });
export type DemoCatalog = z.infer<typeof demoCatalogSchema>;
export const demoCorpusRoot = () =>
  path.resolve(
    process.env.ASTER_DEMO_CORPUS_ROOT ??
      path.join(process.cwd(), 'benchmark/mailroom-v1'),
  );
/** Check size before allocating and reject symbolic links or sources outside the configured corpus. */
async function readBounded(relativePath: string, maxBytes: number) {
  const root = await realpath(demoCorpusRoot());
  const filename = path.join(root, relativePath);
  const resolved = await realpath(filename);
  if (resolved !== filename || !resolved.startsWith(root + path.sep))
    throw new Error('DEMO_CORPUS_PATH');
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('DEMO_CORPUS_SIZE');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead !== stat.size) throw new Error('DEMO_CORPUS_CHANGED');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
/** Routing/identity metadata only. The benchmark answer key is never loaded. */
export async function loadDemoCatalog() {
  return demoCatalogSchema.parse(
    JSON.parse(
      (await readBounded('catalog.json', 1024 * 1024)).toString('utf8'),
    ),
  );
}
export async function readDemoSource(
  document: DemoCatalog['documents'][number],
) {
  // This exported helper remains safe even when called without a prior catalog parse.
  const parsed = demoCatalogSchema.shape.documents.element.parse(document);
  const bytes = await readBounded(parsed.path, 10 * 1024 * 1024);
  if (sha256(bytes) !== parsed.sha256) throw new Error('DEMO_CORPUS_CHANGED');
  return bytes;
}
export const demoActorId = (organizationId: string) =>
  'demo-agent:' + organizationId;
export const DEMO_FX_POLICY = {
  source: 'Synthetic demo scenario FX assumptions; not market rates',
  ratesToEUR: { EUR: '1', USD: '0.92', GBP: '1.18', CHF: '1.04' },
};
