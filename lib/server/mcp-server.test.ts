import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { IntegrationScope } from '../integration-contract';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({}));
import { createAsterMcpServer } from './mcp-server';

describe('MCP tool permission catalog', () => {
  it.each<{ scopes: IntegrationScope[]; expected: string[] }>([
    { scopes: [], expected: [] },
    {
      scopes: ['portfolio:read'],
      expected: ['list_holdings', 'list_timeline', 'read_exposure'],
    },
    {
      scopes: ['sources:read'],
      expected: [
        'list_sources',
        'read_source',
        'list_processing',
        'read_processing',
      ],
    },
    { scopes: ['mailboxes:read'], expected: ['list_mailboxes'] },
    {
      scopes: ['portfolio:read', 'sources:read', 'mailboxes:read'],
      expected: [
        'list_holdings',
        'list_timeline',
        'list_sources',
        'read_source',
        'list_mailboxes',
        'read_exposure',
        'list_processing',
        'read_processing',
        'list_reporting_calendar',
        'list_exceptions',
      ],
    },
  ])(
    'only advertises explicitly granted read tools: $scopes',
    async ({ scopes, expected }) => {
      const server = createAsterMcpServer({
        organizationId: '11111111-1111-4111-8111-111111111111',
        userId: 'fixture',
        tokenId: '22222222-2222-4222-8222-222222222222',
        scopes,
      });
      const client = new Client({ name: 'catalog-fixture', version: '1.0.0' });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    try {
      if (!expected.length) {
        await expect(client.listTools()).rejects.toThrow('Method not found');
        return;
      }
      const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual(expected);
        for (const tool of listed.tools)
          expect(tool.annotations).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          });
        expect(
          (await client.callTool({ name: 'accept_review', arguments: {} }))
            .isError,
        ).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});
