'use client';
import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorkspace } from './workspace-context';
import { DataAccessSettings } from './data-access-settings';
import {
  useWorkspaceRequest,
  WorkspaceRequestError,
} from './use-workspace-request';
type Member = {
  id: string;
  name: string;
  email: string;
  role: string;
  mfaEnabled: boolean;
  revokedAt: string | null;
};
type Event = {
  id: string;
  action: string;
  createdAt: string;
  resourceId: string;
};
export function TeamSettings() {
  const { key } = useWorkspaceRequest();
  return <ScopedTeamSettings key={key} />;
}
function ScopedTeamSettings() {
  const { request } = useWorkspaceRequest();
  const { state } = useWorkspace(),
    admin = ['owner', 'admin'].includes(state.identity?.role ?? '');
  const [members, setMembers] = useState<Member[]>([]),
    [events, setEvents] = useState<Event[]>([]),
    [error, setError] = useState(''),
    [link, setLink] = useState(''),
    [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true),
    [copied, setCopied] = useState(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        const [team, audit] = await Promise.all([
          request<{ members: Member[] }>('/api/team', { signal }),
          request<{ events: Event[] }>('/api/audit', { signal }),
        ]);
        if (!Array.isArray(team.members) || !Array.isArray(audit.events))
          throw new Error('The team response was incomplete. Try again.');
        setMembers(team.members);
        setEvents(audit.events);
      } catch (e) {
        if (signal?.aborted) return;
        if (
          e instanceof WorkspaceRequestError &&
          [401, 403].includes(e.status)
        ) {
          setMembers([]);
          setEvents([]);
          setLink('');
        }
        setError(e instanceof Error ? e.message : 'Could not load team');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [request],
  );
  async function updateMember(
    userId: string,
    action: 'role' | 'remove' | 'restore',
    role?: string,
  ) {
    setBusy(true);
    setError('');
    try {
      await request('/api/team', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action, role }),
      });
      await load();
    } catch (error) {
      if (
        error instanceof WorkspaceRequestError &&
        [401, 403].includes(error.status)
      ) {
        setMembers([]);
        setEvents([]);
        setLink('');
      }
      setError(
        error instanceof Error ? error.message : 'Could not update access',
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    // oxlint-disable-next-line react/react-compiler -- Remote data is synchronized after the network request.
    if (admin) void load(controller.signal);
    return () => controller.abort();
  }, [admin, load]);
  if (!admin)
    return (
      <p className="text-sm text-muted-foreground">
        Your administrator manages workspace membership.
      </p>
    );
  return (
    <section className="flex flex-col gap-4 border-t pt-5">
      <div>
        <h3 className="font-medium">Team & access</h3>
        <p className="text-xs text-muted-foreground">
          Invite-only accounts. Every member sets up an authenticator.
        </p>
      </div>
      {loading ? (
        <output className="text-xs text-muted-foreground">
          Loading team and audit records…
        </output>
      ) : null}
      {members.map((m) => (
        <div
          key={m.id}
          className="flex flex-wrap items-center justify-between gap-3 text-sm"
        >
          <div>
            <strong className="font-medium">{m.name}</strong>
            <div className="text-xs text-muted-foreground">
              {m.email} ·{' '}
              {m.revokedAt
                ? 'Access removed'
                : m.mfaEnabled
                  ? 'MFA enabled'
                  : 'Enrollment pending'}
            </div>
          </div>
          {m.id !== state.identity?.user.id &&
          m.role !== 'owner' &&
          !m.revokedAt &&
          (state.identity?.role === 'owner' || m.role !== 'admin') ? (
            <select
              aria-label={'Role for ' + m.name}
              value={m.role}
              disabled={busy}
              onChange={(e) => void updateMember(m.id, 'role', e.target.value)}
              className="h-8 rounded border bg-background px-2 text-xs"
            >
              <option value="viewer">Viewer</option>
              <option value="analyst">Analyst</option>
              {state.identity?.role === 'owner' ? (
                <option value="admin">Administrator</option>
              ) : null}
            </select>
          ) : (
            <span className="text-xs capitalize">{m.role}</span>
          )}
          {m.id !== state.identity?.user.id &&
          m.role !== 'owner' &&
          (state.identity?.role === 'owner' || m.role !== 'admin') ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void updateMember(m.id, m.revokedAt ? 'restore' : 'remove')
              }
            >
              {m.revokedAt ? 'Restore access' : 'Remove access'}
            </Button>
          ) : null}
        </div>
      ))}
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          setLink('');
          const form = new FormData(e.currentTarget);
          try {
            const body = await request<{ invitation: { url: string } }>(
              '/api/team',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  name: form.get('name'),
                  email: form.get('email'),
                  role: form.get('role'),
                }),
              },
            );
            setLink(body.invitation.url);
            setCopied(false);
            await load();
          } catch (e) {
            if (
              e instanceof WorkspaceRequestError &&
              [401, 403].includes(e.status)
            ) {
              setMembers([]);
              setEvents([]);
              setLink('');
            }
            setError(e instanceof Error ? e.message : 'Could not invite');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input
            name="name"
            aria-label="Invitee name"
            placeholder="Full name"
            required
            minLength={2}
          />
          <Input
            name="email"
            aria-label="Invitee email"
            placeholder="Email address"
            type="email"
            required
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            name="role"
            aria-label="Invitation role"
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
          >
            <option value="viewer">Viewer · read only</option>
            <option value="analyst">Analyst · upload & review</option>
            {state.identity?.role === 'owner' ? (
              <option value="admin">Administrator</option>
            ) : null}
          </select>
          <Button disabled={busy} type="submit">
            Create invitation
          </Button>
        </div>
      </form>
      {link ? (
        <div className="rounded-lg border bg-muted/40 p-3 text-xs">
          <p className="mb-2">
            Private one-time invitation · expires in 24 hours. Share directly
            with the intended person.
          </p>
          <Input aria-label="Private invitation link" value={link} readOnly />
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                setError(
                  'Copy failed. Select and copy the invitation link manually.',
                );
              }
            }}
          >
            {copied ? 'Copied' : 'Copy invitation'}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
          <Button variant="link" size="sm" onClick={() => void load()}>
            Reload team
          </Button>
        </p>
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm">
          Recent audit activity
        </summary>
        <div className="mt-3 max-h-48 space-y-2 overflow-auto">
          {events.map((e) => (
            <div key={e.id} className="text-xs">
              <span className="font-medium">{e.action}</span>
              <span className="ml-2 text-muted-foreground">
                {new Date(e.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </details>
      <DataAccessSettings />
    </section>
  );
}
