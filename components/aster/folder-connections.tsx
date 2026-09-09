'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Bot,
  FileText,
  FolderOpen,
  FolderSync,
  Pause,
  Play,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useWorkspace } from './workspace-context';
import { DemoLauncher } from './demo-workspace';
import styles from './connections.module.css';

import type {
  FolderConnectionInfo as FolderConnection,
  FolderResponse,
  FolderAction,
} from '@/lib/folder-connection-contract';
const labels: Record<string, string> = {
  queued: 'Queued',
  processing: 'Processing',
  awaiting_review: 'Needs review',
  accepted: 'Accepted',
  failed: 'Needs attention',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  imported: 'Imported',
  duplicate: 'Duplicate',
  skipped: 'Skipped',
};
const stamp = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Waiting for first scan';

export function FolderConnections({ refresh = 0 }: { refresh?: number }) {
  const { reload } = useWorkspace();
  const [snapshot, setSnapshot] = useState<FolderResponse | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [disconnect, setDisconnect] = useState<FolderConnection | null>(null);
  const lock = useRef(false);
  const epoch = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const version = epoch.current;
    try {
      const response = await fetch('/api/folders', {
        cache: 'no-store',
        signal,
      });
      const result = await response.json().catch(() => {
        throw new Error(
          'This service is temporarily unavailable. Please try again.',
        );
      });
      if (!response.ok)
        throw new Error(result.message || 'Could not load folder connections.');
      if (!signal?.aborted && version === epoch.current) {
        setSnapshot(result);
        setError('');
      }
    } catch (issue) {
      if (!signal?.aborted && version === epoch.current)
        setError(
          issue instanceof Error
            ? issue.message
            : 'Could not load folder connections.',
        );
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!document.hidden && !lock.current) await load(controller.signal);
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load, refresh]);
  async function change(
    key: string,
    url: string,
    method: 'POST' | 'PATCH',
    body: unknown,
  ) {
    if (lock.current) return;
    lock.current = true;
    epoch.current += 1;
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => {
        throw new Error(
          'This service is temporarily unavailable. Please try again.',
        );
      });
      if (!response.ok)
        throw new Error(result.message || 'Could not update this folder.');
      setDisconnect(null);
      const action = (body as { action?: FolderAction }).action;
      setNotice(
        action === 'pause'
          ? 'Folder scanning paused. Documents already queued will finish processing.'
          : action === 'disconnect'
            ? 'Folder disconnected. Imported sources remain in the workspace.'
            : action === 'retry'
              ? 'Failed imports are scheduled for another attempt.'
              : 'Folder scan scheduled. New source files will enter Processing automatically.',
      );
      await load();
      reload();
    } catch (issue) {
      setError(
        issue instanceof Error
          ? issue.message
          : 'Could not update this folder.',
      );
    } finally {
      lock.current = false;
      setBusy('');
    }
  }
  const connect = (directory: FolderResponse['directories'][number]) =>
    void change(directory.directory, '/api/folders', 'POST', {
      directory: directory.directory,
      displayName: directory.displayName,
    });
  const update = (connection: FolderConnection, action: FolderAction) =>
    void change(connection.id, '/api/folders/' + connection.id, 'PATCH', {
      action,
    });
  const available =
    snapshot?.directories.filter(
      (directory) =>
        !snapshot.connections.some(
          (connection) =>
            connection.directory === directory.directory &&
            connection.status !== 'disconnected',
        ),
    ) ?? [];
  return (
    <div className="flex flex-col gap-5">
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Folder connection needs attention</AlertTitle>
          <AlertDescription>
            {error}
            <Button variant="link" onClick={() => void load()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      <DemoLauncher />
      {!snapshot?.connections.length ? (
        <div className={styles.intro}>
          <div>
            <span className={styles.eyebrow}>
              A WORKSPACE BUILT FROM ITS SOURCES
            </span>
            <h2>From a folder to a full picture.</h2>
            <p>
              Connect a folder of emails, PDFs and investment updates. Aster
              collects new files, reads the originals and links the information
              to the right family.
            </p>
          </div>
          <div
            className={styles.flow}
            aria-label="Folder to processing to portfolio"
          >
            <span>
              <FolderOpen />
              Sources
            </span>
            <ArrowRight />
            <span>
              <Bot />
              Processing
            </span>
            <ArrowRight />
            <span>
              <FileText />
              Portfolio
            </span>
          </div>
        </div>
      ) : null}
      {!snapshot && !error ? <Skeleton className="h-48" /> : null}
      {snapshot && !snapshot.configured ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen />
            </EmptyMedia>
            <EmptyTitle>No intake folder configured</EmptyTitle>
            <EmptyDescription>
              Your administrator can add a local intake folder. You can also
              upload emails and PDFs directly in Processing.
            </EmptyDescription>
          </EmptyHeader>
          <Link
            className={buttonVariants({ variant: 'outline' })}
            href="?view=agents"
          >
            Open Processing
          </Link>
        </Empty>
      ) : null}
      {available.length ? (
        <div className={styles.folderGrid}>
          {available.map((directory) => (
            <Card key={directory.directory}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <FolderOpen aria-hidden="true" />
                  <Badge variant="outline">
                    {directory.isDemo ? 'Fictional families' : 'Local folder'}
                  </Badge>
                </div>
                <CardTitle>{directory.displayName}</CardTitle>
                <CardDescription>
                  {directory.isDemo
                    ? 'Emails, attachments, consolidated reports and short updates for several fictional families. These files go through the real processing engine.'
                    : 'Automatically collect supported documents as they arrive in this folder.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className={styles.folderPath}>{directory.directory}</p>
                <p className={styles.disclosure}>
                  Original files are retained with their extracted information.
                  Repeated scans do not create duplicate imports.
                </p>
              </CardContent>
              <CardFooter>
                <Button
                  disabled={!snapshot?.canManage || !!busy}
                  onClick={() => connect(directory)}
                >
                  <FolderSync data-icon="inline-start" />
                  {busy === directory.directory
                    ? 'Connecting…'
                    : 'Connect ' + directory.displayName}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : null}
      {snapshot?.configured &&
      !snapshot.connections.length &&
      !available.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No folders available</EmptyTitle>
            <EmptyDescription>
              Add a supported source folder to the configured intake location to
              connect it here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {snapshot?.connections.map((connection) => {
        const counts = connection.counts;
        const inProgress = counts.queued + counts.processing;
        const stats = [
          ['Source files', connection.importedCount],
          ['Queued', counts.queued],
          ['Processing', counts.processing],
          ['Accepted', counts.accepted],
          ['Needs review', counts.awaitingReview],
          ['Needs attention', counts.failed],
        ] as const;
        return (
          <Card key={connection.id}>
            <CardHeader>
              <div className={styles.folderHeading}>
                <div>
                  <CardTitle>{connection.displayName}</CardTitle>
                  <CardDescription>{connection.directory}</CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {connection.isDemo ? (
                    <Badge variant="outline">Demo sources</Badge>
                  ) : null}
                  <Badge
                    variant={connection.errorCode ? 'destructive' : 'secondary'}
                  >
                    {connection.status === 'paused'
                      ? 'Paused'
                      : connection.status === 'disconnected'
                        ? 'Disconnected'
                        : inProgress
                          ? 'Processing sources'
                          : 'Watching for files'}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <dl className={styles.folderStats}>
                {stats.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value.toLocaleString('en-GB')}</dd>
                  </div>
                ))}
              </dl>
              <div className={styles.folderMeta}>
                <span>Last scan · {stamp(connection.lastSyncedAt)}</span>
                <span>
                  {connection.uniqueDocumentCount} unique originals ·{' '}
                  {connection.duplicateCount} duplicate files ·{' '}
                  {connection.skippedCount} invalid or oversized files ·{' '}
                  {counts.rejected} rejected
                </span>
              </div>
              {connection.errorCode ? (
                <Alert variant="destructive">
                  <AlertTitle>The last scan needs attention</AlertTitle>
                  <AlertDescription>
                    Saved progress is retained. Retry the scan after the source
                    is available.<span>{connection.errorCode}</span>
                  </AlertDescription>
                </Alert>
              ) : null}
              {connection.recentFiles.length ? (
                <details className={styles.folderFiles}>
                  <summary>
                    Recent source files{' '}
                    <span>{connection.recentFiles.length}</span>
                  </summary>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Source file</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Imported</TableHead>
                        <TableHead>
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {connection.recentFiles.map((file, index) => (
                        <TableRow
                          key={
                            file.relativePath +
                            ':' +
                            file.importedAt +
                            ':' +
                            index
                          }
                        >
                          <TableCell>
                            <span className={styles.fileName}>
                              {file.filename}
                            </span>
                            <small className={styles.filePath}>
                              {file.relativePath}
                            </small>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                file.status === 'failed'
                                  ? 'destructive'
                                  : 'outline'
                              }
                            >
                              {labels[file.status ?? file.outcome] ??
                                file.status ??
                                file.outcome}
                            </Badge>
                          </TableCell>
                          <TableCell>{stamp(file.importedAt)}</TableCell>
                          <TableCell>
                            <div className="flex gap-2">
                              {file.documentId ? (
                                <Link
                                  href={
                                    '/api/documents/' +
                                    encodeURIComponent(file.documentId) +
                                    '/preview'
                                  }
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={buttonVariants({
                                    variant: 'ghost',
                                    size: 'sm',
                                  })}
                                >
                                  Original
                                </Link>
                              ) : null}
                              {file.jobId ? (
                                <Link
                                  href={
                                    '?view=agents&jobId=' +
                                    encodeURIComponent(file.jobId)
                                  }
                                  className={buttonVariants({
                                    variant: 'ghost',
                                    size: 'sm',
                                  })}
                                >
                                  View processing
                                </Link>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </details>
              ) : (
                <p className={styles.disclosure}>
                  Source files appear here after the first scan. The folder
                  worker runs in the background.
                </p>
              )}
            </CardContent>
            <CardFooter className="flex-wrap gap-2">
              {connection.currentUserCanManage ? (
                <>
                  {connection.status === 'active' ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!!busy}
                        onClick={() => update(connection, 'sync')}
                      >
                        <RefreshCw data-icon="inline-start" />
                        Rescan folder
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!!busy}
                        onClick={() => update(connection, 'pause')}
                      >
                        <Pause data-icon="inline-start" />
                        Pause
                      </Button>
                    </>
                  ) : null}
                  {connection.status === 'paused' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => update(connection, 'resume')}
                    >
                      <Play data-icon="inline-start" />
                      Resume scanning
                    </Button>
                  ) : null}
                  {connection.status === 'disconnected' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => connect(connection)}
                    >
                      <FolderSync data-icon="inline-start" />
                      Reconnect folder
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => setDisconnect(connection)}
                    >
                      <Unplug data-icon="inline-start" />
                      Disconnect
                    </Button>
                  )}
                  {connection.errorCode || counts.failed ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy || connection.status !== 'active'}
                      onClick={() => update(connection, 'retry')}
                    >
                      Retry failed imports
                    </Button>
                  ) : null}
                </>
              ) : null}
              <Link
                href="?view=agents"
                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
              >
                Open Processing
                <ArrowRight data-icon="inline-end" />
              </Link>
            </CardFooter>
          </Card>
        );
      })}
      <Dialog
        open={!!disconnect}
        onOpenChange={(open) => {
          if (!open) setDisconnect(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {disconnect?.displayName}?</DialogTitle>
            <DialogDescription>
              Aster will stop scanning this folder. Imported documents and their
              review history stay in the workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => setDisconnect(null)}
            >
              Keep connected
            </Button>
            <Button
              variant="destructive"
              disabled={!!busy}
              onClick={() => disconnect && update(disconnect, 'disconnect')}
            >
              Disconnect folder
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
