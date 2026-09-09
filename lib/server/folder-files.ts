import 'server-only';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  FolderDirectorySchema,
  type FolderDirectory,
} from '../folder-connection-contract';

export const MAX_FOLDER_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FOLDER_ENTRIES = 10_000;
export const MAX_FOLDER_DEPTH = 12;
export const MAX_FOLDER_SCAN_BYTES = 100 * 1024 * 1024;
export class FolderError extends Error {
  constructor(
    public readonly code:
      | 'INTAKE_NOT_CONFIGURED'
      | 'DIRECTORY_UNAVAILABLE'
      | 'UNSAFE_PATH'
      | 'SCAN_LIMIT'
      | 'FILE_CHANGED'
      | 'FILE_UNAVAILABLE'
      | 'SYNC_FAILED',
  ) {
    super(code);
    this.name = 'FolderError';
  }
}
export type FolderFile = {
  relativePath: string;
  size: number;
  modifiedAt: number;
};
export type FolderRead = {
  bytes: Buffer | null;
  hash: string;
  mime: 'application/pdf' | 'message/rfc822' | 'text/plain';
  outcome: 'imported' | 'invalid' | 'oversize';
};
export function configuredIntakeRoot(): string | null {
  const value = process.env.ASTER_INTAKE_ROOT;
  if (!value || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}
function organizationSegment(organizationId: string) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      organizationId,
    )
  )
    throw new FolderError('UNSAFE_PATH');
  return organizationId.toLowerCase();
}
function safeRelative(value: string) {
  if (!FolderDirectorySchema.safeParse(value).success)
    throw new FolderError('UNSAFE_PATH');
  return value;
}
function contained(root: string, target: string) {
  return target === root || target.startsWith(root + path.sep);
}
/** Administrators own the root. Every tenant-relative ancestor must be a real directory. */
export async function resolveFolderDirectory(
  organizationId: string,
  directory?: string,
): Promise<string> {
  const configured = configuredIntakeRoot();
  if (!configured) throw new FolderError('INTAKE_NOT_CONFIGURED');
  try {
    // An explicitly configured root may itself use an administrator-managed mount.
    const root = await realpath(configured);
    let current = root;
    for (const segment of [
      organizationSegment(organizationId),
      ...(directory ? safeRelative(directory).split('/') : []),
    ]) {
      current = path.join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new FolderError('UNSAFE_PATH');
      const resolved = await realpath(current);
      if (resolved !== current || !contained(root, resolved))
        throw new FolderError('UNSAFE_PATH');
    }
    return current;
  } catch (error) {
    if (error instanceof FolderError) throw error;
    throw new FolderError('DIRECTORY_UNAVAILABLE');
  }
}
export async function listIntakeDirectories(
  organizationId: string,
  demoDirectory: string | null = null,
): Promise<FolderDirectory[]> {
  if (!configuredIntakeRoot()) return [];
  let root: string;
  try {
    root = await resolveFolderDirectory(organizationId);
  } catch (error) {
    if (error instanceof FolderError && error.code === 'DIRECTORY_UNAVAILABLE')
      return [];
    throw error;
  }
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > MAX_FOLDER_ENTRIES) throw new FolderError('SCAN_LIMIT');
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        FolderDirectorySchema.safeParse(entry.name).success,
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 100)
    .map((entry) => ({
      directory: entry.name,
      displayName: entry.name,
      isDemo: demoDirectory === entry.name,
    }));
}
export async function scanFolderFiles(
  organizationId: string,
  directory: string,
): Promise<FolderFile[]> {
  const root = await resolveFolderDirectory(organizationId, directory);
  const files: FolderFile[] = [];
  let inspected = 0;
  async function walk(relative: string, depth: number) {
    if (depth > MAX_FOLDER_DEPTH) throw new FolderError('SCAN_LIMIT');
    const folder = relative
      ? await resolveFolderDirectory(organizationId, directory + '/' + relative)
      : root;
    const entries = await readdir(folder, { withFileTypes: true });
    inspected += entries.length;
    if (inspected > MAX_FOLDER_ENTRIES) throw new FolderError('SCAN_LIMIT');
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (entry.name.startsWith('.')) continue;
      const name = relative ? relative + '/' + entry.name : entry.name;
      safeRelative(name);
      if (entry.isSymbolicLink()) throw new FolderError('UNSAFE_PATH');
      if (entry.isDirectory()) {
        await walk(name, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.(pdf|eml|txt)$/i.test(entry.name)) continue;
      const stat = await lstat(path.join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new FolderError('UNSAFE_PATH');
      files.push({
        relativePath: name,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    }
  }
  await walk('', 0);
  return files.sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
}
export function validateFolderBytes(
  filename: string,
  bytes: Buffer,
): Pick<FolderRead, 'mime' | 'outcome'> {
  const extension = path.extname(filename).toLowerCase();
  if (!['.pdf', '.eml', '.txt'].includes(extension))
    throw new FolderError('UNSAFE_PATH');
  const mime =
    extension === '.pdf'
      ? 'application/pdf'
      : extension === '.eml'
        ? 'message/rfc822'
        : 'text/plain';
  if (bytes.length > MAX_FOLDER_FILE_BYTES)
    return { mime, outcome: 'oversize' };
  if (
    !bytes.length ||
    (extension === '.pdf'
      ? !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
      : bytes.includes(0))
  )
    return { mime, outcome: 'invalid' };
  if (
    extension === '.eml' &&
    !/^[A-Za-z][A-Za-z0-9-]*:[^\r\n]*\r?\n/.test(
      bytes.subarray(0, 4096).toString(),
    )
  )
    return { mime, outcome: 'invalid' };
  return { mime, outcome: 'imported' };
}
/** No-follow open, inode/link checks, a strict byte ceiling and a second path check. */
export async function readFolderFile(
  organizationId: string,
  directory: string,
  file: FolderFile,
): Promise<FolderRead> {
  safeRelative(file.relativePath);
  const parent = path.posix.dirname(file.relativePath);
  const root = await resolveFolderDirectory(
    organizationId,
    parent === '.' ? directory : directory + '/' + parent,
  );
  const filename = path.join(root, path.posix.basename(file.relativePath));
  let handle;
  try {
    handle = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new FolderError('UNSAFE_PATH');
    if (before.size !== file.size || before.mtimeMs !== file.modifiedAt)
      throw new FolderError('FILE_CHANGED');
    // Huge files are rejected without allocating or hashing unbounded input.
    if (before.size > MAX_FOLDER_FILE_BYTES) {
      const hash = createHash('sha256')
        .update('oversize:' + before.size + ':' + before.mtimeMs)
        .digest('hex');
      return {
        bytes: null,
        hash,
        mime:
          path.extname(filename).toLowerCase() === '.pdf'
            ? 'application/pdf'
            : path.extname(filename).toLowerCase() === '.eml'
              ? 'message/rfc822'
              : 'text/plain',
        outcome: 'oversize',
      };
    }
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat(),
      current = await lstat(filename);
    const checkedRoot = await resolveFolderDirectory(
      organizationId,
      parent === '.' ? directory : directory + '/' + parent,
    );
    if (
      checkedRoot !== root ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.nlink !== 1 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      offset !== before.size
    )
      throw new FolderError('FILE_CHANGED');
    const bytes = buffer.subarray(0, offset),
      validation = validateFolderBytes(filename, bytes);
    return {
      bytes: validation.outcome === 'imported' ? bytes : null,
      hash: createHash('sha256').update(bytes).digest('hex'),
      ...validation,
    };
  } catch (error) {
    if (error instanceof FolderError) throw error;
    throw new FolderError('FILE_UNAVAILABLE');
  } finally {
    await handle?.close();
  }
}
