import 'server-only';
import { z } from 'zod';
import type { ArchiveReceipt } from '../archive-contract';
import { parseEmailPreview, EmailPreviewError } from './email-preview';
import { sha256 } from './crypto';
import { processorEndpoint } from './engine-store';
import { readBody } from './http';

export class ArchiveError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ArchiveError';
  }
}
export type ArchiveSource = {
  organizationId: string;
  documentId: string;
  filename: string;
  mimeType: string;
  contentHash: string;
  bytes: Buffer;
  importedAt: string;
  archiveRevision: number;
  /** First queue time, frozen with the classification metadata for retries. */
  archivedAt: string;
  family?: { id: string; name: string };
  investment?: { id: string; name: string };
  classificationBasis?: string;
  classificationFrozenAt?: string;
};
export type ArchiveFile = { path: string; mimeType: string; bytes: Buffer };
export type ArchiveBundle = {
  source: Omit<ArchiveSource, 'bytes'>;
  relativePath: string;
  files: ArchiveFile[];
  manifestSha256: string;
  warnings: string[];
};
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const ARCHIVE_LIMITS = {
  sourceBytes: 10 * 1024 * 1024,
  totalBytes: 40 * 1024 * 1024,
  files: 80,
};
const ArtifactSchema = z.object({
  base64: z.string().max(18_000_000),
  sha256: z.string().regex(SHA),
});
const SnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  rendererVersion: z.string().max(100),
  canonicalText: z.string().max(2_004_096),
  warnings: z.array(z.string().max(2000)).max(50),
  truncated: z.boolean(),
  pageCount: z.number().int().min(1).max(8),
  fontProfile: z.string().max(200),
  pngPages: z
    .array(
      ArtifactSchema.extend({
        page: z.number().int().min(1).max(8),
        width: z.number().int().min(1).max(1240),
        height: z.number().int().min(1).max(1754),
      }),
    )
    .min(1)
    .max(8),
  pdf: ArtifactSchema,
});
export type ArchiveEmailSnapshot = z.infer<typeof SnapshotSchema>;
export type ArchiveSnapshotInput = {
  schemaVersion: 1;
  headers: { name: string; value: string }[];
  textBody: string;
  attachmentNames: string[];
  sourceSha256?: string;
};
export type ArchiveSnapshotRenderer = (
  input: ArchiveSnapshotInput,
  signal?: AbortSignal,
) => Promise<ArchiveEmailSnapshot>;

