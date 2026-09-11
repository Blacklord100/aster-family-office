import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
vi.mock('server-only', () => ({}));
import { sha256 } from './crypto';
import {
  ArchiveError,
  buildArchiveBundle,
  renderArchiveEmailSnapshot,
  type ArchiveSource,
  type ArchiveEmailSnapshot,
} from './archive-bundle';
import {
  testLocalArchiveDestination,
  readLocalArchiveFile,
  verifyLocalArchiveReceipt,
  writeLocalArchiveBundle,
} from './archive-provider';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6m0AAAAASUVORK5CYII=',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n% synthetic renderer test only\n%%EOF\n');
const fakeSnapshot = (
  canonicalText = 'From: Synthetic sender\n\nExample <script>never execute</script>',
): ArchiveEmailSnapshot => ({
  schemaVersion: 1,
  rendererVersion: 'synthetic-test-v1',
  canonicalText,
  warnings: [],
  truncated: false,
  pageCount: 1,
  fontProfile: 'test',
  pngPages: [
    {
      page: 1,
      width: 1,
      height: 1,
      base64: PNG.toString('base64'),
      sha256: sha256(PNG),
    },
  ],
  pdf: { base64: PDF.toString('base64'), sha256: sha256(PDF) },
});
const emailBytes = () =>
  Buffer.from(
    [
      'From: Manager <manager@example.invalid>',
      'To: office@example.invalid',
      'Cc: adviser@example.invalid',
      'Date: Tue, 1 Sep 2026 10:30:00 +0300',
      'Message-ID: <synthetic-archive@example.invalid>',
      'Subject: Quarterly investment report',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="archive-test"',
      '',
      '--archive-test',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Quarterly NAV: EUR 123.45. See the attached report.',
      '--archive-test',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="../../report.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      PDF.toString('base64'),
      '--archive-test',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="../../report.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      PDF.toString('base64'),
      '--archive-test--',
      '',
    ].join('\r\n'),
  );

