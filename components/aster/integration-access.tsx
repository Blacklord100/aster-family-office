'use client';
import { useCallback, useEffect, useState } from 'react';
import { Bot, Copy, KeyRound, Plus, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  IntegrationScope,
  IntegrationTokenInfo,
} from '@/lib/integration-contract';
import { useWorkspace } from './workspace-context';
import { Panel, Picker, Status } from './primitives';

const scopes: { id: IntegrationScope; label: string; description: string }[] = [
  {
    id: 'portfolio:read',
    label: 'Holdings & timeline',
    description: 'Recorded holdings and investment events.',
  },
  {
    id: 'sources:read',
    label: 'Original documents',
    description: 'Imported reports and email files, including their contents.',
  },
  {
    id: 'mailboxes:read',
    label: 'Connection status',
    description: 'Mailbox addresses and synchronization status.',
  },
];
const when = (value: string) =>
  new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

export function IntegrationAccess() {
  const { state } = useWorkspace();
  const admin = ['owner', 'admin'].includes(state.identity?.role ?? '');
  const [data, setData] = useState<{
    tokens: IntegrationTokenInfo[];
    endpoint: string;
    checkedAt: number;
  } | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false);
  const [name, setName] = useState(''),
    [days, setDays] = useState('7');
  const [selected, setSelected] = useState<IntegrationScope[]>([
    'portfolio:read',
  ]);
  const [secret, setSecret] = useState(''),
    [copied, setCopied] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/integrations/tokens', {
        signal,
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.message ?? 'Could not load access settings.');
      setData({ ...payload, checkedAt: Date.now() });
    } catch (e) {
      if (!signal?.aborted)
        setError(
          e instanceof Error ? e.message : 'Could not load access settings.',
        );
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // oxlint-disable-next-line react/react-compiler -- Remote state updates occur after awaiting the network response.
    if (admin) void load(controller.signal);
    return () => controller.abort();
  }, [admin, load]);
  const close = (value: boolean) => {
    setOpen(value);
    if (!value) {
      setSecret('');
      setCopied(false);
    }
  };
  async function create(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/integrations/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          scopes: selected,
          expiresInDays: Number(days),
        }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.message ?? 'Could not create access.');
      setSecret(payload.token);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create access.');
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/integrations/tokens', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.message ?? 'Could not revoke access.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke access.');
    } finally {
      setBusy(false);
    }
  }
  if (!admin)
    return (
      <Panel title="Apps & agents">
        <p className="method-note">
          Your workspace administrator manages access for external tools.
        </p>
      </Panel>
    );
  return (
    <>
      <Panel
        title="Connect your own assistant"
        subtitle="Choose exactly what a tool can read."
        action={
          <Button
            onClick={() => {
              setName('');
              setSelected(['portfolio:read']);
              setDays('7');
              setError('');
              setOpen(true);
            }}
          >
            <Plus data-icon="inline-start" />
            Create access
          </Button>
        }
      >
        <div className="methodology">
          <Bot />
          <div>
            <h3>Your tools, your permissions</h3>
            <p>
              Connect a compatible assistant to this workspace. Access expires
              automatically, and you can revoke it at any time.
            </p>
          </div>
          <ShieldCheck />
          <div>
            <h3>Read-only access</h3>
            <p>
              The connected tool receives only the categories you select.
              Original email and report contents require the separate document
              permission.
            </p>
          </div>
        </div>
        {data ? (
          <div className="mt-5 rounded-md border bg-muted/30 p-3 text-xs">
            <span className="text-muted-foreground">MCP endpoint</span>
            <code className="mt-1 block break-all">{data.endpoint}</code>
          </div>
        ) : (
          <Skeleton className="mt-5 h-14" />
        )}
      </Panel>
      {error && !open ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Panel
        title="Granted access"
        subtitle="Tokens are shown once and stored as hashes."
        className="mt-5"
      >
        {!data ? (
          <Skeleton className="h-24" />
        ) : data.tokens.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRound />
              </EmptyMedia>
              <EmptyTitle>No tools have access</EmptyTitle>
              <EmptyDescription>
                Create a named access token when you’re ready to connect an
                assistant.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col divide-y">
            {data.tokens.map((token) => {
              const active =
                !token.revokedAt &&
                new Date(token.expiresAt).getTime() > data.checkedAt;
              return (
                <div
                  key={token.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{token.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {token.scopes
                        .map(
                          (scope) =>
                            scopes.find((item) => item.id === scope)?.label,
                        )
                        .join(' · ')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Expires {when(token.expiresAt)} ·{' '}
                      {token.lastUsedAt
                        ? 'Last used ' + when(token.lastUsedAt)
                        : 'Never used'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Status tone={active ? 'green' : 'neutral'}>
                      {token.revokedAt
                        ? 'Revoked'
                        : active
                          ? 'Active'
                          : 'Expired'}
                    </Status>
                    {active ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void revoke(token.id)}
                        aria-label={'Revoke ' + token.name}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {secret ? 'Your access token' : 'Give a tool access'}
            </DialogTitle>
            <DialogDescription>
              {secret
                ? 'Copy this token now. It will not be shown again.'
                : 'Name the connection and choose the information it may read.'}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {secret ? (
            <div className="flex flex-col gap-4">
              <code
                data-testid="integration-secret"
                className="rounded-md border bg-muted p-3 text-xs break-all select-all"
              >
                {secret}
              </code>
              <Alert>
                <AlertTitle>
                  Store it in your tool’s secure configuration
                </AlertTitle>
                <AlertDescription>
                  Use the token as a Bearer credential for the MCP endpoint. The
                  connected tool can receive the data covered by its
                  permissions.
                </AlertDescription>
              </Alert>
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(secret);
                    setCopied(true);
                  } catch {
                    setError('Select and copy the token manually.');
                  }
                }}
              >
                <Copy data-icon="inline-start" />
                {copied ? 'Copied' : 'Copy token'}
              </Button>
              <Button variant="outline" onClick={() => close(false)}>
                Done
              </Button>
            </div>
          ) : (
            <form onSubmit={create} className="flex flex-col gap-5">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="integration-name">
                    Connection name
                  </FieldLabel>
                  <Input
                    id="integration-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="My local assistant"
                    maxLength={80}
                    required
                    autoComplete="off"
                  />
                </Field>
                <Field>
                  <FieldLabel>Expires after</FieldLabel>
                  <Picker
                    value={days}
                    onChange={setDays}
                    label="Access expiration"
                    options={[
                      { value: '1', label: '1 day' },
                      { value: '7', label: '7 days' },
                      { value: '30', label: '30 days' },
                    ]}
                  />
                </Field>
                <FieldSet>
                  <FieldLegend>Allowed information</FieldLegend>
                  {scopes.map((scope) => (
                    <Field orientation="horizontal" key={scope.id}>
                      <Checkbox
                        id={'scope-' + scope.id}
                        checked={selected.includes(scope.id)}
                        onCheckedChange={(checked) =>
                          setSelected((values) =>
                            checked
                              ? [...values, scope.id]
                              : values.filter((value) => value !== scope.id),
                          )
                        }
                      />
                      <div>
                        <FieldLabel htmlFor={'scope-' + scope.id}>
                          {scope.label}
                        </FieldLabel>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {scope.description}
                        </p>
                      </div>
                    </Field>
                  ))}
                </FieldSet>
              </FieldGroup>
              <Button
                type="submit"
                disabled={busy || !name.trim() || selected.length === 0}
              >
                {busy ? 'Creating…' : 'Create access token'}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
