'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCheck,
  FileText,
  History,
  Mail,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useWorkspace } from './workspace-context';
import { PageHeading, Panel, Status, Metric, Picker } from './primitives';
import { IntegrationAccess } from './integration-access';
import { FolderConnections } from './folder-connections';
import styles from './connections.module.css';

import type {
  MailProvider as Provider,
  ProviderInfo,
  MailboxInfo as Mailbox,
  MailboxResponse as ConnectionsData,
} from '@/lib/mailbox-contract';
const providers = [
  {
    id: 'gmail' as const,
    name: 'Google Workspace',
    mark: 'G',
    description: 'Gmail and Google Workspace accounts',
    className: styles.google,
  },
  {
    id: 'microsoft' as const,
    name: 'Microsoft 365',
    mark: 'M',
    description: 'Outlook and Microsoft 365 accounts',
    className: styles.microsoft,
  },
];
const historyOptions = [
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
  { value: 'all', label: 'All available history' },
];
const statusLabel: Record<string, string> = {
  active: 'Connected',
  syncing: 'Importing',
  queued: 'Scheduled',
  paused: 'Paused',
  disconnected: 'Disconnected',
  reauth_required: 'Reconnect needed',
  error: 'Needs attention',
  backfilling: 'Importing history',
};
const stamp = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Not yet';

