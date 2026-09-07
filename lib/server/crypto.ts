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
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}
export function decrypt(envelope: Buffer, context: string): Buffer {
  if (envelope.length < 30 || envelope[0] !== 1)
    throw new Error('Invalid encrypted record');
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
export function signAudit(data: string): string {
  return createHmac('sha256', key())
    .update('aster-audit-v1:' + data)
    .digest('hex');
}
