import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({}));
import { pool, withTenant } from './db';
import {
  activeEngine,
  activateEngine,
  deleteEngine,
  listEngines,
  loadEngineRevision,
  openJobEngine,
  saveEngine,
  sealJobEngine,
} from './engine-store';
import type { WorkspaceContext } from './access';
const enabled = process.env.ASTER_ENGINE_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'encrypted engine revisions and tenant SQL isolation',
  () => {
    const org = randomUUID(),
      foreign = randomUUID(),
      user = randomUUID();
    const ctx: WorkspaceContext = {
      organizationId: org,
      user: {
        id: user,
        email: 'engine-fixture@example.invalid',
        name: 'Engine fixture',
      },
      sessionId: randomUUID(),
      role: 'owner',
    };
    let admin: Pool;
    beforeAll(async () => {
      for (const name of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
        const value = process.env[name];
        if (!value || new URL(value).port !== '55439')
          throw new Error(
            'Explicit Aster test cluster55439 credentials required',
          );
      }
      admin = new Pool({
        connectionString: process.env.MIGRATION_DATABASE_URL,
      });
      await admin.query(
        'INSERT INTO auth_user(id,name,email) VALUES($1,$2,$3)',
        [user, 'Synthetic engine test', user + '@example.invalid'],
      );
      await admin.query(
        'INSERT INTO app_organizations(id,name) VALUES($1,$2),($3,$4)',
        [org, 'Synthetic engine fixture', foreign, 'Synthetic foreign fixture'],
      );
    });
    afterAll(async () => {
      if (admin) {
        for (const table of [
          'app_engine_policy',
          'app_engine_revisions',
          'app_engine_profiles',
          'app_audit',
        ])
          await admin.query(
            `DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`,
            [[org, foreign]],
          );
        await admin.query(
          'DELETE FROM app_organizations WHERE id=ANY($1::uuid[])',
          [[org, foreign]],
        );
        await admin.query('DELETE FROM auth_user WHERE id=$1', [user]);
        await admin.end();
      }
      await pool.end();
      vi.unstubAllEnvs();
    });
    it('encrypts credentials, denies foreign tenants and preserves active/job revisions through edits and deletion', async () => {
      const secret = 'synthetic-credential-never-real';
      const profile = await withTenant(org, (c) =>
        saveEngine(c, ctx, {
          name: 'Synthetic OpenAI',
          provider: 'openai',
          model: 'gpt-5.3-codex',
          apiKey: secret,
        }),
      );
      expect(JSON.stringify(profile)).not.toContain(secret);
      const bytes = (
        await admin.query(
          'SELECT payload FROM app_engine_revisions WHERE profile_id=$1',
          [profile.profileId],
        )
      ).rows[0].payload;
      expect(bytes.toString()).not.toContain(secret);
      expect(await withTenant(foreign, (c) => listEngines(c, foreign))).toEqual(
        [],
      );
      await expect(
        withTenant(foreign, (c) =>
          loadEngineRevision(c, foreign, profile.profileId, 1),
        ),
      ).rejects.toThrow('not found');
      const before = await withTenant(org, (c) => activeEngine(c, org));
      vi.stubEnv('ALLOW_CLOUD_ENGINES', 'false');
      await expect(
        withTenant(org, (c) =>
          activateEngine(c, ctx, profile.profileId, 1, true),
        ),
      ).rejects.toThrow('disabled');
      expect(
        (await withTenant(org, (c) => activeEngine(c, org))).snapshot,
      ).toEqual(before.snapshot);
      vi.stubEnv('ALLOW_CLOUD_ENGINES', 'true');
      vi.stubEnv('PROCESSOR_CLOUD_URL', 'http://processor-cloud:8000');
      await expect(
        withTenant(org, (c) =>
          activateEngine(c, ctx, profile.profileId, 1, false),
        ),
      ).rejects.toThrow('Confirm');
      await withTenant(org, (c) =>
        activateEngine(c, ctx, profile.profileId, 1, true),
      );
      const original = await withTenant(org, (c) => activeEngine(c, org)),
        jobId = randomUUID();
      const pin = sealJobEngine(original.config, original.snapshot, org, jobId);
      await withTenant(org, (c) =>
        saveEngine(
          c,
          ctx,
          {
            name: 'Updated model',
            provider: 'openai',
            model: 'other-explicit-model',
          },
          profile.profileId,
          1,
        ),
      );
      expect(
        (await withTenant(org, (c) => activeEngine(c, org))).snapshot.revision,
      ).toBe(1);
      expect(
        openJobEngine(pin.payload, pin.snapshot, org, jobId).config.model,
      ).toBe('gpt-5.3-codex');
      await expect(
        withTenant(org, (c) =>
          activateEngine(c, ctx, profile.profileId, 1, true),
        ),
      ).rejects.toThrow('Reload');
      await expect(
        withTenant(org, (c) => deleteEngine(c, ctx, profile.profileId)),
      ).rejects.toThrow('another engine');
      await expect(
        withTenant(org, (c) =>
          c.query(
            'UPDATE app_engine_revisions SET payload=$2 WHERE profile_id=$1 AND revision=1',
            [profile.profileId, Buffer.from('overwrite')],
          ),
        ),
      ).rejects.toThrow('immutable');
      await withTenant(org, (c) => activateEngine(c, ctx, null));
      await withTenant(org, (c) => deleteEngine(c, ctx, profile.profileId));
      expect(
        openJobEngine(pin.payload, pin.snapshot, org, jobId).config.apiKey,
      ).toBe(secret);
      const audit = await admin.query(
        'SELECT details FROM app_audit WHERE organization_id=$1',
        [org],
      );
      expect(JSON.stringify(audit.rows)).not.toContain(secret);
    });
  },
);
