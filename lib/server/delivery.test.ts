import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
const query = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('./db', () => ({ pool: { query } }));
import { enqueueDelivery, smtpConfiguration, deliverOne } from './delivery';
import { decrypt, encrypt } from './crypto';
beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('EMAIL_DELIVERY_ENABLED', 'true');
  vi.stubEnv('SMTP_HOST', 'smtp.example.invalid');
  vi.stubEnv('SMTP_USER', 'synthetic');
  vi.stubEnv('SMTP_PASSWORD', 'synthetic-password');
  vi.stubEnv('SMTP_FROM', 'office@example.invalid');
  vi.stubEnv('SMTP_PORT', '465');
  query.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe('transactional account delivery', () => {
  it('defaults closed and requires authenticated TLS transport', async () => {
    const config = smtpConfiguration();
    expect(config.tls.rejectUnauthorized).toBe(true);
    expect(config.requireTLS).toBe(true);
    expect(config.disableFileAccess).toBe(true);
    expect(config.debug).toBe(false);
    vi.stubEnv('SMTP_PORT', '25');
    expect(() => smtpConfiguration()).toThrow();
    vi.stubEnv('EMAIL_DELIVERY_ENABLED', 'false');
    await enqueueDelivery(
      { to: 'one@example.invalid', subject: 'Reset', text: 'private' },
      'password_reset',
      new Date(),
    );
    expect(query).not.toHaveBeenCalled();
  });
  it('encrypts recipient and reset link in the durable queue', async () => {
    query.mockResolvedValue({ rows: [] });
    const payload = {
      to: 'one@example.invalid',
      subject: 'Reset',
      text: 'https://aster.example.invalid/reset-password#token=synthetic',
    };
    await enqueueDelivery(payload, 'password_reset', new Date());
    const args = query.mock.calls[0][1];
    expect(args[1]).not.toBe(payload.to);
    expect(decrypt(args[2], 'delivery:' + args[0]).toString()).toBe(
      JSON.stringify(payload),
    );
  });
  it('sends only through the injected transport and clears successful secret content', async () => {
    const id = crypto.randomUUID(),
      payload = {
        to: 'one@example.invalid',
        subject: 'Reset',
        text: 'private',
      },
      lease = new Date();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id,
            payload: encrypt(JSON.stringify(payload), 'delivery:' + id),
            lease_until: lease,
            attempts: 1,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await deliverOne(send)).toBe(true);
    expect(send).toHaveBeenCalledWith(payload, id);
    const update = query.mock.calls[3];
    expect(update[0]).toContain("status='sent'");
    expect(decrypt(update[1][1], 'delivery:' + id).toString()).toBe(
      'delivered',
    );
  });
  it('redacts transport failures and leaves a bounded retry', async () => {
    const id = crypto.randomUUID(),
      payload = {
        to: 'one@example.invalid',
        subject: 'Reset',
        text: 'private',
      };
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id,
            payload: encrypt(JSON.stringify(payload), 'delivery:' + id),
            lease_until: new Date(),
            attempts: 3,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    await deliverOne(async () => {
      throw new Error('secret provider body');
    });
    expect(JSON.stringify(query.mock.calls)).not.toContain(
      'secret provider body',
    );
    expect(query.mock.calls[3][0]).toContain('attempts>=3');
  });
});
