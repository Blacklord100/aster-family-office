import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
}));
import { POST } from '../../app/api/mcp/route';
import { createIntegrationToken, revokeIntegrationToken } from './mcp-access';
import { pool } from './db';
import { encrypt } from './crypto';
import type { WorkspaceContext } from './access';

const enabled = process.env.ASTER_MCP_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'MCP SDK interoperability and PostgreSQL isolation',
  () => {
    const org = randomUUID(),
      otherOrg = randomUUID(),
      user = randomUUID(),
      document = randomUUID(),
      foreignDocument = randomUUID();
    let admin: Pool, token: string, tokenId: string;
    const context: WorkspaceContext = {
      organizationId: org,
      user: {
        id: user,
        name: 'MCP fixture',
        email: 'mcp-fixture@example.invalid',
      },
      role: 'owner',
      sessionId: 'fixture-session',
    };
    const original = Buffer.from(
      'Subject: Synthetic NAV\r\n\r\nMeridian NAV EUR 2800000.',
    );
    const request = (
      secret: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      new Request('http://localhost:3000/api/mcp', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          authorization: 'Bearer ' + secret,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(body),
      });
    async function connect(secret: string) {
      const client = new Client({
        name: 'aster-test-client',
        version: '1.0.0',
      });
      const transport = new StreamableHTTPClientTransport(
        new URL('http://localhost:3000/api/mcp'),
        {
          requestInit: { headers: { Authorization: 'Bearer ' + secret } },
          fetch: async (input, init) => {
            const request = new Request(input, init);
            request.headers.set('host', 'localhost:3000');
            return POST(request);
          },
        },
      );
      await client.connect(transport);
      return client;
    }
    beforeAll(async () => {
      if (!process.env.MIGRATION_DATABASE_URL || !process.env.DATABASE_URL)
        throw new Error('Explicit disposable database credentials required');
      admin = new Pool({
        connectionString: process.env.MIGRATION_DATABASE_URL,
        max: 1,
      });
      await admin.query(
        'INSERT INTO auth_user(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$2,$3,true,true)',
        [user, 'MCP fixture', 'mcp-' + user + '@example.invalid'],
      );
      await admin.query(
        'INSERT INTO app_organizations(id,name) VALUES($1,$2),($3,$4)',
        [org, 'MCP disposable', otherOrg, 'MCP foreign disposable'],
      );
      await admin.query(
        "INSERT INTO app_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
        [org, user],
      );
      for (const [id, organizationId] of [
        [document, org],
        [foreignDocument, otherOrg],
      ])
        await admin.query(
          'INSERT INTO app_documents(id,organization_id,created_by,filename,mime_type,content_hash,byte_size,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            id,
            organizationId,
            user,
            'synthetic.eml',
            'message/rfc822',
            id,
            original.length,
            encrypt(original, 'document:' + organizationId + ':' + id),
          ],
        );
      const created = await createIntegrationToken(context, {
        name: 'Fixture read token',
        scopes: ['portfolio:read', 'sources:read'],
        expiresInDays: 1,
      });
      token = created.token;
      tokenId = created.id;
    });
    afterAll(async () => {
      if (admin) {
        for (const table of [
          'app_integration_tokens',
          'app_audit',
          'app_workspace',
          'app_documents',
          'app_memberships',
        ])
          await admin.query(
            `DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`,
            [[org, otherOrg]],
          );
        await admin.query(
          'DELETE FROM app_organizations WHERE id=ANY($1::uuid[])',
          [[org, otherOrg]],
        );
        await admin.query('DELETE FROM auth_user WHERE id=$1', [user]);
        await admin.query('DELETE FROM app_request_limits WHERE key=$1', [
          'mcp:' + tokenId,
        ]);
        await admin.end();
      }
      await pool.end();
    });
    it('negotiates using the official SDK and only lists granted read-only tools', async () => {
      const client = await connect(token);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual([
          'list_holdings',
          'list_timeline',
          'list_sources',
          'read_source',
        ]);
        expect(
          tools.tools.every((tool) => tool.annotations?.readOnlyHint === true),
        ).toBe(true);
        const sources = await client.callTool({
          name: 'list_sources',
          arguments: {},
        });
        expect(
          (
            sources.structuredContent as { documents: { id: string }[] }
          ).documents.map((row) => row.id),
        ).toEqual([document]);
        const source = await client.callTool({
          name: 'read_source',
          arguments: { documentId: document },
        });
        expect(
          Buffer.from(
            (source.structuredContent as { data: string }).data,
            'base64',
          ),
        ).toEqual(original);
        const other = await client.callTool({
          name: 'read_source',
          arguments: { documentId: foreignDocument },
        });
        expect(other.isError).toBe(true);
      } finally {
        await client.close();
      }
    });
    it('stores a hash, audits reads, and requires explicit source scope', async () => {
      const stored = await admin.query(
        'SELECT token_hash FROM app_integration_tokens WHERE id=$1',
        [tokenId],
      );
      expect(stored.rows[0].token_hash).not.toContain(token);
      expect(stored.rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
      const audit = await admin.query(
        "SELECT count(*)::int AS count FROM app_audit WHERE organization_id=$1 AND action='integration.read.source'",
        [org],
      );
      expect(audit.rows[0].count).toBe(1);
      const created = await createIntegrationToken(context, {
        name: 'Portfolio only',
        scopes: ['portfolio:read'],
        expiresInDays: 1,
      });
      const client = await connect(created.token);
      try {
        expect(
          (await client.listTools()).tools.map((tool) => tool.name),
        ).toEqual(['list_holdings', 'list_timeline']);
      } finally {
        await client.close();
        await revokeIntegrationToken(context, created.id);
        await admin.query('DELETE FROM app_request_limits WHERE key=$1', [
          'mcp:' + created.id,
        ]);
      }
    });
    it('fails closed on expiry, membership removal, role downgrade, missing MFA and revocation', async () => {
      const ping = { jsonrpc: '2.0', id: 5, method: 'ping' };
      for (const [disable, restore] of [
        [
          "UPDATE app_integration_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
          "UPDATE app_integration_tokens SET expires_at=now()+interval '1 day' WHERE id=$1",
        ],
      ]) {
        await admin.query(disable, [tokenId]);
        expect((await POST(request(token, ping))).status).toBe(401);
        await admin.query(restore, [tokenId]);
      }
      await admin.query(
        'UPDATE app_memberships SET revoked_at=now() WHERE user_id=$1',
        [user],
      );
      expect((await POST(request(token, ping))).status).toBe(401);
      await admin.query(
        "UPDATE app_memberships SET revoked_at=null,role='viewer' WHERE user_id=$1",
        [user],
      );
      expect((await POST(request(token, ping))).status).toBe(401);
      await admin.query(
        "UPDATE app_memberships SET role='owner' WHERE user_id=$1",
        [user],
      );
      await admin.query(
        'UPDATE auth_user SET "twoFactorEnabled"=false WHERE id=$1',
        [user],
      );
      expect((await POST(request(token, ping))).status).toBe(401);
      await admin.query(
        'UPDATE auth_user SET "twoFactorEnabled"=true WHERE id=$1',
        [user],
      );
      expect(
        (await POST(request(token, ping, { origin: 'https://evil.invalid' })))
          .status,
      ).toBe(403);
      expect(
        (await POST(request(token, { text: 'x'.repeat(65536) }))).status,
      ).toBe(413);
      await revokeIntegrationToken(context, tokenId);
      expect((await POST(request(token, ping))).status).toBe(401);
    });
  },
);