export function ConnectionsView() {
  const { state } = useWorkspace();
  const [data, setData] = useState<ConnectionsData | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [history, setHistory] = useState('90'),
    [busy, setBusy] = useState(''),
    [refresh, setRefresh] = useState(0);
  const [setup, setSetup] = useState<ProviderInfo | null>(null),
    [disconnect, setDisconnect] = useState<Mailbox | null>(null);
  const canConnect = ['owner', 'admin', 'analyst'].includes(
    state.identity?.role ?? '',
  );
  const admin = ['owner', 'admin'].includes(state.identity?.role ?? '');
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/mailboxes', {
        cache: 'no-store',
        signal,
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(
          payload.message ?? 'Could not load mailbox connections.',
        );
      setData(payload);
      setError('');
    } catch (e) {
      if (!signal?.aborted)
        setError(
          e instanceof Error
            ? e.message
            : 'Could not load mailbox connections.',
        );
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // oxlint-disable-next-line react/react-compiler -- Remote state updates occur after awaiting the network response.
    void load(controller.signal);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(controller.signal);
    }, 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, refresh]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const message = url.searchParams.get('mailbox');
    if (message) {
      void Promise.resolve().then(() => {
        if (message === 'connected')
          setNotice('Mailbox connected. Its first import is scheduled.');
        else
          setError(
            'The mailbox was not connected. Please try again or check provider setup.',
          );
      });
      url.searchParams.delete('mailbox');
      url.searchParams.delete('code');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);
  async function connect(provider: Provider) {
    setBusy(provider);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/mailboxes/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          historyDays: history === 'all' ? 'all' : Number(history),
        }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.message ?? 'Could not start authorization.');
      const destination = new URL(payload.authorizationUrl);
      if (
        !['accounts.google.com', 'login.microsoftonline.com'].includes(
          destination.hostname,
        ) ||
        destination.protocol !== 'https:'
      )
        throw new Error(
          'The provider returned an invalid authorization address.',
        );
      window.location.assign(destination.toString());
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not connect this account.',
      );
      setBusy('');
    }
  }
  async function update(
    mailbox: Mailbox,
    action: 'sync' | 'pause' | 'resume' | 'disconnect',
  ) {
    setBusy(mailbox.id);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/mailboxes/' + mailbox.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.message ?? 'Could not update this mailbox.');
      setDisconnect(null);
      setNotice(
        action === 'sync'
          ? 'A new synchronization is scheduled.'
          : action === 'pause'
            ? 'Synchronization paused.'
            : action === 'resume'
              ? 'Synchronization resumed.'
              : 'Mailbox disconnected. Imported reports remain in the workspace.',
      );
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not update this mailbox.',
      );
    } finally {
      setBusy('');
    }
  }
  const mailboxes = data?.mailboxes ?? [],
    connected = mailboxes.filter(
      (mailbox) => mailbox.status !== 'disconnected',
    );
  const imported = mailboxes.reduce(
    (total, mailbox) => total + (mailbox.importedCount ?? 0),
    0,
  );
  const needsAttention = connected.filter(
    (mailbox) =>
      mailbox.errorCode ||
      ['reauth_required', 'error'].includes(mailbox.status),
  ).length;
  return (
    <>
      <PageHeading
        title="Connections"
        subtitle="Bring emails, documents and investment updates into one workspace."
      >
        <Button
          variant="outline"
          onClick={() => setRefresh((value) => value + 1)}
          disabled={!!busy}
        >
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
      </PageHeading>
      <Tabs defaultValue="folders" className="gap-6">
        <TabsList variant="line">
          <TabsTrigger value="folders">Folders</TabsTrigger>
          <TabsTrigger value="mailboxes">Mailboxes</TabsTrigger>
          <TabsTrigger value="tools">Apps & agents</TabsTrigger>
        </TabsList>
        <TabsContent value="folders">
          <FolderConnections refresh={refresh} />
        </TabsContent>
        <TabsContent value="mailboxes" className="flex flex-col gap-5">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Connection needs attention</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {notice ? (
            <Alert>
              <CheckCheck />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}
          <div className="metrics-row three">
            <Metric
              label="Connected accounts"
              value={data ? String(connected.length) : '—'}
              note="Each account authorizes its own access"
            />
            <Metric
              label="Messages imported"
              value={data ? imported.toLocaleString('en-GB') : '—'}
              note="Original emails retained as source files"
            />
            <Metric
              label="Need attention"
              value={data ? String(needsAttention) : '—'}
              note={
                needsAttention
                  ? 'Reconnect an account to resume updates'
                  : 'Connection issues will appear here'
              }
            />
          </div>
          <div className={styles.intro}>
            <div>
              <span className={styles.eyebrow}>
                AUTOMATIC REPORT COLLECTION
              </span>
              <h2>Let the reports come to you.</h2>
              <p>
                Connect the people who receive your investment updates. Aster
                brings their reports into one review queue, with the original
                email always attached.
              </p>
            </div>
            <div
              className={styles.flow}
              aria-label="Email to document review to portfolio"
            >
              <span>
                <Mail />
                Email
              </span>
              <ArrowRight />
              <span>
                <FileText />
                Review
              </span>
              <ArrowRight />
              <span>
                <CheckCheck />
                Portfolio
              </span>
            </div>
          </div>
          <div className={styles.history}>
            <div>
              <History />
              <div>
                <h3>Start with your history</h3>
                <p>
                  Choose how far back a newly connected account should look.
                </p>
              </div>
            </div>
            <Picker
              value={history}
              onChange={setHistory}
              label="Email history to import"
              options={historyOptions}
            />
          </div>
          <div className={styles.providers}>
            {providers.map((provider) => {
              const configuration = data?.providers.find(
                (item) => item.id === provider.id,
              );
              return (
                <section className={styles.provider} key={provider.id}>
                  <div className={styles.providerTop}>
                    <span
                      className={styles.providerMark + ' ' + provider.className}
                    >
                      {provider.mark}
                    </span>
                    <Status
                      tone={configuration?.configured ? 'green' : 'neutral'}
                    >
                      {!data
                        ? 'Checking setup'
                        : configuration?.configured
                          ? 'Available'
                          : 'Setup required'}
                    </Status>
                  </div>
                  <h3>{provider.name}</h3>
                  <p>{provider.description}</p>
                  <div className={styles.providerBottom}>
                    <span>
                      <ShieldCheck />
                      Read-only access
                    </span>
                    <Button
                      variant={
                        configuration?.configured ? 'default' : 'outline'
                      }
                      disabled={!configuration || !!busy || !canConnect}
                      onClick={() =>
                        configuration?.configured
                          ? void connect(provider.id)
                          : setSetup(configuration ?? null)
                      }
                    >
                      {busy === provider.id
                        ? 'Connecting…'
                        : configuration?.configured
                          ? 'Connect account'
                          : 'View setup'}
                      <ArrowRight data-icon="inline-end" />
                    </Button>
                  </div>
                </section>
              );
            })}
          </div>
          <p className={styles.disclosure}>
            Connecting an account allows authorized members of this workspace to
            review its imported emails and attachments. Each colleague signs in
            to their own provider account.
          </p>
          <Panel
            title="Your connected accounts"
            subtitle="Import history, monitor progress and manage access."
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.location.assign('?view=agents')}
              >
                Open Processing
                <ArrowRight data-icon="inline-end" />
              </Button>
            }
          >
            {!data ? (
              <Skeleton className="h-28" />
            ) : mailboxes.length === 0 ? (
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Mail />
                  </EmptyMedia>
                  <EmptyTitle>Your first connection starts here</EmptyTitle>
                  <EmptyDescription>
                    Connect an account above. Until then, you can upload PDF
                    reports and exported emails in Processing.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className={styles.mailboxes}>
                {mailboxes.map((mailbox) => (
                  <section key={mailbox.id} className={styles.mailbox}>
                    <div className={styles.mailboxHeading}>
                      <span className={styles.mailboxMark}>
                        {mailbox.provider === 'gmail' ? 'G' : 'M'}
                      </span>
                      <div>
                        <h3>{mailbox.displayName || mailbox.email}</h3>
                        <p>{mailbox.email}</p>
                      </div>
                      <Status
                        tone={
                          ['active', 'syncing'].includes(mailbox.status)
                            ? 'green'
                            : ['error', 'reauth_required'].includes(
                                  mailbox.status,
                                )
                              ? 'amber'
                              : 'neutral'
                        }
                      >
                        {statusLabel[mailbox.status] ?? mailbox.status}
                      </Status>
                    </div>
                    <div className={styles.mailboxDetails}>
                      <div>
                        <span>Imported messages</span>
                        <strong>
                          {(mailbox.importedCount ?? 0).toLocaleString('en-GB')}
                        </strong>
                      </div>
                      <div>
                        <span>Last synchronized</span>
                        <strong>{stamp(mailbox.lastSyncedAt)}</strong>
                      </div>
                      <div>
                        <span>History</span>
                        <strong>
                          {mailbox.historyDays === 'all'
                            ? 'All available'
                            : (mailbox.historyDays ?? 90) + ' days'}
                        </strong>
                      </div>
                      <div>
                        <span>Skipped files</span>
                        <strong>{mailbox.skippedCount ?? 0}</strong>
                      </div>
                    </div>
                    {mailbox.errorCode ? (
                      <p className={styles.mailboxError}>
                        {mailbox.status === 'reauth_required'
                          ? 'Authorize this account again to continue importing.'
                          : 'The last import could not finish. Aster will keep its saved progress.'}{' '}
                        <span>{mailbox.errorCode}</span>
                      </p>
                    ) : null}
                    {mailbox.currentUserCanManage ? (
                      <div className={styles.mailboxActions}>
                        {![
                          'disconnected',
                          'reauth_required',
                          'paused',
                        ].includes(mailbox.status) ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!!busy}
                              onClick={() => void update(mailbox, 'sync')}
                            >
                              <RefreshCw data-icon="inline-start" />
                              Sync now
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!!busy}
                              onClick={() => void update(mailbox, 'pause')}
                            >
                              <Pause data-icon="inline-start" />
                              Pause
                            </Button>
                          </>
                        ) : mailbox.status === 'paused' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!!busy}
                            onClick={() => void update(mailbox, 'resume')}
                          >
                            <Play data-icon="inline-start" />
                            Resume
                          </Button>
                        ) : null}
                        {['reauth_required', 'disconnected'].includes(
                          mailbox.status,
                        ) && canConnect ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!!busy}
                            onClick={() => void connect(mailbox.provider)}
                          >
                            Reconnect
                          </Button>
                        ) : null}
                        {mailbox.status !== 'disconnected' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!!busy}
                            onClick={() => setDisconnect(mailbox)}
                          >
                            <Unplug data-icon="inline-start" />
                            Disconnect
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                ))}
              </div>
            )}
          </Panel>
        </TabsContent>
        <TabsContent value="tools">
          <IntegrationAccess />
        </TabsContent>
      </Tabs>
      <Dialog
        open={!!setup}
        onOpenChange={(value) => {
          if (!value) setSetup(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Set up{' '}
              {setup?.id === 'gmail' ? 'Google Workspace' : 'Microsoft 365'}
            </DialogTitle>
            <DialogDescription>
              Your administrator must register Aster with the email provider
              before accounts can connect.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 text-sm">
            <p>
              Once setup is complete, each person authorizes their own account
              using the provider’s sign-in page.
            </p>
            {admin ? (
              <>
                <p className="text-muted-foreground">
                  Server settings still required:
                </p>
                <ul className="list-inside list-disc text-xs">
                  {setup?.missing.map((key) => (
                    <li key={key}>
                      <code>{key}</code>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  The self-hosting guide includes provider registration and
                  callback URLs. Client secrets stay on your server.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">
                Ask a workspace administrator to finish provider setup.
              </p>
            )}
            <Button variant="outline" onClick={() => setSetup(null)}>
              Got it
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!disconnect}
        onOpenChange={(value) => {
          if (!value) setDisconnect(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect this account?</DialogTitle>
            <DialogDescription>{disconnect?.email}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Aster will remove its saved credentials and stop future imports.
            Previously imported emails, reports and reviewed records remain in
            this workspace.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDisconnect(null)}>
              Keep connected
            </Button>
            <Button
              variant="destructive"
              disabled={!!busy}
              onClick={() =>
                disconnect && void update(disconnect, 'disconnect')
              }
            >
              Disconnect account
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
