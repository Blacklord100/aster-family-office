import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import {
  nextMailPage,
  fetchMailOriginal,
  assertGraphUrl,
  type GraphCursor,
  type GmailCursor,
} from './mailbox-pages';
import {
  boundedResponse,
  exchangeTokens,
  providerConfiguration,
} from './mailbox-provider';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function responses(...items: Response[]) {
  return vi.fn<typeof fetch>(async () => {
    const response = items.shift();
    if (!response) throw new Error('Unexpected provider call');
    return response;
  });
}
describe('mail provider boundaries and continuation', () => {
  it('captures Gmail history before backfill and preserves intermediate pagination', async () => {
    const fetcher = responses(
      json({ historyId: '10' }),
      json({ messages: [{ id: 'a' }], nextPageToken: 'page2' }),
      json({ messages: [{ id: 'b' }] }),
      json({
        historyId: '12',
        history: [
          {
            messagesAdded: [{ message: { id: 'c' } }, { message: { id: 'c' } }],
          },
        ],
      }),
    );
    const first = await nextMailPage(
      'gmail',
      'fixture',
      null,
      90,
      undefined,
      fetcher,
    );
    expect(first.messageIds).toEqual(['a']);
    expect((first.cursor as GmailCursor).historyId).toBe('10');
    const second = await nextMailPage(
      'gmail',
      'fixture',
      first.cursor,
      90,
      undefined,
      fetcher,
    );
    expect(second.messageIds).toEqual(['b']);
    expect(second.complete).toBe(false);
    const third = await nextMailPage(
      'gmail',
      'fixture',
      second.cursor,
      90,
      undefined,
      fetcher,
    );
    expect(third.messageIds).toEqual(['c']);
    expect(third.complete).toBe(true);
    expect((third.cursor as GmailCursor).historyId).toBe('12');
    expect(fetcher.mock.calls[1][0] as string).toContain(
      'includeSpamTrash=true',
    );
  });
  it('recovers from expired Gmail history by full backfill without advancing past missing pages', async () => {
    const cursor: GmailCursor = {
      provider: 'gmail',
      cutoff: '2025-01-01T00:00:00Z',
      historyId: '1',
      stage: 'history',
    };
    const result = await nextMailPage(
      'gmail',
      'fixture',
      cursor,
      365,
      undefined,
      responses(json({}, 404), json({ historyId: '20' })),
    );
    expect(result.complete).toBe(false);
    expect(result.messageIds).toEqual([]);
    expect(result.cursor).toMatchObject({
      stage: 'backfill',
      historyId: '20',
      cutoff: cursor.cutoff,
    });
  });
  it('walks nested Graph folders and preserves a delta cursor per folder', async () => {
    const fetcher = responses(
      json({ value: [{ id: 'inbox', childFolderCount: 1 }] }),
      json({ value: [{ id: 'archive', childFolderCount: 0 }] }),
    );
    let page = await nextMailPage(
      'microsoft',
      'fixture',
      null,
      null,
      undefined,
      fetcher,
    );
    page = await nextMailPage(
      'microsoft',
      'fixture',
      page.cursor,
      null,
      undefined,
      fetcher,
    );
    page = await nextMailPage(
      'microsoft',
      'fixture',
      page.cursor,
      null,
      undefined,
      fetcher,
    );
    expect(
      (page.cursor as GraphCursor).folders.map((folder) => folder.id),
    ).toEqual(['inbox', 'archive']);
    const path =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta';
    const first = await nextMailPage(
      'microsoft',
      'fixture',
      page.cursor,
      null,
      undefined,
      responses(
        json({
          value: [
            { id: 'a', receivedDateTime: '2026-01-01' },
            { id: 'deleted', '@removed': { reason: 'deleted' } },
            { id: 'draft', isDraft: true },
          ],
          '@odata.nextLink': path + '?$skiptoken=1',
        }),
      ),
    );
    expect(first.messageIds).toEqual(['a']);
    expect((first.cursor as GraphCursor).index).toBe(0);
    const second = await nextMailPage(
      'microsoft',
      'fixture',
      first.cursor,
      null,
      undefined,
      responses(
        json({ value: [], '@odata.deltaLink': path + '?$deltatoken=2' }),
      ),
    );
    expect((second.cursor as GraphCursor).index).toBe(1);
    expect((second.cursor as GraphCursor).folders[0].url).toContain(
      '$deltatoken=2',
    );
  });
  it('rejects foreign, credentialed or cross-account continuation URLs', () => {
    for (const url of [
      'https://evil.invalid/v1.0/me/mailFolders',
      'http://graph.microsoft.com/v1.0/me/mailFolders',
      'https://graph.microsoft.com/v1.0/users/other/messages',
      'https://user:password@graph.microsoft.com/v1.0/me/messages',
      'https://graph.microsoft.com/v1.0/me/messages#secret',
    ])
      expect(() => assertGraphUrl(url)).toThrow();
    expect(() =>
      assertGraphUrl(
        'https://graph.microsoft.com/v1.0/me/messages',
        '/v1.0/me/mailFolders',
      ),
    ).toThrow();
  });
  it('returns identical MIME bytes and rejects oversized streamed responses', async () => {
    const bytes = Buffer.from('Subject: fixture\r\n\r\nSynthetic content');
    expect(
      await fetchMailOriginal(
        'gmail',
        'fixture',
        'a',
        undefined,
        responses(json({ raw: bytes.toString('base64url') })),
      ),
    ).toEqual(bytes);
    expect(
      await fetchMailOriginal(
        'microsoft',
        'fixture',
        'a',
        undefined,
        responses(new Response(bytes)),
      ),
    ).toEqual(bytes);
    await expect(boundedResponse(new Response('12345'), 4)).rejects.toThrow(
      'MESSAGE_TOO_LARGE',
    );
  });
  it('honors provider throttling and never follows redirects', async () => {
    const fetcher = responses(
      new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
    );
    await expect(
      fetchMailOriginal('gmail', 'fixture', 'a', undefined, fetcher),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryAfter: 120 });
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('rejects missing provider setup, token permissions with write access, and absent refresh tokens', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'fixture-client');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'fixture-secret');
    try {
      const result = await exchangeTokens(
        'gmail',
        { grant_type: 'authorization_code', code: 'fixture' },
        undefined,
        responses(
          json({
            access_token: 'fixture',
            refresh_token: 'refresh',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
          }),
        ),
      );
      expect(result.refreshToken).toBe('refresh');
      await expect(
        exchangeTokens(
          'gmail',
          {},
          undefined,
          responses(
            json({
              access_token: 'fixture',
              refresh_token: 'refresh',
              expires_in: 3600,
              token_type: 'Bearer',
              scope: 'https://www.googleapis.com/auth/gmail.modify',
            }),
          ),
        ),
      ).rejects.toThrow('SCOPES_NOT_GRANTED');
      await expect(
        exchangeTokens(
          'gmail',
          {},
          undefined,
          responses(
            json({
              access_token: 'fixture',
              expires_in: 3600,
              token_type: 'Bearer',
              scope: 'https://www.googleapis.com/auth/gmail.readonly',
            }),
          ),
        ),
      ).rejects.toThrow('OFFLINE_ACCESS_REQUIRED');
      vi.stubEnv('GOOGLE_CLIENT_SECRET', 'TODO');
      expect(providerConfiguration('gmail').configured).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
