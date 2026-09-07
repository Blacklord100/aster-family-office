'use client';
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorkspace } from './workspace-context';
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
  const { state } = useWorkspace(),
    admin = ['owner', 'admin'].includes(state.identity?.role ?? '');
  const [members, setMembers] = useState<Member[]>([]),
    [events, setEvents] = useState<Event[]>([]),
    [error, setError] = useState(''),
    [link, setLink] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      const [team, audit] = await Promise.all([
        fetch('/api/team'),
        fetch('/api/audit'),
      ]);
      const t = await team.json(),
        a = await audit.json();
      if (!team.ok) throw new Error(t.message);
      setMembers(t.members);
      if (audit.ok) setEvents(a.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load team');
    }
  }
  async function updateMember(
    userId: string,
    action: 'role' | 'remove' | 'restore',
    role?: string,
  ) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/team', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action, role }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message);
      await load();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not update access',
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- Synchronizes remote team state after an awaited network request.
    if (admin) void load();
  }, [admin]);
  if (!admin)
    return (
      <p className="text-sm text-muted-foreground">
        Your administrator manages workspace membership.
      </p>
    );
  return (
    <section className="space-y-4 border-t pt-5">
      <div>
        <h3 className="font-medium">Team & access</h3>
        <p className="text-xs text-muted-foreground">
          Invite-only accounts. Every member sets up an authenticator.
        </p>
      </div>
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
            const r = await fetch('/api/team', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: form.get('name'),
                email: form.get('email'),
                role: form.get('role'),
              }),
            });
            const body = await r.json();
            if (!r.ok) throw new Error(body.message);
            setLink(body.invitation.url);
            await load();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not invite');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid grid-cols-2 gap-2">
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
        <div className="flex items-center gap-2">
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
            onClick={() => void navigator.clipboard.writeText(link)}
          >
            Copy invitation
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
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
    </section>
  );
}