/** Always use the deployment-local renderer. Engine selection never grants archive egress. */
export async function renderArchiveEmailSnapshot(
  input: ArchiveSnapshotInput,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ArchiveEmailSnapshot> {
  const token = process.env.PROCESSOR_TOKEN;
  if (!token || token.length < 24)
    throw new ArchiveError('SNAPSHOT_UNAVAILABLE');
  try {
    const endpoint = processorEndpoint('local');
    if (
      ![
        'processor',
        'localhost',
        '127.0.0.1',
        '[::1]',
        'host.docker.internal',
      ].includes(endpoint.hostname)
    )
      throw new ArchiveError('ARCHIVE_RENDERER_NOT_LOCAL');
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 512 * 1024)
      throw new ArchiveError('SNAPSHOT_INPUT_LIMIT');
    const response = await fetcher(
      new URL('/v1/archive/email-snapshot', endpoint),
      {
        method: 'POST',
        body,
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'X-Processor-Key': token,
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    if (!response.ok) {
      void response.body?.cancel();
      throw new ArchiveError(
        response.status === 503 ? 'PROCESSOR_BUSY' : 'SNAPSHOT_UNAVAILABLE',
      );
    }
    const bytes = await readBody(
      new Request('http://archive.invalid', {
        method: 'POST',
        body: response.body,
        duplex: 'half',
      } as RequestInit),
      18 * 1024 * 1024,
    );
    return SnapshotSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(
      signal?.aborted ? 'ARCHIVE_CANCELLED' : 'SNAPSHOT_UNAVAILABLE',
    );
  }
}
function safeLabel(value: string, fallback: string, limit = 64) {
  let label = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '-')
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, limit)
    .trim();
  while (Buffer.byteLength(label) > 180)
    label = Array.from(label).slice(0, -1).join('');
  return label && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(label)
    ? label
    : fallback;
}
function entityDirectory(
  entity: { id: string; name: string } | undefined,
  fallback: string,
) {
  if (!entity) return fallback;
  // The identifier prevents identically named families/investments from colliding.
  return (
    safeLabel(entity.name, fallback, 48) + '--' + sha256(entity.id).slice(0, 12)
  );
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
}
function artifactBytes(
  value: { base64: string; sha256: string },
  kind: 'png' | 'pdf',
) {
  if (
    value.base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)
  )
    throw new ArchiveError('SNAPSHOT_INVALID');
  const bytes = Buffer.from(value.base64, 'base64');
  if (bytes.toString('base64') !== value.base64)
    throw new ArchiveError('SNAPSHOT_INVALID');
  const valid =
    kind === 'png'
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (!valid || sha256(bytes) !== value.sha256)
    throw new ArchiveError('SNAPSHOT_INVALID');
  return bytes;
}
export async function buildArchiveBundle(
  source: ArchiveSource,
  renderer: ArchiveSnapshotRenderer = renderArchiveEmailSnapshot,
  signal?: AbortSignal,
): Promise<ArchiveBundle> {
  if (
    !UUID.test(source.organizationId) ||
    !UUID.test(source.documentId) ||
    !SHA.test(source.contentHash) ||
    !Number.isSafeInteger(source.archiveRevision) ||
    source.archiveRevision < 1 ||
    source.bytes.length < 1 ||
    source.bytes.length > ARCHIVE_LIMITS.sourceBytes ||
    sha256(source.bytes) !== source.contentHash ||
    !Number.isFinite(Date.parse(source.importedAt)) ||
    !Number.isFinite(Date.parse(source.archivedAt))
  )
    throw new ArchiveError('ARCHIVE_SOURCE_INVALID');
  if (signal?.aborted) throw new ArchiveError('ARCHIVE_CANCELLED');
  const { bytes: _bytes, ...metadata } = source;
  const date = new Date(source.importedAt).toISOString();
  const relativePath = [
    'r' + source.archiveRevision,
    date.slice(0, 4),
    date.slice(5, 7),
    entityDirectory(source.family, 'Unassigned family'),
    entityDirectory(source.investment, 'Unassigned investment'),
    date.slice(0, 10) +
      '--' +
      safeLabel(source.filename, 'source', 48) +
      '--' +
      source.documentId.toLowerCase(),
  ].join('/');
  const email =
    source.mimeType === 'message/rfc822' ||
    (source.mimeType === 'text/plain' && /\.eml$/i.test(source.filename));
  const originalPath = email
    ? 'original.eml'
    : source.mimeType === 'application/pdf'
      ? 'original.pdf'
      : 'original.txt';
  const files: ArchiveFile[] = [
    { path: originalPath, mimeType: source.mimeType, bytes: source.bytes },
  ];
  const warnings: string[] = [];
  let emailMetadata: Record<string, unknown> | undefined;
  if (email) {
    let parsed;
    try {
      parsed = await parseEmailPreview(
        source.bytes,
        source.documentId,
        source.filename,
      );
    } catch (error) {
      if (!(error instanceof EmailPreviewError)) throw error;
      warnings.push(
        'Email derivatives unavailable (' +
          error.code +
          '). The complete original email remains preserved.',
      );
    }
    if (parsed) {
      const snapshotInput: ArchiveSnapshotInput = {
        schemaVersion: 1,
        headers: [
          ...parsed.archiveHeaders.map((h) => ({
            name: h.name,
            value: h.value.slice(0, 2000),
          })),
          {
            name: 'X-Aster-Retained-At',
            value: new Date(source.importedAt).toISOString(),
          },
        ],
        textBody: parsed.response.body,
        attachmentNames: parsed.attachments.map((a) => a.filename),
        sourceSha256: source.contentHash,
      };
      const metadataCharacters =
        snapshotInput.headers.reduce(
          (n, h) => n + h.name.length + h.value.length,
          0,
        ) +
        snapshotInput.attachmentNames.reduce((n, name) => n + name.length, 0);
      snapshotInput.textBody = snapshotInput.textBody.slice(
        0,
        Math.max(0, 195_000 - metadataCharacters),
      );
      while (
        Buffer.byteLength(JSON.stringify(snapshotInput)) > 500_000 &&
        snapshotInput.textBody.length
      )
        snapshotInput.textBody = snapshotInput.textBody.slice(
          0,
          Math.floor(snapshotInput.textBody.length * 0.8),
        );
      const bodyAbbreviated =
        snapshotInput.textBody.length !== parsed.response.body.length;
      if (bodyAbbreviated)
        warnings.push(
          'The rendered body is abbreviated to fit the copy resource limits; original.eml retains the complete email.',
        );
      const snapshot = SnapshotSchema.parse(
        await renderer(snapshotInput, signal),
      );
      if (
        snapshot.pngPages.length !== snapshot.pageCount ||
        snapshot.pngPages.some((page, index) => page.page !== index + 1)
      )
        throw new ArchiveError('SNAPSHOT_INVALID');
      warnings.push(...parsed.response.warnings, ...snapshot.warnings);
      if (snapshot.truncated || parsed.response.bodyTruncated)
        warnings.push(
          'The rendered copy is abbreviated; consult original.eml for the complete source.',
        );
      if (parsed.archiveHeaders.some((header) => header.value.length > 2000))
        warnings.push(
          'Long address/header fields are abbreviated in the rendered copy; original.eml retains all headers.',
        );
      files.push({
        path: 'email.txt',
        mimeType: 'text/plain',
        bytes: Buffer.from(snapshot.canonicalText),
      });
      files.push({
        path: 'email.html',
        mimeType: 'text/html',
        bytes: Buffer.from(
          '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rendered email copy</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 24px;color:#222}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style><body><h1>Rendered email copy</h1><p>Original email retained as original.eml. This copy does not reproduce the original mailbox layout. Remote content is not loaded.</p><pre>' +
            escapeHtml(snapshot.canonicalText) +
            '</pre></body></html>',
        ),
      });
      for (const page of snapshot.pngPages)
        files.push({
          path: 'email-page-' + String(page.page).padStart(3, '0') + '.png',
          mimeType: 'image/png',
          bytes: artifactBytes(page, 'png'),
        });
      files.push({
        path: 'email.pdf',
        mimeType: 'application/pdf',
        bytes: artifactBytes(snapshot.pdf, 'pdf'),
      });
      const attachments = parsed.attachments.map((attachment, index) => {
        const filename =
          String(index + 1).padStart(3, '0') +
          '-' +
          safeLabel(attachment.filename, 'attachment.bin', 100);
        files.push({
          path: 'attachments/' + filename,
          mimeType: attachment.mimeType || 'application/octet-stream',
          bytes: attachment.content,
        });
        return {
          originalFilename: attachment.filename,
          path: 'attachments/' + filename,
          mimeType: attachment.mimeType,
          byteSize: attachment.content.length,
          sha256: sha256(attachment.content),
        };
      });
      emailMetadata = {
        headers: parsed.archiveHeaders,
        bodyTruncated: parsed.response.bodyTruncated,
        rendererVersion: snapshot.rendererVersion,
        fontProfile: snapshot.fontProfile,
        renderedPageCount: snapshot.pageCount,
        renderedCopyTruncated:
          snapshot.truncated ||
          bodyAbbreviated ||
          parsed.response.bodyTruncated,
        attachments,
      };
    }
  }
  const uniqueWarnings = [...new Set(warnings)];
  const manifest = {
    schemaVersion: 1,
    format: 'aster-source-archive-v1',
    organizationId: source.organizationId,
    documentId: source.documentId,
    destinationRevision: source.archiveRevision,
    originalFilename: source.filename,
    originalMimeType: source.mimeType,
    originalSha256: source.contentHash,
    importedAt: new Date(source.importedAt).toISOString(),
    archiveRequestedAt: new Date(source.archivedAt).toISOString(),
    dateBasis:
      'Aster retention time in UTC; message Date headers are separate unverified source claims.',
    classification: {
      family: source.family ?? null,
      investment: source.investment ?? null,
      basis:
        source.classificationBasis ??
        'No reviewed classification at archive time.',
      frozenAt: source.classificationFrozenAt ?? source.archivedAt,
    },
    relativePath,
    email: emailMetadata ?? null,
    files: files.map((file) => ({
      path: file.path,
      mimeType: file.mimeType,
      byteSize: file.bytes.length,
      sha256: sha256(file.bytes),
    })),
    warnings: uniqueWarnings,
    integrity:
      'Compare these files with the encrypted receipt retained in Aster. A manifest alone is not independent proof against modification.',
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  files.push({
    path: 'manifest.json',
    mimeType: 'application/json',
    bytes: manifestBytes,
  });
  if (
    files.length > ARCHIVE_LIMITS.files ||
    files.reduce((total, file) => total + file.bytes.length, 0) >
      ARCHIVE_LIMITS.totalBytes
  )
    throw new ArchiveError('ARCHIVE_BUNDLE_LIMIT');
  return {
    source: metadata,
    relativePath,
    files,
    manifestSha256: sha256(manifestBytes),
    warnings: uniqueWarnings,
  };
}
export function receiptForArchive(
  bundle: ArchiveBundle,
  archivedAt: string,
): ArchiveReceipt {
  return {
    provider: 'local',
    relativePath: bundle.relativePath,
    manifestSha256: bundle.manifestSha256,
    originalSha256: bundle.source.contentHash,
    archivedAt,
    files: bundle.files.map((file) => ({
      path: file.path,
      mimeType: file.mimeType,
      byteSize: file.bytes.length,
      sha256: sha256(file.bytes),
    })),
    warnings: bundle.warnings,
  };
}
