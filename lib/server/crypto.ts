import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
function key(): Buffer {
  const value = process.env.ENCRYPTION_KEY;
  if (!value) throw new Error('ENCRYPTION_KEY is required');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32)
    throw new Error('ENCRYPTION_KEY must encode exactly 32 random bytes');
  return bytes;
}
export function encrypt(data: Buffer | string, context: string): Buffer {
  const active = activeEncryptionKeyId();
  if (active !== 'legacy') {
    const identifier = Buffer.from(active, 'ascii'),
      header = Buffer.concat([Buffer.from([2, identifier.length]), identifier]),
      iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyring().get(active)!, iv);
    cipher.setAAD(
      Buffer.concat([Buffer.from(context), Buffer.from([0]), header]),
    );
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
  }
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}
export function decrypt(envelope: Buffer, context: string): Buffer {
  const id = encryptionKeyId(envelope);
  if (id !== 'legacy') {
    const selected = keyring().get(id);
    if (!selected) throw new Error('Decryption key is unavailable');
    const offset = 2 + envelope[1],
      header = envelope.subarray(0, offset);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      selected,
      envelope.subarray(offset, offset + 12),
    );
    decipher.setAAD(
      Buffer.concat([Buffer.from(context), Buffer.from([0]), header]),
    );
    decipher.setAuthTag(envelope.subarray(offset + 12, offset + 28));
    return Buffer.concat([
      decipher.update(envelope.subarray(offset + 28)),
      decipher.final(),
    ]);
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    envelope.subarray(1, 13),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(envelope.subarray(13, 29));
  return Buffer.concat([
    decipher.update(envelope.subarray(29)),
    decipher.final(),
  ]);
}
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
function keyring(): Map<string, Buffer> {
  const keys = new Map<string, Buffer>([['legacy', key()]]);
  if (process.env.ENCRYPTION_KEYRING) {
    const values = JSON.parse(process.env.ENCRYPTION_KEYRING);
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).length > 20
    )
      throw new Error('Invalid encryption keyring');
    for (const [id, value] of Object.entries(values)) {
      if (
        !/^[A-Za-z0-9_-]{1,32}$/.test(id) ||
        id === 'legacy' ||
        typeof value !== 'string'
      )
        throw new Error('Invalid encryption key identifier');
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length !== 32) throw new Error('Invalid encryption key size');
      keys.set(id, bytes);
    }
  }
  return keys;
}
export function activeEncryptionKeyId(): string {
  const id = process.env.ENCRYPTION_ACTIVE_KEY_ID ?? 'legacy';
  if (!keyring().has(id))
    throw new Error('Active encryption key is unavailable');
  return id;
}
export function encryptionKeyId(envelope: Buffer): string {
  if (envelope[0] === 1 && envelope.length >= 29) return 'legacy';
  if (envelope[0] !== 2 || envelope.length < 31)
    throw new Error('Invalid encrypted record');
  const length = envelope[1];
  if (length < 1 || length > 32 || envelope.length < 30 + length)
    throw new Error('Invalid encrypted record');
  const id = envelope.subarray(2, 2 + length).toString('ascii');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || id === 'legacy')
    throw new Error('Invalid encrypted record');
  return id;
}
export function signAudit(data: string): string {
  return createHmac('sha256', key())
    .update('aster-audit-v1:' + data)
    .digest('hex');
}
