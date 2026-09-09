import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { dropTestDatabase } from '../test-support/database-cleanup';
import { randomUUID, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({}));
import { encrypt, decrypt, encryptionKeyId } from './crypto';
import { rotateEncryptedRecords } from './key-rotation';
import { encryptedTables } from './encrypted-records';
import {
  retentionPreview,
  purgeRetainedInputs,
  saveOperationalPolicy,
} from './operations-store';
import { defaultOperationalPolicy } from '../operations-contract';
import { initialWorkspace } from '../workspace';
import type { WorkspaceContext } from './access';
const enabled = process.env.ASTER_OPERATIONS_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'isolated database encryption maintenance and retention',
  () => {
    let admin: Pool, target: Pool, client: PoolClient, dbName: string;
    const org = randomUUID(),
      user = randomUUID(),
      eligible = randomUUID(),
      reviewed = randomUUID(),
      linked = randomUUID(),
      ctx: WorkspaceContext = {
        organizationId: org,
        user: {
          id: user,
          email: 'synthetic@example.invalid',
          name: 'Synthetic',
        },
        sessionId: randomUUID(),
        role: 'owner',
      };
    const policy = {
      ...defaultOperationalPolicy,
      retentionEnabled: true,
      unreviewedRetentionDays: 30,
    };
    const originalKey = process.env.ENCRYPTION_KEY;
    beforeAll(async () => {
      const url = new URL(process.env.MIGRATION_DATABASE_URL!);
      if (
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.port !== '55439' ||
        url.pathname !== '/aster'
      )
        throw new Error('Explicit isolated local test credentials required');
      admin = new Pool({ connectionString: url.toString() });
      dbName = 'aster_operations_' + randomBytes(8).toString('hex');
      await admin.query('CREATE DATABASE ' + dbName);
      url.pathname = '/' + dbName;
      target = new Pool({ connectionString: url.toString(), max: 3 });
      client = await target.connect();
      for (const name of (await readdir('migrations'))
        .filter((n) => n.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b)))
        await client.query(await readFile('migrations/' + name, 'utf8'));
      vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
      vi.stubEnv('ENCRYPTION_KEYRING', '');
      vi.stubEnv('ENCRYPTION_ACTIVE_KEY_ID', 'legacy');
      await client.query(
        'INSERT INTO auth_user(id,name,email) VALUES($1,$2,$3)',
        [user, 'Synthetic', user + '@example.invalid'],
      );
      await client.query(
        'INSERT INTO app_organizations(id,name) VALUES($1,$2)',
        [org, 'Isolated operations fixture'],
      );
      await client.query("SELECT set_config('app.organization_id',$1,false)", [
        org,
      ]);
      const state = {
        ...initialWorkspace(false),
        officeName: 'Evidence ' + linked,
      };
      await client.query(
        'INSERT INTO app_workspace(organization_id,payload) VALUES($1,$2)',
        [org, encrypt(JSON.stringify(state), 'workspace:' + org)],
      );
      for (const id of [eligible, reviewed, linked]) {
        await client.query(
          "INSERT INTO app_documents(id,organization_id,created_by,filename,mime_type,content_hash,byte_size,payload,created_at) VALUES($1::uuid,$2,$3,'synthetic.txt','text/plain',$1::text,12,$4,now()-interval '400 days')",
          [
            id,
            org,
            user,
            encrypt('private data', 'document:' + org + ':' + id),
          ],
        );
        await client.query(
          "INSERT INTO app_jobs(id,organization_id,document_id,created_by,mode,policy_revision,status,engine_legacy,result) VALUES($1,$2,$1,$3,'workflow',1,'failed',true,$4)",
          [id, org, user, encrypt('{"facts":[]}', 'result:' + org + ':' + id)],
        );
      }
      await client.query(
        'INSERT INTO app_review_versions(job_id,organization_id,revision,actor_id,payload) VALUES($1,$2,1,$3,$4)',
        [
          reviewed,
          org,
          user,
          encrypt(
            'immutable history',
            'review-version:' + org + ':' + reviewed + ':1',
          ),
        ],
      );
      await client.query(
        'UPDATE app_jobs SET review_state=$2,review_revision=1 WHERE id=$1',
        [reviewed, encrypt('current review', 'review:' + org + ':' + reviewed)],
      );
      const profile = randomUUID();
      await client.query(
        'INSERT INTO app_engine_profiles(id,organization_id) VALUES($1,$2)',
        [profile, org],
      );
      await client.query(
        'INSERT INTO app_engine_revisions(profile_id,organization_id,revision,payload) VALUES($1,$2,1,$3)',
        [
          profile,
          org,
          encrypt('pinned settings', 'engine:' + org + ':' + profile + ':1'),
        ],
      );
      await client.query(
        'INSERT INTO app_intelligence_documents(document_id,organization_id,page_count,payload) VALUES($1,$2,1,$3)',
        [
          eligible,
          org,
          encrypt(
            'decoded source',
            'intelligence-index:' + org + ':' + eligible,
          ),
        ],
      );
      const outbox = randomUUID();
      await client.query(
        "INSERT INTO app_delivery_outbox(id,recipient_hash,payload,kind,expires_at) VALUES($1,'synthetic',$2,'password_reset',now()+interval '1 hour')",
        [outbox, encrypt('link', 'delivery:' + outbox)],
      );
      await client.query('BEGIN');
      await saveOperationalPolicy(client, ctx, policy, 0);
      await client.query('COMMIT');
    }, 30000);
    afterAll(async () => {
      vi.unstubAllEnvs();
      if (originalKey) process.env.ENCRYPTION_KEY = originalKey;
      if (client) client.release();
      if (target) await target.end();
      if (admin) {
        if (dbName)
          await dropTestDatabase(admin, dbName);
        await admin.end();
      }
    }, 30000);
    it('dry-run verifies ciphertext and changes no key versions', async () => {
      await client.query('BEGIN');
      const report = await rotateEncryptedRecords(client, false);
      await client.query('ROLLBACK');
      expect(report.mode).toBe('dry-run');
      expect(
        Object.values(report.fields).reduce((n, f) => n + f.changed, 0),
      ).toBe(0);
      expect(report.fields['app_review_versions.payload'].checked).toBe(1);
    });
    it('rotates authenticated ciphertext while preserving immutable plaintext and audit hashes', async () => {
      const auditBefore = (
        await client.query('SELECT entry_hash FROM app_audit ORDER BY sequence')
      ).rows;
      vi.stubEnv(
        'ENCRYPTION_KEYRING',
        JSON.stringify({ release: randomBytes(32).toString('base64') }),
      );
      vi.stubEnv('ENCRYPTION_ACTIVE_KEY_ID', 'release');
      await client.query('BEGIN');
      const report = await rotateEncryptedRecords(client, true);
      await client.query('COMMIT');
      expect(
        Object.values(report.fields).reduce((n, f) => n + f.changed, 0),
      ).toBeGreaterThan(8);
      const row = (
        await client.query('SELECT payload FROM app_review_versions')
      ).rows[0];
      expect(encryptionKeyId(row.payload)).toBe('release');
      expect(
        decrypt(
          row.payload,
          'review-version:' + org + ':' + reviewed + ':1',
        ).toString(),
      ).toBe('immutable history');
      expect(
        (
          await client.query(
            'SELECT entry_hash FROM app_audit ORDER BY sequence',
          )
        ).rows,
      ).toEqual(auditBefore);
      await expect(
        client.query('UPDATE app_review_versions SET payload=$1', [
          encrypt('overwritten', 'any'),
        ]),
      ).rejects.toThrow('append-only');
      expect(
        (
          await client.query(
            "SELECT tgname FROM pg_trigger WHERE tgname=ANY($1::text[]) AND tgenabled='O'",
            [encryptedTables.filter((t) => t.trigger).map((t) => t.trigger)],
          )
        ).rowCount,
      ).toBe(3);
    });
    it('refuses runtime maintenance and rolls every change back if authentication fails mid-rotation', async () => {
      const runtimeURL = new URL(process.env.DATABASE_URL!);
      runtimeURL.pathname = '/' + dbName;
      const runtime = new Pool({ connectionString: runtimeURL.toString() });
      const restricted = await runtime.connect();
      try {
        await restricted.query('BEGIN');
        await expect(rotateEncryptedRecords(restricted, true)).rejects.toThrow(
          'schema owner',
        );
        await restricted.query('ROLLBACK');
      } finally {
        restricted.release();
        await runtime.end();
      }
      const before = (await client.query('SELECT payload FROM app_workspace'))
        .rows[0].payload;
      vi.stubEnv(
        'ENCRYPTION_KEYRING',
        JSON.stringify({
          ...JSON.parse(process.env.ENCRYPTION_KEYRING!),
          next: randomBytes(32).toString('base64'),
        }),
      );
      vi.stubEnv('ENCRYPTION_ACTIVE_KEY_ID', 'next');
      await client.query('BEGIN');
      await client.query('UPDATE app_delivery_outbox SET payload=$1', [
        Buffer.from('tampered'),
      ]);
      await expect(rotateEncryptedRecords(client, true)).rejects.toThrow();
      await client.query('ROLLBACK');
      expect(
        (
          await client.query('SELECT payload FROM app_workspace')
        ).rows[0].payload.equals(before),
      ).toBe(true);
      expect(
        (
          await client.query(
            "SELECT tgname FROM pg_trigger WHERE tgname=ANY($1::text[]) AND tgenabled='O'",
            [encryptedTables.filter((t) => t.trigger).map((t) => t.trigger)],
          )
        ).rowCount,
      ).toBe(3);
    });
    it('retention protects reviewed and referenced sources and requires the exact preview', async () => {
      await client.query('BEGIN');
      const preview = await retentionPreview(client, ctx, policy);
      await client.query('COMMIT');
      expect(preview.documentIds).toEqual([eligible]);
      await client.query('BEGIN');
      await expect(
        purgeRetainedInputs(client, ctx, '0'.repeat(64)),
      ).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      const result = await purgeRetainedInputs(client, ctx, preview.digest);
      await client.query('COMMIT');
      expect(result.purged).toBe(1);
      expect(
        (await client.query('SELECT id FROM app_documents ORDER BY id')).rows
          .map((r) => r.id)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual([reviewed, linked].sort((a, b) => a.localeCompare(b)));
      expect(
        (await client.query('SELECT 1 FROM app_review_versions')).rowCount,
      ).toBe(1);
      expect(
        (await client.query('SELECT 1 FROM app_intelligence_documents'))
          .rowCount,
      ).toBe(0);
    });
  },
);