describe('source archive bundles and local storage integrity', () => {
  let root: string, org: string;
  function source(
    bytes = Buffer.from('Original investment update'),
    mimeType = 'text/plain',
  ): ArchiveSource {
    return {
      organizationId: org,
      documentId: randomUUID(),
      filename: mimeType === 'message/rfc822' ? 'quarterly.eml' : 'update.txt',
      mimeType,
      contentHash: sha256(bytes),
      bytes,
      importedAt: '2026-09-11T08:00:00.000Z',
      archiveRevision: 1,
      archivedAt: '2026-09-11T09:00:00.000Z',
      family: { id: 'family-1', name: 'Alder Family Office' },
      investment: { id: 'holding-1', name: 'Shared Infrastructure' },
      classificationBasis: 'Reviewed source association',
    };
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aster-archive-'));
    org = randomUUID();
    vi.stubEnv('ASTER_ARCHIVE_ROOT', root);
    vi.stubEnv('ASTER_INTAKE_ROOT', '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('creates a private user-defined destination and removes its write probe', async () => {
    expect(
      (await testLocalArchiveDestination(org, 'Compliance/Originals')).ok,
    ).toBe(true);
    const folder = path.join(root, org, 'Compliance', 'Originals');
    expect(await readdir(folder)).toEqual([]);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });
  it.each([
    '../foreign',
    '/etc',
    'a/../../b',
    'a\\b',
    'a/.hidden',
    'a//b',
    'a\0b',
    'a\nb',
    'a\u202Eb',
    'a:b',
  ])('rejects unsafe destination %j', async (directory) => {
    await expect(
      testLocalArchiveDestination(org, directory),
    ).rejects.toBeInstanceOf(ArchiveError);
  });
  it('refuses overlap with intake in either direction', async () => {
    vi.stubEnv('ASTER_INTAKE_ROOT', root);
    await expect(
      testLocalArchiveDestination(org, 'Archive'),
    ).rejects.toMatchObject({ code: 'ARCHIVE_INTAKE_OVERLAP' });
    const child = path.join(root, 'intake');
    await mkdir(child);
    vi.stubEnv('ASTER_INTAKE_ROOT', child);
    await expect(
      testLocalArchiveDestination(org, 'Archive'),
    ).rejects.toMatchObject({ code: 'ARCHIVE_INTAKE_OVERLAP' });
  });
  it('refuses tenant symlinks and unsafe directory permissions', async () => {
    const foreign = path.join(root, 'foreign');
    await mkdir(foreign, { mode: 0o700 });
    await symlink(foreign, path.join(root, org));
    await expect(
      testLocalArchiveDestination(org, 'Archive'),
    ).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_PATH' });
    await rm(path.join(root, org));
    await mkdir(path.join(root, org), { mode: 0o755 });
    await expect(
      testLocalArchiveDestination(org, 'Archive'),
    ).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_PATH' });
  });
  it('preserves original bytes, creates structured paths and verifies against the retained receipt', async () => {
    const original = source();
    const bundle = await buildArchiveBundle(original);
    const receipt = await writeLocalArchiveBundle(org, 'Compliance', bundle);
    expect(receipt.relativePath).toMatch(
      /^r1\/2026\/09\/Alder Family Office--[a-f0-9]{12}\/Shared Infrastructure--[a-f0-9]{12}\//,
    );
    const base = path.join(root, org, 'Compliance', receipt.relativePath);
    expect(await readFile(path.join(base, 'original.txt'))).toEqual(
      original.bytes,
    );
    const manifest = JSON.parse(
      await readFile(path.join(base, 'manifest.json'), 'utf8'),
    );
    expect(manifest.originalSha256).toBe(original.contentHash);
    expect(manifest.classification.family.id).toBe('family-1');
    expect(manifest.importedAt).toBe(original.importedAt);
    expect(manifest.dateBasis).toContain('message Date headers are separate');
    expect((await stat(path.join(base, 'original.txt'))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      (await verifyLocalArchiveReceipt(org, 'Compliance', receipt)).ok,
    ).toBe(true);
    expect(await readLocalArchiveFile(org, 'Compliance', receipt, 0)).toEqual(
      original.bytes,
    );
    await expect(
      readLocalArchiveFile(org, 'Compliance', receipt, 999),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FILE_NOT_FOUND' });
    expect(
      (await verifyLocalArchiveReceipt(randomUUID(), 'Compliance', receipt)).ok,
    ).toBe(false);
    const before = await stat(path.join(base, 'original.txt'));
    const replay = await writeLocalArchiveBundle(org, 'Compliance', bundle);
    expect(replay.manifestSha256).toBe(receipt.manifestSha256);
    expect((await stat(path.join(base, 'original.txt'))).mtimeMs).toBe(
      before.mtimeMs,
    );
  });
  it('extracts duplicate-named attachments separately, retains the EML and renders safe readable copies', async () => {
    const original = source(emailBytes(), 'message/rfc822');
    const renderer = vi.fn(async () => fakeSnapshot());
    const bundle = await buildArchiveBundle(original, renderer);
    const receipt = await writeLocalArchiveBundle(org, 'Compliance', bundle);
    const base = path.join(root, org, 'Compliance', receipt.relativePath);
    expect(await readFile(path.join(base, 'original.eml'))).toEqual(
      original.bytes,
    );
    const attachments = bundle.files.filter((file) =>
      file.path.startsWith('attachments/'),
    );
    expect(attachments).toHaveLength(2);
    expect(new Set(attachments.map((file) => file.path)).size).toBe(2);
    expect(
      attachments.every(
        (file) => file.bytes.equals(PDF) && !file.path.includes('../'),
      ),
    ).toBe(true);
    expect(await readFile(path.join(base, 'email.pdf'))).toEqual(PDF);
    expect(await readFile(path.join(base, 'email-page-001.png'))).toEqual(PNG);
    const html = await readFile(path.join(base, 'email.html'), 'utf8');
    expect(html).toContain('&lt;script&gt;never execute&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain("default-src 'none'");
    const request = renderer.mock.calls[0] as unknown as [
      { headers: { name: string; value: string }[] },
    ];
    expect(request[0].headers).toContainEqual({
      name: 'Cc',
      value: 'adviser@example.invalid',
    });
    expect(
      (await verifyLocalArchiveReceipt(org, 'Compliance', receipt)).ok,
    ).toBe(true);
  });
  it('does not guess missing ownership, overwrite a modified original, or trust an altered manifest', async () => {
    const original = source();
    delete original.family;
    delete original.investment;
    const bundle = await buildArchiveBundle(original);
    expect(bundle.relativePath).toContain(
      '/Unassigned family/Unassigned investment/',
    );
    const receipt = await writeLocalArchiveBundle(org, 'Compliance', bundle);
    const base = path.join(root, org, 'Compliance', receipt.relativePath);
    await writeFile(
      path.join(base, 'original.txt'),
      'Tampered investment update',
      { mode: 0o600 },
    );
    await writeFile(path.join(base, 'manifest.json'), '{}', { mode: 0o600 });
    expect(
      (await verifyLocalArchiveReceipt(org, 'Compliance', receipt)).ok,
    ).toBe(false);
    await expect(
      writeLocalArchiveBundle(org, 'Compliance', bundle),
    ).rejects.toMatchObject({ code: 'ARCHIVE_CONFLICT' });
    await expect(
      readLocalArchiveFile(org, 'Compliance', receipt, 0),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FILE_CHANGED' });
    expect(await readFile(path.join(base, 'original.txt'), 'utf8')).toBe(
      'Tampered investment update',
    );
  });
  it('detects unexpected files, hard links, missing files and widened file permissions', async () => {
    const bundle = await buildArchiveBundle(source());
    const receipt = await writeLocalArchiveBundle(org, 'Compliance', bundle);
    const base = path.join(root, org, 'Compliance', receipt.relativePath);
    await link(path.join(base, 'original.txt'), path.join(base, 'extra.txt'));
    expect(
      (await verifyLocalArchiveReceipt(org, 'Compliance', receipt)).ok,
    ).toBe(false);
    await rm(path.join(base, 'extra.txt'));
    await chmod(path.join(base, 'original.txt'), 0o644);
    expect(
      (await verifyLocalArchiveReceipt(org, 'Compliance', receipt)).ok,
    ).toBe(false);
    await rm(path.join(base, 'original.txt'));
    expect(
      (await verifyLocalArchiveReceipt(org, 'Compliance', receipt)).ok,
    ).toBe(false);
  });
  it('does not publish when the final lease/configuration guard refuses and removes staging files', async () => {
    const bundle = await buildArchiveBundle(source());
    await expect(
      writeLocalArchiveBundle(org, 'Compliance', bundle, {
        publish: async () => {
          throw new ArchiveError('ARCHIVE_PAUSED');
        },
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_PAUSED' });
    const parent = path.join(
      root,
      org,
      'Compliance',
      path.dirname(bundle.relativePath),
    );
    expect(await readdir(parent)).toEqual([]);
  });
  it('refuses source or renderer hash mismatches and marks abbreviated derivatives explicitly', async () => {
    const invalid = source();
    invalid.bytes = Buffer.from('Changed');
    await expect(buildArchiveBundle(invalid)).rejects.toMatchObject({
      code: 'ARCHIVE_SOURCE_INVALID',
    });
    const snapshot = fakeSnapshot();
    snapshot.pdf.sha256 = '0'.repeat(64);
    await expect(
      buildArchiveBundle(
        source(emailBytes(), 'message/rfc822'),
        async () => snapshot,
      ),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' });
    const abbreviated = fakeSnapshot();
    abbreviated.truncated = true;
    const bundle = await buildArchiveBundle(
      source(emailBytes(), 'message/rfc822'),
      async () => abbreviated,
    );
    expect(bundle.warnings.join(' ')).toContain('abbreviated');
  });
  it('preserves a MIME-limit original with explicit derivative warning', async () => {
    const bytes = Buffer.from(
      'From: example@example.invalid\r\n\r\n' + '--over-budget\r\n'.repeat(130),
    );
    const renderer = vi.fn(async () => fakeSnapshot());
    const bundle = await buildArchiveBundle(
      source(bytes, 'message/rfc822'),
      renderer,
    );
    expect(bundle.files.map((file) => file.path)).toEqual([
      'original.eml',
      'manifest.json',
    ]);
    expect(bundle.warnings.join(' ')).toContain('EMAIL_PREVIEW_PART_LIMIT');
    expect(renderer).not.toHaveBeenCalled();
  });
  it('respects combined renderer text and UTF-8 budgets for a long Unicode email', async () => {
    const bytes = Buffer.from(
      'From: manager@example.invalid\r\nTo: office@example.invalid\r\nDate: Fri, 11 Sep 2026 08:00:00 +0000\r\nSubject: Long source\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
        '投資'.repeat(100_000),
    );
    const renderer = vi.fn(
      async (input: {
        headers: { name: string; value: string }[];
        textBody: string;
        attachmentNames: string[];
      }) => {
        expect(input.headers.every((h) => /^[A-Za-z0-9-]+$/.test(h.name))).toBe(
          true,
        );
        expect(
          input.textBody.length +
            input.headers.reduce(
              (n, h) => n + h.name.length + h.value.length,
              0,
            ) +
            input.attachmentNames.reduce((n, name) => n + name.length, 0),
        ).toBeLessThanOrEqual(200_000);
        expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(
          512 * 1024,
        );
        return fakeSnapshot();
      },
    );
    const bundle = await buildArchiveBundle(
      source(bytes, 'message/rfc822'),
      renderer,
    );
    expect(bundle.warnings.join(' ')).toContain('abbreviated');
    expect(bundle.files[0].bytes).toEqual(bytes);
  });
  it('uses only the fixed local renderer and classifies busy without exposing errors', async () => {
    vi.stubEnv('PROCESSOR_URL', 'http://127.0.0.1:8012');
    vi.stubEnv('PROCESSOR_CLOUD_URL', 'https://cloud.example.invalid');
    vi.stubEnv('PROCESSOR_TOKEN', 'synthetic-archive-auth-key-long-enough');
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(fakeSnapshot()),
    );
    await renderArchiveEmailSnapshot(
      {
        schemaVersion: 1,
        headers: [],
        textBody: 'Synthetic source',
        attachmentNames: [],
      },
      undefined,
      fetcher,
    );
    expect((fetcher.mock.calls[0][0] as URL).href).toBe(
      'http://127.0.0.1:8012/v1/archive/email-snapshot',
    );
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
    await expect(
      renderArchiveEmailSnapshot(
        { schemaVersion: 1, headers: [], textBody: '', attachmentNames: [] },
        undefined,
        async () => new Response('private server details', { status: 503 }),
      ),
    ).rejects.toMatchObject({ code: 'PROCESSOR_BUSY' });
  });
  it.each([
    'https://remote.example.invalid',
    'https://processor-cloud',
    'http://processor-cloud:8000',
  ])(
    'refuses archive rendering through %s before sending data',
    async (endpoint) => {
      vi.stubEnv('PROCESSOR_URL', endpoint);
      vi.stubEnv('PROCESSOR_TOKEN', 'synthetic-archive-auth-key-long-enough');
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        renderArchiveEmailSnapshot(
          {
            schemaVersion: 1,
            headers: [],
            textBody: 'Private original',
            attachmentNames: [],
          },
          undefined,
          fetcher,
        ),
      ).rejects.toMatchObject({ code: 'ARCHIVE_RENDERER_NOT_LOCAL' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
