import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { assertDisposableDatabase } from '../test-support/disposable-database';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
vi.mock('server-only', () => ({}));
import { pool } from './db';
import { createAsterAuth } from './auth';
import { decrypt, sha256 } from './crypto';
const enabled = process.env.ASTER_RECOVERY_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'real auth recovery with encrypted no-send outbox',
  () => {
    const id = randomUUID(),
      email = 'synthetic-recovery-' + id + '@example.invalid',
      oldPassword = randomBytes(30).toString('base64url'),
      nextPassword = randomBytes(30).toString('base64url');
    let auth: ReturnType<typeof createAsterAuth>, token: string;
    let fixtureAuthorized = false;
    const headers = new Headers({
      origin: 'http://localhost:3000',
      'content-type': 'application/json',
    });
    beforeAll(async () => {
      assertDisposableDatabase();
      fixtureAuthorized = true;
      vi.stubEnv('EMAIL_DELIVERY_ENABLED', 'true');
      auth = createAsterAuth();
      await pool.query(
        'INSERT INTO auth_user(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$2,$3,true,true)',
        [id, 'Synthetic recovery', email],
      );
      await pool.query(
        'INSERT INTO auth_account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
        [randomUUID(), id, await hashPassword(oldPassword)],
      );
      await pool.query(
        'INSERT INTO auth_session(id,"userId",token,"expiresAt","mfaVerifiedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now())',
        [randomUUID(), id, randomUUID()],
      );
    });
    afterAll(async () => {
      if (!fixtureAuthorized) {
        await pool.end();
        return;
      }
      await pool.query(
        'DELETE FROM app_delivery_outbox WHERE recipient_hash=$1',
        [sha256(email)],
      );
      await pool.query('DELETE FROM auth_user WHERE id=$1', [id]);
      await pool.end();
      vi.unstubAllEnvs();
    });
    it('queues one-time recovery without making an SMTP call and gives the same public response for unknown users', async () => {
      const request = await auth.api.requestPasswordReset({
        headers,
        body: { email, redirectTo: 'http://localhost:3000/reset-password' },
      });
      const unknown = await auth.api.requestPasswordReset({
        headers,
        body: {
          email: 'absent-' + randomUUID() + '@example.invalid',
          redirectTo: 'http://localhost:3000/reset-password',
        },
      });
      expect(unknown).toEqual(request);
      const rows = (
        await pool.query(
          'SELECT id,payload,status FROM app_delivery_outbox WHERE recipient_hash=$1',
          [sha256(email)],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('pending');
      const payload = JSON.parse(
        decrypt(rows[0].payload, 'delivery:' + rows[0].id).toString(),
      );
      expect(payload.to).toBe(email);
      const link = payload.text.match(
        /http:\/\/localhost:3000\/reset-password#token=([^\s]+)/,
      );
      expect(link).toBeTruthy();
      token = decodeURIComponent(link[1]);
      expect(rows[0].payload.toString()).not.toContain(token);
    });
    it('keeps the authenticator required, revokes existing sessions and refuses reuse', async () => {
      await auth.api.resetPassword({
        headers,
        body: { token, newPassword: nextPassword },
      });
      const account = (
        await pool.query(
          'SELECT password FROM auth_account WHERE "userId"=$1',
          [id],
        )
      ).rows[0];
      expect(
        await verifyPassword({
          hash: account.password,
          password: nextPassword,
        }),
      ).toBe(true);
      expect(
        await verifyPassword({ hash: account.password, password: oldPassword }),
      ).toBe(false);
      expect(
        (await pool.query('SELECT 1 FROM auth_session WHERE "userId"=$1', [id]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT "twoFactorEnabled" FROM auth_user WHERE id=$1',
            [id],
          )
        ).rows[0].twoFactorEnabled,
      ).toBe(true);
      await expect(
        auth.api.resetPassword({
          headers,
          body: { token, newPassword: oldPassword },
        }),
      ).rejects.toThrow();
    });
  },
);
