import 'server-only';
import { z } from 'zod';
import type { MailProvider } from '../mailbox-contract';
import {
  providerFetch,
  boundedResponse,
  MAX_MAIL_BYTES,
  MailboxError,
} from './mailbox-provider';
const gmailBase = 'https://gmail.googleapis.com/gmail/v1/users/me';
const graphBase = 'https://graph.microsoft.com/v1.0/me';
const folderRoot =
  graphBase +
  '/mailFolders?includeHiddenFolders=true&$top=50&$select=id,childFolderCount';
const id = z.string().min(1).max(2048);
export type GmailCursor = {
  provider: 'gmail';
  stage: 'backfill' | 'history';
  cutoff: string | null;
  historyId: string;
  pageToken?: string;
};
export type GraphCursor = {
  provider: 'microsoft';
  stage: 'discover' | 'delta';
  cutoff: string | null;
  pending: string[];
  visited: string[];
  folders: { id: string; url: string | null }[];
  index: number;
  discoveredAt: number;
};
export type MailCursor = GmailCursor | GraphCursor;
export type MailPage = {
  cursor: MailCursor;
  messageIds: string[];
  complete: boolean;
};
export function assertGraphUrl(value: string, expectedPath?: string) {
  const url = new URL(value);
  if (
    url.origin !== 'https://graph.microsoft.com' ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 16384 ||
    !url.pathname.startsWith('/v1.0/me/') ||
    /%5c|\.\./i.test(url.pathname) ||
    (expectedPath && url.pathname !== expectedPath)
  )
    throw new MailboxError('INVALID_PROVIDER_CURSOR');
  return url.toString();
}
async function jsonGet(
  url: string,
  token: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const response = await providerFetch(
    url,
    {
      headers: {
        Authorization: 'Bearer ' + token,
        Prefer: 'IdType="ImmutableId", odata.maxpagesize=25',
      },
      signal,
    },
    fetcher,
  );
  try {
    return JSON.parse(
      (await boundedResponse(response, 1024 * 1024)).toString(),
    );
  } catch (error) {
    if (error instanceof MailboxError) throw error;
    throw new MailboxError('INVALID_PROVIDER_RESPONSE');
  }
}
export async function nextMailPage(
  provider: MailProvider,
  token: string,
  cursor: MailCursor | null,
  historyDays: number | null,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<MailPage> {
  const cutoff =
    cursor?.cutoff ??
    (historyDays
      ? new Date(Date.now() - historyDays * 86400000).toISOString()
      : null);
  if (provider === 'gmail') {
    let state: GmailCursor;
    if (!cursor) {
      const profile = z
        .object({ historyId: z.string().regex(/^\d+$/) })
        .parse(await jsonGet(gmailBase + '/profile', token, signal, fetcher));
      state = {
        provider,
        stage: 'backfill',
        cutoff,
        historyId: profile.historyId,
      };
    } else {
      if (cursor.provider !== provider)
        throw new MailboxError('INVALID_PROVIDER_CURSOR');
      state = { ...cursor };
    }
    const url = new URL(
      gmailBase + (state.stage === 'backfill' ? '/messages' : '/history'),
    );
    url.searchParams.set('maxResults', '25');
    if (state.pageToken) url.searchParams.set('pageToken', state.pageToken);
    if (state.stage === 'backfill') {
      url.searchParams.set('includeSpamTrash', 'true');
      if (state.cutoff)
        url.searchParams.set(
          'q',
          'after:' + Math.floor(Date.parse(state.cutoff) / 1000),
        );
    } else {
      url.searchParams.set('startHistoryId', state.historyId);
      url.searchParams.set('historyTypes', 'messageAdded');
    }
    let raw;
    try {
      raw = await jsonGet(url.toString(), token, signal, fetcher);
    } catch (error) {
      if (
        error instanceof MailboxError &&
        error.code === 'PROVIDER_NOT_FOUND'
      ) {
        const profile = z
          .object({ historyId: z.string().regex(/^\d+$/) })
          .parse(await jsonGet(gmailBase + '/profile', token, signal, fetcher));
        return {
          cursor: {
            ...state,
            stage: 'backfill',
            historyId: profile.historyId,
            pageToken: undefined,
          },
          messageIds: [],
          complete: false,
        };
      }
      throw error;
    }
    const data = z
      .object({
        messages: z.array(z.object({ id })).max(100).optional(),
        history: z
          .array(
            z.object({
              messagesAdded: z
                .array(z.object({ message: z.object({ id }) }))
                .max(1000)
                .optional(),
            }),
          )
          .max(1000)
          .optional(),
        nextPageToken: z.string().max(16000).optional(),
        historyId: z.string().regex(/^\d+$/).optional(),
      })
      .parse(raw);
    const ids = [
      ...new Set(
        state.stage === 'backfill'
          ? (data.messages ?? []).map((message) => message.id)
          : (data.history ?? []).flatMap((history) =>
              (history.messagesAdded ?? []).map((item) => item.message.id),
            ),
      ),
    ];
    if (ids.length > 500) throw new MailboxError('PROVIDER_PAGE_LIMIT');
    const complete = state.stage === 'history' && !data.nextPageToken;
    return {
      messageIds: ids,
      complete,
      cursor: {
        ...state,
        stage: !data.nextPageToken ? 'history' : state.stage,
        pageToken: data.nextPageToken,
        historyId:
          complete && data.historyId ? data.historyId : state.historyId,
      },
    };
  }
  if (cursor && cursor.provider !== provider)
    throw new MailboxError('INVALID_PROVIDER_CURSOR');
  const state: GraphCursor = cursor
    ? structuredClone(cursor)
    : {
        provider,
        stage: 'discover',
        cutoff,
        pending: [folderRoot],
        visited: [],
        folders: [],
        index: 0,
        discoveredAt: 0,
      };
  if (state.folders.length > 1000 || state.pending.length > 1000)
    throw new MailboxError('MAILBOX_FOLDER_LIMIT');
  if (state.stage === 'discover') {
    const url = state.pending.shift();
    if (!url) {
      state.stage = 'delta';
      state.index = 0;
      state.discoveredAt = Date.now();
      return {
        cursor: state,
        messageIds: [],
        complete: state.folders.length === 0,
      };
    }
    let raw;
    try {
      raw = await jsonGet(assertGraphUrl(url), token, signal, fetcher);
    } catch (error) {
      if (error instanceof MailboxError && error.code === 'PROVIDER_NOT_FOUND')
        return { cursor: state, messageIds: [], complete: false };
      throw error;
    }
    const data = z
      .object({
        value: z
          .array(
            z.object({
              id,
              childFolderCount: z.number().int().nonnegative().optional(),
              '@odata.type': z.string().optional(),
            }),
          )
          .max(1000),
        '@odata.nextLink': z.string().max(16384).optional(),
      })
      .parse(raw);
    if (data['@odata.nextLink'])
      state.pending.unshift(
        assertGraphUrl(data['@odata.nextLink'], new URL(url).pathname),
      );
    for (const folder of data.value) {
      if (
        folder['@odata.type'] === '#microsoft.graph.mailSearchFolder' ||
        state.visited.includes(folder.id)
      )
        continue;
      state.visited.push(folder.id);
      if (!state.folders.some((item) => item.id === folder.id))
        state.folders.push({ id: folder.id, url: null });
      if (folder.childFolderCount)
        state.pending.push(
          graphBase +
            '/mailFolders/' +
            encodeURIComponent(folder.id) +
            '/childFolders?includeHiddenFolders=true&$top=50&$select=id,childFolderCount',
        );
    }
    if (state.folders.length > 1000)
      throw new MailboxError('MAILBOX_FOLDER_LIMIT');
    return { cursor: state, messageIds: [], complete: false };
  }
  const folder = state.folders[state.index];
  if (!folder) {
    state.index = 0;
    if (
      Date.now() - state.discoveredAt > 3600000 ||
      state.folders.length === 0
    ) {
      state.stage = 'discover';
      state.pending = [folderRoot];
      state.visited = [];
    }
    return { cursor: state, messageIds: [], complete: true };
  }
  const path =
    '/v1.0/me/mailFolders/' + encodeURIComponent(folder.id) + '/messages/delta';
  const url = folder.url
    ? assertGraphUrl(folder.url, path)
    : 'https://graph.microsoft.com' +
      path +
      '?$select=id,receivedDateTime,sentDateTime,isDraft&$top=25';
  let raw;
  try {
    raw = await jsonGet(url, token, signal, fetcher);
  } catch (error) {
    if (error instanceof MailboxError && error.code === 'PROVIDER_NOT_FOUND') {
      if (folder.url) folder.url = null;
      else state.folders.splice(state.index, 1);
      return { cursor: state, messageIds: [], complete: false };
    }
    throw error;
  }
  const data = z
    .object({
      value: z
        .array(
          z.object({
            id,
            receivedDateTime: z.string().optional(),
            sentDateTime: z.string().optional(),
            isDraft: z.boolean().optional(),
            '@removed': z.unknown().optional(),
          }),
        )
        .max(1000),
      '@odata.nextLink': z.string().max(16384).optional(),
      '@odata.deltaLink': z.string().max(16384).optional(),
    })
    .parse(raw);
  const continuation = data['@odata.nextLink'] ?? data['@odata.deltaLink'];
  if (!continuation) throw new MailboxError('INVALID_PROVIDER_RESPONSE');
  folder.url = assertGraphUrl(continuation, path);
  if (!data['@odata.nextLink']) state.index += 1;
  const messageIds = data.value
    .filter(
      (message) =>
        !('@removed' in message) &&
        !message.isDraft &&
        (!state.cutoff ||
          Date.parse(message.receivedDateTime ?? message.sentDateTime ?? '') >=
            Date.parse(state.cutoff)),
    )
    .map((message) => message.id);
  return {
    cursor: state,
    messageIds: [...new Set(messageIds)],
    complete: false,
  };
}
export async function fetchMailOriginal(
  provider: MailProvider,
  token: string,
  messageId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  id.parse(messageId);
  if (provider === 'gmail') {
    const response = await providerFetch(
      gmailBase + '/messages/' + encodeURIComponent(messageId) + '?format=raw',
      { headers: { Authorization: 'Bearer ' + token }, signal },
      fetcher,
    );
    const raw = JSON.parse(
      (
        await boundedResponse(
          response,
          Math.ceil((MAX_MAIL_BYTES * 4) / 3) + 65536,
        )
      ).toString(),
    );
    const data = z
      .object({ raw: z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/) })
      .parse(raw);
    const bytes = Buffer.from(data.raw, 'base64url');
    if (bytes.length > MAX_MAIL_BYTES)
      throw new MailboxError('MESSAGE_TOO_LARGE');
    return bytes;
  }
  const response = await providerFetch(
    graphBase + '/messages/' + encodeURIComponent(messageId) + '/$value',
    {
      headers: {
        Authorization: 'Bearer ' + token,
        Prefer: 'IdType="ImmutableId"',
      },
      signal,
    },
    fetcher,
  );
  return boundedResponse(response, MAX_MAIL_BYTES);
}
