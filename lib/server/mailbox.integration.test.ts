import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
}));
import {
  startMailboxAuthorization,
  finishMailboxAuthorization,
  listMailboxes,
  updateMailbox,
} from './mailbox-store';
import {
  claimMailbox,
  syncMailboxPage,
  importMailboxMessage,
  releaseMailboxClaim,
} from './mailbox-sync';
import { decrypt, encrypt } from './crypto';
import { pool, withTenant } from './db';
import { MailboxError } from './mailbox-provider';
import type { WorkspaceContext } from './access';
const enabled = process.env.ASTER_MAILBOX_INTEGRATION === '1';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const sequence = (...responses: Response[]) =>
  vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fixture provider call');
    return response;
  });
describe.skipIf(!enabled)(
  'mailbox OAuth, persistence and import lifecycle',
  () => {
    const org = randomUUID(),
      foreignOrg = randomUUID(),
      user = randomUUID(),
      session = randomUUID(),
      worker = randomUUID();
    const context: WorkspaceContext = {
      organizationId: org,
      user: {
        id: user,
        email: 'fixture@example.invalid',
        name: 'Mailbox fixture',
      },
      sessionId: session,
      role: 'owner',
    };
    let admin: Pool, mailboxId: string;
    const tokenResponse = () =>
      json({
        access_token: 'synthetic-access-token',
        refresh_token: 'synthetic-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      });
    const source = Buffer.from(
      'From: synthetic-manager@example.invalid\r\nSubject: Meridian quarterly NAV report\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMeridian Fund net asset value (NAV) EUR 2,800,000 as of 2026-09-08.\r\n',
    );
    beforeAll(async () => {
      if (!process.env.MIGRATION_DATABASE_URL || !process.env.DATABASE_URL)
        throw new Error('Explicit disposable database credentials required');
      admin = new Pool({
        connectionString: process.env.MIGRATION_DATABASE_URL,
      });
      const queue = await admin.query(
        'SELECT count(*)::int AS count FROM app_mailbox_queue',
      );
      if (queue.rows[0].count)
        throw new Error(
          'Pause live mailbox scheduling before this integration suite',
        );
      vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic-client');
      vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-secret');
      await admin.query(
        'INSERT INTO auth_user(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$2,$3,true,true)',
        [user, 'Mailbox fixture', 'mailbox-' + user + '@example.invalid'],
      );
      await admin.query(
        'INSERT INTO auth_session(id,"userId",token,"expiresAt","mfaVerifiedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now())',
        [session, user, randomUUID()],
      );
      await admin.query(
        'INSERT INTO app_organizations(id,name) VALUES($1,$2),($3,$4)',
        [org, 'Mailbox disposable', foreignOrg, 'Foreign mailbox disposable'],
      );
      await admin.query(
        "INSERT INTO app_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
        [org, user],
      );
    });
    afterAll(async () => {
      if (admin) {
        for (const table of [
          'app_mailbox_oauth_states',
          'app_mailbox_queue',
          'app_mailbox_receipts',
          'app_mailboxes',
          'app_job_queue',
          'app_accepted_facts',
          'app_audit',
          'app_jobs',
          'app_documents',
          'app_workspace',
          'app_memberships',
        ])
          await admin.query(
            `DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`,
            [[org, foreignOrg]],
          );
        await admin.query(
          'DELETE FROM app_organizations WHERE id=ANY($1::uuid[])',
          [[org, foreignOrg]],
        );
        await admin.query('DELETE FROM auth_user WHERE id=$1', [user]);
        await admin.query(
          'DELETE FROM app_request_limits WHERE key=ANY($1::text[])',
          [['mailbox-oauth:' + user, 'mailbox-sync:' + mailboxId]],
        );
        await admin.end();
      }
      await pool.end();
      vi.unstubAllEnvs();
    });
    it('uses PKCE and one-time state bound to a session, and encrypts provider credentials', async () => {
      const started = await startMailboxAuthorization(context, {
          provider: 'gmail',
          historyDays: 'all',
        }),
        url = new URL(started.authorizationUrl),
        state = url.searchParams.get('state')!;
      expect(url.origin).toBe('https://accounts.google.com');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).toBe(
        'https://www.googleapis.com/auth/gmail.readonly',
      );
      expect(started.authorizationUrl).not.toContain('synthetic-secret');
      const fetcher = sequence(
        tokenResponse(),
        json({ emailAddress: 'office@example.invalid' }),
      );
      await expect(
        finishMailboxAuthorization(
          { ...context, sessionId: 'wrong-session' },
          'gmail',
          state,
          'fixture',
          fetcher,
        ),
      ).rejects.toThrow('INVALID_OAUTH_STATE');
      expect(fetcher).not.toHaveBeenCalled();
      mailboxId = (
        await finishMailboxAuthorization(
          context,
          'gmail',
          state,
          'fixture',
          fetcher,
        )
      ).id;
      await expect(
        finishMailboxAuthorization(context, 'gmail', state, 'fixture', fetcher),
      ).rejects.toThrow('INVALID_OAUTH_STATE');
      const row = (
        await admin.query('SELECT credentials FROM app_mailboxes WHERE id=$1', [
          mailboxId,
        ])
      ).rows[0];
      expect(row.credentials.toString()).not.toContain(
        'synthetic-refresh-token',
      );
      const listed = await listMailboxes(context);
      expect(listed.mailboxes[0]).toMatchObject({
        id: mailboxId,
        historyDays: 'all',
        currentUserCanManage: true,
      });
      expect(JSON.stringify(listed)).not.toContain('synthetic-access-token');
      expect(
        (
          await withTenant(foreignOrg, (client) =>
            client.query('SELECT id FROM app_mailboxes WHERE id=$1', [
              mailboxId,
            ]),
          )
        ).rowCount,
      ).toBe(0);
    });
    it('imports exact MIME, pins policy, keeps receipts and advances checkpoints only after persistence', async () => {
      const claim = await claimMailbox(worker);
      expect(claim?.id).toBe(mailboxId);
      const fetcher = sequence(
        json({ historyId: '10' }),
        json({ messages: [{ id: 'first' }] }),
        json({ raw: source.toString('base64url') }),
      );
      await syncMailboxPage(claim!, undefined, fetcher);
      const docs = await admin.query(
        'SELECT id,payload FROM app_documents WHERE organization_id=$1',
        [org],
      );
      expect(docs.rowCount).toBe(1);
      expect(
        decrypt(
          docs.rows[0].payload,
          'document:' + org + ':' + docs.rows[0].id,
        ),
      ).toEqual(source);
      const jobs = await admin.query(
        'SELECT mode,policy_revision FROM app_jobs WHERE organization_id=$1',
        [org],
      );
      expect(jobs.rows).toEqual([{ mode: 'workflow', policy_revision: 1 }]);
      await admin.query(
        'UPDATE app_mailbox_queue SET available_at=now() WHERE id=$1',
        [mailboxId],
      );
      const again = await claimMailbox(worker);
      await syncMailboxPage(
        again!,
        undefined,
        sequence(
          json({
            historyId: '11',
            history: [{ messagesAdded: [{ message: { id: 'first' } }] }],
          }),
        ),
      );
      expect(
        (
          await admin.query(
            'SELECT imported_count FROM app_mailboxes WHERE id=$1',
            [mailboxId],
          )
        ).rows[0].imported_count,
      ).toBe(1);
      expect(
        (
          await admin.query(
            'SELECT id FROM app_documents WHERE organization_id=$1',
            [org],
          )
        ).rowCount,
      ).toBe(1);
      // A refreshed cursor page must not be published if a lease expires before committing.
      await admin.query(
        'UPDATE app_mailbox_queue SET available_at=now() WHERE id=$1',
        [mailboxId],
      );
      const stale = await claimMailbox(worker);
      await admin.query(
        "UPDATE app_mailbox_queue SET lease_until=now()-interval '1 second' WHERE id=$1",
        [mailboxId],
      );
      const replacement = await claimMailbox('replacement-' + worker);
      await expect(
        importMailboxMessage(stale!, 1, 'stale', source),
      ).rejects.toThrow();
      await releaseMailboxClaim(replacement!);
    });
    it('preserves progress across provider failure and honors throttled retry scheduling', async () => {
      await admin.query(
        'UPDATE app_mailbox_queue SET available_at=now() WHERE id=$1',
        [mailboxId],
      );
      const claim = await claimMailbox(worker);
      const before = (
        await admin.query('SELECT cursor FROM app_mailboxes WHERE id=$1', [
          mailboxId,
        ])
      ).rows[0].cursor;
      await expect(
        syncMailboxPage(claim!, undefined, sequence(json({}, 503))),
      ).rejects.toThrow('PROVIDER_UNAVAILABLE');
      await releaseMailboxClaim(
        claim!,
        new MailboxError('PROVIDER_RATE_LIMIT', 120),
      );
      const after = (
        await admin.query(
          'SELECT m.cursor,extract(epoch from q.available_at-now()) AS delay,q.lease_owner FROM app_mailboxes m JOIN app_mailbox_queue q ON q.id=m.id WHERE m.id=$1',
          [mailboxId],
        )
      ).rows[0];
      expect(after.cursor).toEqual(before);
      expect(Number(after.delay)).toBeGreaterThan(118);
      expect(after.lease_owner).toBeNull();
    });
    it('restores encrypted documents, mailbox credentials and cursor in an isolated native recovery drill', () => {
      const output = execFileSync(
        process.execPath,
        [
          '--env-file=.env.local',
          'operations/scripts/native-recovery-drill.mjs',
        ],
        {
          env: { ...process.env, ASTER_NATIVE_RECOVERY_DRILL: '1' },
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      const report = JSON.parse(output.trim());
      expect(report.result).toBe('passed');
      expect(report.tables).toBe(22);
      expect(report.decryptedRecords).toBeGreaterThanOrEqual(5);
    });
    it('refreshes expired credentials, and pause/disconnect fence old workers without deleting originals', async () => {
      await admin.query('UPDATE app_mailboxes SET credentials=$2 WHERE id=$1', [
        mailboxId,
        encrypt(
          JSON.stringify({
            accessToken: 'expired',
            refreshToken: 'synthetic-refresh-token',
            expiresAt: 0,
            scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          }),
          'mailbox-credentials:' + org + ':' + mailboxId,
        ),
      ]);
      await admin.query(
        'UPDATE app_mailbox_queue SET available_at=now() WHERE id=$1',
        [mailboxId],
      );
      const claim = await claimMailbox(worker);
      const fetcher = sequence(
        tokenResponse(),
        json({ historyId: '12', history: [] }),
      );
      await syncMailboxPage(claim!, undefined, fetcher);
      expect(fetcher.mock.calls[0][1]?.method).toBe('POST');
      await admin.query(
        'UPDATE app_mailbox_queue SET available_at=now() WHERE id=$1',
        [mailboxId],
      );
      const old = await claimMailbox(worker);
      await updateMailbox(context, mailboxId, 'pause');
      await expect(
        importMailboxMessage(old!, 1, 'after-pause', source),
      ).rejects.toThrow();
      await expect(
        updateMailbox({ ...context, role: 'viewer' }, mailboxId, 'resume'),
      ).rejects.toMatchObject({ status: 403 });
      await updateMailbox(context, mailboxId, 'resume');
      await updateMailbox(context, mailboxId, 'disconnect');
      const row = (
        await admin.query(
          'SELECT status,credentials,cursor FROM app_mailboxes WHERE id=$1',
          [mailboxId],
        )
      ).rows[0];
      expect(row).toEqual({
        status: 'disconnected',
        credentials: null,
        cursor: null,
      });
      expect(
        (
          await admin.query('SELECT id FROM app_mailbox_queue WHERE id=$1', [
            mailboxId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await admin.query(
            'SELECT id FROM app_documents WHERE organization_id=$1',
            [org],
          )
        ).rowCount,
      ).toBe(1);
    });
    it('connects a separate Microsoft account with delegated read-only scopes', async () => {
      vi.stubEnv('MICROSOFT_CLIENT_ID', 'synthetic-ms-client');
      vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'synthetic-ms-secret');
      vi.stubEnv('MICROSOFT_TENANT_ID', 'organizations');
      const { authorizationUrl } = await startMailboxAuthorization(context, {
        provider: 'microsoft',
        historyDays: 30,
      });
      const url = new URL(authorizationUrl);
      expect(url.origin).toBe('https://login.microsoftonline.com');
      expect(url.pathname).toContain('/organizations/');
      expect(url.searchParams.get('scope')).toContain('Mail.Read');
      expect(url.searchParams.get('scope')).not.toContain('Mail.ReadWrite');
      const created = await finishMailboxAuthorization(
        context,
        'microsoft',
        url.searchParams.get('state')!,
        'fixture',
        sequence(
          json({
            access_token: 'ms-fixture',
            refresh_token: 'ms-refresh',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'Mail.Read User.Read',
          }),
          json({
            id: 'synthetic-ms-identity',
            mail: 'second@example.invalid',
            userPrincipalName: 'second@example.invalid',
            displayName: 'Second account',
          }),
        ),
      );
      const listed = await listMailboxes(context);
      expect(listed.mailboxes).toHaveLength(2);
      expect(
        listed.mailboxes.find((mailbox) => mailbox.id === created.id)?.provider,
      ).toBe('microsoft');
      await updateMailbox(context, created.id, 'disconnect');
    });
  },
);
