import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  truncate,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
vi.mock('server-only', () => ({}));
import {
  FolderConnectSchema,
  FolderDirectorySchema,
} from '../folder-connection-contract';
import {
  listIntakeDirectories,
  resolveFolderDirectory,
  scanFolderFiles,
  readFolderFile,
  validateFolderBytes,
  MAX_FOLDER_FILE_BYTES,
} from './folder-files';

describe('local intake path and original-byte boundaries', () => {
  let intake: string, org: string, root: string;
  beforeEach(async () => {
    intake = await mkdtemp(path.join(tmpdir(), 'aster-folder-test-'));
    org = randomUUID();
    root = path.join(intake, org, 'Demo mails');
    await mkdir(root, { recursive: true });
    vi.stubEnv('ASTER_INTAKE_ROOT', intake);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(intake, { recursive: true, force: true });
  });
  it.each([
    '../foreign',
    '/etc',
    'a/../../b',
    'a\\b',
    '.',
    'a//b',
    'a/.hidden',
    'a/..',
    'a\0b',
    'a\nb',
  ])('refuses unsafe relative input %j', (value) => {
    expect(FolderDirectorySchema.safeParse(value).success).toBe(false);
  });
  it('does not allow a client to declare a trusted demo source', () => {
    expect(
      FolderConnectSchema.safeParse({
        directory: 'Demo mails',
        displayName: 'Demo',
        isDemo: true,
      }).success,
    ).toBe(false);
  });
  it('lists only approved tenant directories and preserves MIME/PDF originals exactly', async () => {
    await mkdir(path.join(root, 'Family A'));
    const source = Buffer.from(
      'From: manager@example.invalid\r\nSubject: NAV\r\n\r\nEUR 100\r\n',
    );
    await writeFile(path.join(root, 'Family A', 'message.eml'), source);
    await writeFile(
      path.join(root, 'statement.pdf'),
      '%PDF-1.4\nsynthetic bytes',
    );
    await writeFile(path.join(root, 'notes.txt'), 'Investment update');
    await writeFile(path.join(root, 'ignored.csv'), 'not imported');
    await mkdir(path.join(intake, randomUUID(), 'Foreign office'), {
      recursive: true,
    });
    expect(await listIntakeDirectories(org, 'Demo mails')).toEqual([
      { directory: 'Demo mails', displayName: 'Demo mails', isDemo: true },
    ]);
    const files = await scanFolderFiles(org, 'Demo mails');
    expect(files.map((file) => file.relativePath)).toEqual([
      'Family A/message.eml',
      'notes.txt',
      'statement.pdf',
    ]);
    expect((await readFolderFile(org, 'Demo mails', files[0])).bytes).toEqual(
      source,
    );
    expect(await readFile(path.join(root, 'Family A', 'message.eml'))).toEqual(
      source,
    );
  });
  it('refuses tenant/directory/file symlinks and hard links', async () => {
    const foreign = path.join(intake, 'private');
    await mkdir(foreign);
    await writeFile(path.join(foreign, 'private.txt'), 'private content');
    await symlink(foreign, path.join(root, 'link'));
    await expect(scanFolderFiles(org, 'Demo mails')).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    await rm(path.join(root, 'link'));
    await symlink(
      path.join(foreign, 'private.txt'),
      path.join(root, 'unsafe.txt'),
    );
    await expect(scanFolderFiles(org, 'Demo mails')).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    await rm(path.join(root, 'unsafe.txt'));
    await link(path.join(foreign, 'private.txt'), path.join(root, 'hard.txt'));
    await expect(scanFolderFiles(org, 'Demo mails')).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    const linkedOrg = randomUUID();
    await symlink(path.join(intake, org), path.join(intake, linkedOrg));
    await expect(
      resolveFolderDirectory(linkedOrg, 'Demo mails'),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
  it('refuses a file swapped after discovery, including a symlink substitution', async () => {
    const filename = path.join(root, 'report.txt');
    await writeFile(filename, 'Original');
    const [file] = await scanFolderFiles(org, 'Demo mails');
    await writeFile(filename, 'Changed document');
    await expect(readFolderFile(org, 'Demo mails', file)).rejects.toMatchObject(
      { code: 'FILE_CHANGED' },
    );
    await rm(filename);
    await symlink('/etc/hosts', filename);
    await expect(readFolderFile(org, 'Demo mails', file)).rejects.toMatchObject(
      { code: 'FILE_UNAVAILABLE' },
    );
  });
  it('rejects oversized files without reading unbounded bytes', async () => {
    const filename = path.join(root, 'huge.pdf');
    await writeFile(filename, '%PDF-1.4');
    await truncate(filename, MAX_FOLDER_FILE_BYTES + 1);
    const [file] = await scanFolderFiles(org, 'Demo mails');
    expect(await readFolderFile(org, 'Demo mails', file)).toMatchObject({
      bytes: null,
      outcome: 'oversize',
      mime: 'application/pdf',
    });
  });
  it.each([
    ['bad.pdf', Buffer.from('Not a PDF')],
    ['empty.txt', Buffer.alloc(0)],
    ['binary.txt', Buffer.from([65, 0, 66])],
    ['bad.eml', Buffer.from('Missing mail headers')],
  ])('records malformed %s as invalid', (filename, bytes) => {
    expect(validateFolderBytes(filename, bytes).outcome).toBe('invalid');
  });
  it('fails explicitly when recursive directory depth exceeds the intake bound', async () => {
    await mkdir(
      path.join(root, ...Array.from({ length: 14 }, (_, i) => String(i))),
      { recursive: true },
    );
    await expect(scanFolderFiles(org, 'Demo mails')).rejects.toMatchObject({
      code: 'SCAN_LIMIT',
    });
  });
});
