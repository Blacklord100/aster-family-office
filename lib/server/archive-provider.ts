import 'server-only';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArchiveReceipt } from '../archive-contract';
import { ArchiveDirectorySchema } from '../archive-contract';
import {
  ArchiveError,
  ARCHIVE_LIMITS,
  receiptForArchive,
  type ArchiveBundle,
} from './archive-bundle';
import { sha256 } from './crypto';

export { ArchiveError } from './archive-bundle';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const contains = (root: string, target: string) =>
  root === target || target.startsWith(root + path.sep);
export function configuredArchiveRoot(): string | null {
  const value = process.env.ASTER_ARCHIVE_ROOT;
  return value && path.isAbsolute(value) ? path.resolve(value) : null;
}
function isCode(error: unknown, code: string) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
function safeSegments(value: string, maxDepth = 12): string[] {
  if (
    !value ||
    value.length > 1200 ||
    value.includes('\\') ||
    /[\p{Cc}\p{Cf}<>:"|?*]/u.test(value) ||
    value.startsWith('/')
  )
    throw new ArchiveError('ARCHIVE_UNSAFE_PATH');
  const segments = value.split('/');
  if (
    segments.length > maxDepth ||
    segments.some(
      (s) =>
        !s ||
        s === '.' ||
        s === '..' ||
        s.startsWith('.') ||
        s.endsWith('.') ||
        s.endsWith(' ') ||
        Buffer.byteLength(s) > 240,
    )
  )
    throw new ArchiveError('ARCHIVE_UNSAFE_PATH');
  return segments;
}
/** The configured root is an operator-managed mount; descendants are private real directories. */
async function rootDirectory() {
  const configured = configuredArchiveRoot();
  if (!configured) throw new ArchiveError('ARCHIVE_NOT_CONFIGURED');
  try {
    const root = await realpath(configured);
    const stat = await lstat(root);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o022) !== 0 ||
      (process.geteuid && stat.uid !== process.geteuid())
    )
      throw new ArchiveError('ARCHIVE_UNSAFE_PATH');
    const intake = process.env.ASTER_INTAKE_ROOT;
    if (intake && path.isAbsolute(intake)) {
      const intakeRoot = await realpath(intake).catch(() =>
        path.resolve(intake),
      );
      if (contains(root, intakeRoot) || contains(intakeRoot, root))
        throw new ArchiveError('ARCHIVE_INTAKE_OVERLAP');
    }
    return root;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('ARCHIVE_ROOT_UNAVAILABLE');
  }
}
async function privateDirectory(
  root: string,
  segments: string[],
  create: boolean,
) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((error) => {
        if (!isCode(error, 'EEXIST')) throw error;
      });
    const stat = await lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.geteuid && stat.uid !== process.geteuid())
    )
      throw new ArchiveError('ARCHIVE_UNSAFE_PATH');
    const resolved = await realpath(current);
    if (resolved !== current || !contains(root, resolved))
      throw new ArchiveError('ARCHIVE_UNSAFE_PATH');
  }
  return current;
}
async function destinationDirectory(
  organizationId: string,
  directory: string,
  create: boolean,
) {
  if (
    !UUID.test(organizationId) ||
    !ArchiveDirectorySchema.safeParse(directory).success
  )
    throw new ArchiveError('ARCHIVE_UNSAFE_PATH');
  const root = await rootDirectory();
  return {
    root,
    directory: await privateDirectory(
      root,
      [organizationId.toLowerCase(), ...safeSegments(directory, 8)],
      create,
    ),
  };
}
async function syncDirectory(directory: string) {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeFileExclusive(filename: string, bytes: Buffer) {
  const handle = await open(
    filename,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new ArchiveError('ARCHIVE_UNSAFE_PATH');
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function readExpectedFile(filename: string, byteSize: number) {
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.size !== byteSize ||
      (process.geteuid && before.uid !== process.geteuid())
    )
      throw new ArchiveError('ARCHIVE_FILE_CHANGED');
    const bytes = Buffer.alloc(byteSize);
    let read = 0;
    while (read < byteSize) {
      const result = await handle.read(bytes, read, byteSize - read, read);
      if (!result.bytesRead) throw new ArchiveError('ARCHIVE_FILE_CHANGED');
      read += result.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(filename);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.nlink !== 1 ||
      named.isSymbolicLink() ||
      named.ino !== before.ino ||
      named.dev !== before.dev
    )
      throw new ArchiveError('ARCHIVE_FILE_CHANGED');
    return bytes;
  } finally {
    await handle.close();
  }
}
function validateReceipt(receipt: ArchiveReceipt) {
  safeSegments(receipt.relativePath);
  if (
    receipt.provider !== 'local' ||
    !SHA.test(receipt.manifestSha256) ||
    !SHA.test(receipt.originalSha256) ||
    !Array.isArray(receipt.files) ||
    !receipt.files.length ||
    receipt.files.length > ARCHIVE_LIMITS.files
  )
    throw new ArchiveError('ARCHIVE_RECEIPT_INVALID');
  let total = 0;
  const names = new Set<string>();
  for (const file of receipt.files) {
    safeSegments(file.path, 2);
    if (
      names.has(file.path) ||
      !SHA.test(file.sha256) ||
      !Number.isSafeInteger(file.byteSize) ||
      file.byteSize < 0 ||
      (total += file.byteSize) > ARCHIVE_LIMITS.totalBytes
    )
      throw new ArchiveError('ARCHIVE_RECEIPT_INVALID');
    names.add(file.path);
  }
  if (
    !receipt.files.some(
      (file) =>
        file.path === 'manifest.json' && file.sha256 === receipt.manifestSha256,
    ) ||
    !receipt.files.some(
      (file) =>
        /^original\.(eml|pdf|txt)$/.test(file.path) &&
        file.sha256 === receipt.originalSha256,
    )
  )
    throw new ArchiveError('ARCHIVE_RECEIPT_INVALID');
}
export async function testLocalArchiveDestination(
  organizationId: string,
  directory: string,
): Promise<{ ok: true; checkedAt: string }> {
  try {
    const destination = await destinationDirectory(
      organizationId,
      directory,
      true,
    );
    const filename = path.join(
      destination.directory,
      'probe-' + randomUUID() + '.tmp',
    );
    const bytes = Buffer.from(
      'Aster archive write and integrity probe\n' + randomUUID(),
    );
    let written = false;
    try {
      await writeFileExclusive(filename, bytes);
      written = true;
      if (
        sha256(await readExpectedFile(filename, bytes.length)) !== sha256(bytes)
      )
        throw new ArchiveError('ARCHIVE_FILE_CHANGED');
    } finally {
      if (written)
        await unlink(filename).catch((error) => {
          if (!isCode(error, 'ENOENT')) throw error;
        });
    }
    await destinationDirectory(organizationId, directory, false);
    await syncDirectory(destination.directory);
    return { ok: true, checkedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('ARCHIVE_DESTINATION_UNAVAILABLE');
  }
}
export type ArchiveVerification = {
  ok: boolean;
  checkedAt: string;
  issues: string[];
};
/** A file index addresses only an artifact already recorded in the encrypted receipt. */
export async function readLocalArchiveFile(
  organizationId: string,
  directory: string,
  receipt: ArchiveReceipt,
  index: number,
): Promise<Buffer> {
  try {
    validateReceipt(receipt);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= receipt.files.length
    )
      throw new ArchiveError('ARCHIVE_FILE_NOT_FOUND');
    const destination = await destinationDirectory(
      organizationId,
      directory,
      false,
    );
    const bundle = await privateDirectory(
      destination.directory,
      safeSegments(receipt.relativePath),
      false,
    );
    const file = receipt.files[index];
    const components = safeSegments(file.path, 2);
    if (components.length > 1)
      await privateDirectory(bundle, components.slice(0, -1), false);
    const bytes = await readExpectedFile(
      path.join(bundle, ...components),
      file.byteSize,
    );
    if (sha256(bytes) !== file.sha256)
      throw new ArchiveError('ARCHIVE_FILE_CHANGED');
    await destinationDirectory(organizationId, directory, false);
    await privateDirectory(
      destination.directory,
      safeSegments(receipt.relativePath),
      false,
    );
    return bytes;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('ARCHIVE_FILE_UNAVAILABLE');
  }
}
export async function verifyLocalArchiveReceipt(
  organizationId: string,
  directory: string,
  receipt: ArchiveReceipt,
): Promise<ArchiveVerification> {
  const checkedAt = new Date().toISOString();
  try {
    validateReceipt(receipt);
    const destination = await destinationDirectory(
      organizationId,
      directory,
      false,
    );
    const bundle = await privateDirectory(
      destination.root,
      [
        organizationId.toLowerCase(),
        ...safeSegments(directory, 8),
        ...safeSegments(receipt.relativePath),
      ],
      false,
    );
    const expected = new Set(receipt.files.map((file) => file.path));
    const issues: string[] = [];
    for (const file of receipt.files) {
      try {
        const components = safeSegments(file.path, 2);
        if (components.length > 1)
          await privateDirectory(bundle, components.slice(0, -1), false);
        const bytes = await readExpectedFile(
          path.join(bundle, ...components),
          file.byteSize,
        );
        if (sha256(bytes) !== file.sha256)
          issues.push('File checksum mismatch: ' + file.path);
      } catch {
        issues.push('File missing, changed or unsafe: ' + file.path);
      }
    }
    for (const entry of await readdir(bundle, { withFileTypes: true })) {
      if (
        entry.name === 'attachments' &&
        entry.isDirectory() &&
        !entry.isSymbolicLink()
      ) {
        const attachmentDirectory = await privateDirectory(
          bundle,
          ['attachments'],
          false,
        );
        for (const attachment of await readdir(attachmentDirectory))
          if (!expected.has('attachments/' + attachment))
            issues.push('Unexpected attachment in bundle.');
      } else if (!expected.has(entry.name))
        issues.push('Unexpected file in bundle.');
    }
    await destinationDirectory(organizationId, directory, false);
    await privateDirectory(
      destination.directory,
      safeSegments(receipt.relativePath),
      false,
    );
    return {
      ok: issues.length === 0,
      checkedAt,
      issues: [...new Set(issues)].slice(0, 80),
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      issues: [
        error instanceof ArchiveError
          ? error.code
          : 'Archive bundle is unavailable.',
      ],
    };
  }
}
export type ArchivePublishOptions = {
  signal?: AbortSignal;
  /** Store holds configuration/lease locks while commit publishes and records its receipt. */
  publish?: (commit: () => Promise<ArchiveReceipt>) => Promise<ArchiveReceipt>;
};
export async function writeLocalArchiveBundle(
  organizationId: string,
  directory: string,
  bundle: ArchiveBundle,
  options: ArchivePublishOptions = {},
): Promise<ArchiveReceipt> {
  if (bundle.source.organizationId !== organizationId)
    throw new ArchiveError('ARCHIVE_SOURCE_INVALID');
  const receipt = receiptForArchive(bundle, new Date().toISOString());
  validateReceipt(receipt);
  if (
    bundle.files.length !== receipt.files.length ||
    bundle.files.some(
      (file, i) => sha256(file.bytes) !== receipt.files[i].sha256,
    )
  )
    throw new ArchiveError('ARCHIVE_SOURCE_INVALID');
  let stage: string | undefined;
  let stageInode: number | undefined;
  try {
    const destination = await destinationDirectory(
      organizationId,
      directory,
      true,
    );
    const segments = safeSegments(bundle.relativePath);
    const parent = await privateDirectory(
      destination.root,
      [
        organizationId.toLowerCase(),
        ...safeSegments(directory, 8),
        ...segments.slice(0, -1),
      ],
      true,
    );
    const target = path.join(parent, segments.at(-1)!);
    const parentStat = await lstat(parent);
    const revalidate = async () => {
      if (options.signal?.aborted) throw new ArchiveError('ARCHIVE_CANCELLED');
      await destinationDirectory(organizationId, directory, false);
      await privateDirectory(
        destination.directory,
        segments.slice(0, -1),
        false,
      );
      const stat = await lstat(parent);
      if (stat.ino !== parentStat.ino || stat.dev !== parentStat.dev)
        throw new ArchiveError('ARCHIVE_UNSAFE_PATH');
    };
    const publish =
      options.publish ?? ((commit: () => Promise<ArchiveReceipt>) => commit());
    const exists = await lstat(target).then(
      () => true,
      (error) => {
        if (isCode(error, 'ENOENT')) return false;
        throw error;
      },
    );
    if (exists) {
      return await publish(async () => {
        await revalidate();
        const verified = await verifyLocalArchiveReceipt(
          organizationId,
          directory,
          receipt,
        );
        if (!verified.ok) throw new ArchiveError('ARCHIVE_CONFLICT');
        return receipt;
      });
    }
    stage = path.join(parent, '.archive-stage-' + randomUUID());
    await revalidate();
    await mkdir(stage, { mode: 0o700 });
    stageInode = (await lstat(stage)).ino;
    for (const file of bundle.files) {
      await revalidate();
      const parts = safeSegments(file.path, 2);
      if (parts.length > 1)
        await privateDirectory(stage, parts.slice(0, -1), true);
      await writeFileExclusive(path.join(stage, ...parts), file.bytes);
    }
    for (const entry of await readdir(stage, { withFileTypes: true }))
      if (entry.isDirectory())
        await syncDirectory(path.join(stage, entry.name));
    await syncDirectory(stage);
    return await publish(async () => {
      await revalidate();
      if ((await lstat(stage!)).ino !== stageInode)
        throw new ArchiveError('ARCHIVE_UNSAFE_PATH');
      // Never replace an existing bundle. An unexpected directory is a visible conflict.
      if (
        await lstat(target).then(
          () => true,
          (error) => {
            if (isCode(error, 'ENOENT')) return false;
            throw error;
          },
        )
      )
        throw new ArchiveError('ARCHIVE_CONFLICT');
      await rename(stage!, target);
      stage = undefined;
      await syncDirectory(parent);
      const verified = await verifyLocalArchiveReceipt(
        organizationId,
        directory,
        receipt,
      );
      if (!verified.ok) throw new ArchiveError('ARCHIVE_FILE_CHANGED');
      return receipt;
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('ARCHIVE_WRITE_FAILED');
  } finally {
    if (stage && (await lstat(stage).catch(() => null))?.ino === stageInode)
      await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
/** Adapter boundary: a cloud provider must implement the same receipt and verification semantics. */
export const archiveStorageProviders = {
  local: {
    test: testLocalArchiveDestination,
    write: writeLocalArchiveBundle,
    verify: verifyLocalArchiveReceipt,
  },
} as const;
