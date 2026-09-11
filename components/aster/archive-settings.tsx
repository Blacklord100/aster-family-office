'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Download,
  CheckCheck,
  FileCheck2,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  ArchiveCommand,
  ArchiveCommandResult,
  ArchiveDestination,
  ArchiveDocumentResponse,
  ArchiveReceipt,
  ArchiveRecord,
  ArchiveResponse,
  ArchiveStatus,
} from '@/lib/archive-contract';
import { ArchiveDirectorySchema } from '@/lib/archive-contract';
import {
  useWorkspaceRequest,
  WorkspaceRequestError,
} from './use-workspace-request';
import styles from './archive.module.css';

const statusLabels: Record<ArchiveStatus, string> = {
  queued: 'Queued',
  running: 'Copying',
  archived: 'Archived',
  failed: 'Copy failed',
};
const timestamp = (value: string) =>
  new Date(value).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const isAborted = (issue: unknown) =>
  issue instanceof DOMException && issue.name === 'AbortError';

/** Poll separately from extraction; a failed model run never hides its original's archive status. */
function useArchiveResource<T>(url: string) {
  const { request } = useWorkspaceRequest();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const epoch = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const version = epoch.current;
      try {
        const payload = await request<T>(url, { signal });
        if (!signal?.aborted && version === epoch.current) {
          setData(payload);
          setError('');
        }
      } catch (issue) {
        if (signal?.aborted || isAborted(issue)) return;
        if (
          issue instanceof WorkspaceRequestError &&
          [401, 403].includes(issue.status)
        ) {
          setData(null);
          setNotice('');
        }
        if (version === epoch.current)
          setError(
            issue instanceof Error
              ? issue.message
              : 'Could not load the archive.',
          );
      }
    },
    [request, url],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!document.hidden && !lock.current) await load(controller.signal);
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 8000);
    }
    void poll();
    return () => {
      controller.abort();
      epoch.current += 1;
      clearTimeout(timer);
    };
  }, [load]);
  async function run(command: ArchiveCommand, message: string) {
    if (lock.current) return null;
    lock.current = true;
    epoch.current += 1;
    setBusy(command.action);
    setError('');
    setNotice('');
    try {
      const result = await request<ArchiveCommandResult>('/api/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      });
      await load();
      setNotice(message);
      return result;
    } catch (issue) {
      if (isAborted(issue)) return null;
      if (
        issue instanceof WorkspaceRequestError &&
        [401, 403].includes(issue.status)
      ) {
        setData(null);
        setNotice('');
      }
      if (issue instanceof WorkspaceRequestError && issue.status === 409)
        await load();
      setError(
        issue instanceof Error
          ? issue.message
          : 'Could not update the archive.',
      );
      return null;
    } finally {
      lock.current = false;
      setBusy('');
    }
  }
  async function download(url: string, filename: string) {
    if (lock.current) return;
    lock.current = true;
    epoch.current += 1;
    setBusy('download');
    setError('');
    setNotice('');
    try {
      const bytes = await request<Blob>(url, {}, 'blob');
      const objectUrl = URL.createObjectURL(bytes);
      try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.click();
        setNotice('Download prepared: ' + filename);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (issue) {
      if (isAborted(issue)) return;
      if (
        issue instanceof WorkspaceRequestError &&
        [401, 403].includes(issue.status)
      ) {
        setData(null);
        setNotice('');
      }
      setError(
        issue instanceof Error
          ? issue.message
          : 'Could not download the archived file.',
      );
    } finally {
      lock.current = false;
      setBusy('');
    }
  }
  return { data, error, busy, notice, load, run, download };
}

function ArchiveBadge({ status }: { status: ArchiveStatus }) {
  return (
    <Badge variant={status === 'failed' ? 'destructive' : 'outline'}>
      {status === 'running' ? (
        <Loader2 className="animate-spin" />
      ) : status === 'archived' ? (
        <CheckCheck />
      ) : null}
      {statusLabels[status]}
    </Badge>
  );
}

function ReceiptDetails({
  receipt,
  directory,
  onDownload,
  busy,
}: {
  receipt: ArchiveReceipt;
  directory: string | null;
  onDownload?: (index: number) => void;
  busy: boolean;
}) {
  return (
    <div className={styles.details}>
      <div>
        <p className={styles.muted}>
          {directory
            ? 'Bundle location relative to this office’s archive root'
            : 'Bundle path within its recorded destination'}
        </p>
        <code className={styles.path}>
          {directory ? directory + '/' : ''}
          {receipt.relativePath}
        </code>
      </div>
      <p className={styles.muted}>
        Copied {timestamp(receipt.archivedAt)}. Files are stored on the Aster
        server.
      </p>
      {receipt.warnings.length ? (
        <Alert>
          <AlertTitle>Archive notes</AlertTitle>
          <AlertDescription>
            {receipt.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
      <details className={styles.details}>
        <summary>
          Files and integrity references ({receipt.files.length})
        </summary>
        <div className={styles.artifacts}>
          {receipt.files.map((file, index) => (
            <div className={styles.artifact} key={file.path}>
              <div className={styles.row}>
                <p>{file.path}</p>
                {onDownload ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={'Download ' + file.path}
                    onClick={() => onDownload(index)}
                  >
                    <Download data-icon="inline-start" />
                    Download
                  </Button>
                ) : null}
              </div>
              <p className={styles.muted}>
                {file.mimeType} · {file.byteSize.toLocaleString()} bytes
              </p>
              <code>SHA-256 {file.sha256}</code>
            </div>
          ))}
          <div className={styles.artifact}>
            <p>Manifest SHA-256</p>
            <code>{receipt.manifestSha256}</code>
          </div>
          <div className={styles.artifact}>
            <p>Original SHA-256</p>
            <code>{receipt.originalSha256}</code>
          </div>
        </div>
      </details>
    </div>
  );
}

function DestinationForm({
  destination,
  busy,
  onSave,
  onTest,
}: {
  destination: ArchiveDestination | null;
  busy: string;
  onSave: (label: string, directory: string) => Promise<boolean>;
  onTest: (directory: string) => Promise<ArchiveCommandResult | null>;
}) {
  const [label, setLabel] = useState(
    destination?.label ?? 'Office document archive',
  );
  const [directory, setDirectory] = useState(
    destination?.directory ?? 'originals',
  );
  const [validation, setValidation] = useState('');
  const [tested, setTested] = useState<{
    directory: string;
    checkedAt: string;
  } | null>(null);
  const dirty =
    label.trim() !== destination?.label ||
    directory.trim() !== destination?.directory;
  const validDirectory = () => {
    const result = ArchiveDirectorySchema.safeParse(directory);
    if (!result.success) {
      setValidation(
        result.error.issues[0]?.message ?? 'Choose a relative folder name.',
      );
      return null;
    }
    setValidation('');
    return result.data;
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const path = validDirectory();
        if (path && label.trim()) void onSave(label.trim(), path);
      }}
    >
      <FieldGroup>
        <div className={styles.fields}>
          <Field data-disabled={!!busy}>
            <FieldLabel htmlFor="archive-label">Destination name</FieldLabel>
            <Input
              id="archive-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={100}
              required
              disabled={!!busy}
            />
          </Field>
          <Field data-disabled={!!busy} data-invalid={!!validation}>
            <FieldLabel htmlFor="archive-directory">
              Folder within this office’s archive root
            </FieldLabel>
            <Input
              id="archive-directory"
              value={directory}
              onChange={(event) => {
                setDirectory(event.target.value);
                setTested(null);
                setValidation('');
              }}
              maxLength={240}
              required
              disabled={!!busy}
              aria-invalid={!!validation}
              aria-describedby="archive-directory-description"
              placeholder="originals"
            />
            <FieldDescription id="archive-directory-description">
              Use a relative folder such as originals or records/2026. This is a
              folder on the server, not your browser’s Downloads folder.
            </FieldDescription>
            {validation ? (
              <p role="alert" className="text-sm text-destructive">
                {validation}
              </p>
            ) : null}
          </Field>
        </div>
        <div className={styles.actions}>
          <Button
            type="button"
            variant="outline"
            disabled={!!busy || !directory.trim()}
            onClick={() => {
              const path = validDirectory();
              if (path)
                void onTest(path).then((result) => {
                  if (result?.checkedAt)
                    setTested({ directory: path, checkedAt: result.checkedAt });
                });
            }}
          >
            <FileCheck2 data-icon="inline-start" />
            {busy === 'test' ? 'Testing…' : 'Test folder'}
          </Button>
          <Button
            type="submit"
            disabled={!!busy || !dirty || !label.trim() || !directory.trim()}
          >
            {busy === 'configure'
              ? 'Saving…'
              : destination
                ? 'Save destination'
                : 'Save & enable archive'}
          </Button>
          {tested?.directory === directory.trim() ? (
            <output className={styles.muted}>
              Folder test passed · {timestamp(tested.checkedAt)}
            </output>
          ) : null}
        </div>
        {destination && directory.trim() !== destination.directory ? (
          <p className={styles.muted}>
            A new destination keeps previous archive receipts. Use Archive
            existing originals afterward to copy earlier documents into the new
            destination.
          </p>
        ) : null}
      </FieldGroup>
    </form>
  );
}

export function ArchiveSettings() {
  const { key } = useWorkspaceRequest();
  return <ScopedArchiveSettings key={key} />;
}
function ScopedArchiveSettings() {
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('all');
  const archive = useArchiveResource<ArchiveResponse>(
    '/api/archive?offset=' +
      offset +
      (status === 'all' ? '' : '&status=' + status),
  );
  const { data, busy, error } = archive;
  const [selected, setSelected] = useState<string | null>(null);
  const destination = data?.destination;
  const revision = destination?.revision ?? 0;
  const write = () => ({
    expectedRevision: revision,
    idempotencyKey: crypto.randomUUID(),
  });
  const selectedRecord = data?.records.find((record) => record.id === selected);
  const canManage = Boolean(data?.canManage && data.configured && !error);
  return (
    <section
      className={styles.workspace}
      aria-label="Original document archive"
    >
      <div className={styles.intro}>
        <span className={styles.mark}>
          <Archive />
        </span>
        <div>
          <h2>Your originals, kept together.</h2>
          <p>
            Retain a copy of every imported source independently of extraction.
            Email bundles include the original email, available attachments, a
            readable email snapshot and a manifest with source hashes.
          </p>
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Archive needs attention</AlertTitle>
          <AlertDescription>
            {error}
            <Button variant="link" onClick={() => void archive.load()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {archive.notice ? (
        <Alert aria-live="polite">
          <AlertDescription>{archive.notice}</AlertDescription>
        </Alert>
      ) : null}
      {!data && !error ? <Skeleton className="h-52 w-full" /> : null}
      {data ? (
        <>
          {!data.configured ? (
            <Alert>
              <FolderOpen />
              <AlertTitle>Server archive folder is not configured</AlertTitle>
              <AlertDescription>
                Your installation administrator must configure
                ASTER_ARCHIVE_ROOT and its storage permissions. Then choose this
                office’s destination here.
              </AlertDescription>
            </Alert>
          ) : null}
          <Card>
            <CardHeader>
              <div className={styles.row}>
                <CardTitle>
                  <h3>Archive destination</h3>
                </CardTitle>
                <Badge variant="outline">
                  {destination
                    ? destination.enabled
                      ? 'Enabled'
                      : 'Paused'
                    : 'Not set up'}
                </Badge>
              </div>
              <CardDescription>
                One local destination for this office. Imported originals stay
                in Aster as well.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div>
                <p className={styles.muted}>Office archive root</p>
                <code className={styles.path}>{data.rootLabel}</code>
              </div>
              {canManage ? (
                <DestinationForm
                  key={revision}
                  destination={destination ?? null}
                  busy={busy}
                  onTest={(directory) =>
                    archive.run(
                      { action: 'test', directory },
                      'The server checked the destination folder.',
                    )
                  }
                  onSave={async (label, directory) =>
                    Boolean(
                      await archive.run(
                        {
                          action: 'configure',
                          ...write(),
                          destination: {
                            provider: 'local',
                            label,
                            directory,
                            enabled: destination?.enabled ?? true,
                          },
                        },
                        'Archive destination saved.',
                      ),
                    )
                  }
                />
              ) : destination ? (
                <div>
                  <p>{destination.label}</p>
                  <code className={styles.path}>{destination.directory}</code>
                </div>
              ) : (
                <p className={styles.muted}>
                  An office owner or administrator can configure the archive.
                </p>
              )}
              <p className={styles.muted}>
                Archive files can be opened outside Aster; the destination’s
                file permissions control access. A server folder can be
                synchronized by Dropbox if your administrator sets that up on
                the host. Aster writes locally; cloud synchronization is managed
                separately.
              </p>
              {destination ? (
                <div className={styles.row}>
                  <p className={styles.muted}>
                    {destination.enabled
                      ? `Automatic archiving starts from ${timestamp(destination.automaticFrom)}.`
                      : 'New archive work is paused. Previously saved copies remain in the destination.'}
                  </p>
                  {canManage ? (
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      onClick={() =>
                        void archive.run(
                          {
                            action: 'configure',
                            ...write(),
                            destination: {
                              provider: 'local',
                              label: destination.label,
                              directory: destination.directory,
                              enabled: !destination.enabled,
                            },
                          },
                          destination.enabled
                            ? 'Archiving paused. Existing copies are retained.'
                            : 'Archiving enabled.',
                        )
                      }
                    >
                      {destination.enabled ? (
                        <Pause data-icon="inline-start" />
                      ) : (
                        <Play data-icon="inline-start" />
                      )}
                      {destination.enabled ? 'Pause archive' : 'Enable archive'}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
          <dl className={styles.stats} aria-label="Archive totals">
            <div>
              <dt>Queued & copying</dt>
              <dd>
                {(data.counts.queued + data.counts.running).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>Archived</dt>
              <dd>{data.counts.archived.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Failed copies</dt>
              <dd>{data.counts.failed.toLocaleString()}</dd>
            </div>
          </dl>
          <Card>
            <CardHeader>
              <div className={styles.row}>
                <div>
                  <CardTitle>
                    <h3>Archive activity</h3>
                  </CardTitle>
                  <CardDescription>
                    {data.eligibleUnqueued.toLocaleString()} originals not yet
                    queued for this destination.
                  </CardDescription>
                  {data.configured ? (
                    <p
                      className={styles.muted}
                      aria-label="Archive worker health"
                    >
                      Archive worker ·{' '}
                      {data.workerStatus === 'healthy'
                        ? 'Healthy'
                        : data.workerStatus === 'stale'
                          ? 'Heartbeat overdue'
                          : 'Signal unavailable'}
                      {data.workerHeartbeatAt
                        ? ` · Last signal ${timestamp(data.workerHeartbeatAt)}`
                        : ''}
                      {data.workerStatus !== 'healthy'
                        ? ' · Ask the installation operator to check or restart the archive worker.'
                        : ''}
                    </p>
                  ) : null}
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => void archive.load()}
                  >
                    <RefreshCw data-icon="inline-start" />
                    Refresh archive
                  </Button>
                  {canManage && destination ? (
                    <Button
                      variant="outline"
                      disabled={
                        !!busy ||
                        !destination.enabled ||
                        data.eligibleUnqueued === 0
                      }
                      onClick={() =>
                        void archive.run(
                          { action: 'backfill', ...write() },
                          'Existing originals queued for archiving. Progress updates automatically.',
                        )
                      }
                    >
                      <Archive data-icon="inline-start" />
                      Archive existing originals
                    </Button>
                  ) : null}
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Field orientation="horizontal" className="w-fit">
                <FieldLabel htmlFor="archive-status-filter">
                  Archive status
                </FieldLabel>
                <NativeSelect
                  id="archive-status-filter"
                  value={status}
                  disabled={!!busy}
                  onChange={(event) => {
                    setStatus(event.target.value);
                    setOffset(0);
                    setSelected(null);
                  }}
                >
                  <NativeSelectOption value="all">
                    All statuses
                  </NativeSelectOption>
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <NativeSelectOption key={value} value={value}>
                      {label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              {!data.records.length ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Archive />
                    </EmptyMedia>
                    <EmptyTitle>
                      {status !== 'all'
                        ? 'No records with this status'
                        : offset
                          ? 'No more archive records'
                          : 'No originals archived yet'}
                    </EmptyTitle>
                    <EmptyDescription>
                      {status !== 'all'
                        ? 'Choose another status to inspect the rest of the archive.'
                        : destination
                          ? destination.enabled
                            ? 'New imports are archived automatically. Queue existing originals to include earlier documents.'
                            : 'Enable the archive to begin copying originals.'
                          : 'Choose a destination to begin retaining copies outside Aster.'}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <Table className={styles.table}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Original source</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last update</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.records.map((record) => (
                      <TableRow key={record.id}>
                        <TableCell>
                          <span className={styles.filename}>
                            {record.filename}
                          </span>
                          <span className={styles.muted}>
                            Destination version {record.destinationRevision} ·{' '}
                            {record.attempts}{' '}
                            {record.attempts === 1 ? 'attempt' : 'attempts'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <ArchiveBadge status={record.status} />
                          {record.lastVerification?.ok === false ? (
                            <Badge variant="destructive">
                              Integrity check failed
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>{timestamp(record.updatedAt)}</TableCell>
                        <TableCell>
                          <div className={styles.actions}>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-expanded={selected === record.id}
                              onClick={() => {
                                setSelected(
                                  selected === record.id ? null : record.id,
                                );
                              }}
                            >
                              Details
                            </Button>
                            {canManage &&
                            record.status === 'failed' &&
                            record.destinationRevision ===
                              destination?.archiveRevision ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!!busy || !destination?.enabled}
                                onClick={() =>
                                  void archive.run(
                                    {
                                      action: 'retry',
                                      ...write(),
                                      jobId: record.id,
                                    },
                                    'Archive retry queued.',
                                  )
                                }
                              >
                                <RefreshCw data-icon="inline-start" />
                                Retry
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {selectedRecord ? (
                <div className={styles.document}>
                  <div className={styles.row}>
                    <h3>
                      <Archive />
                      {selectedRecord.filename}
                    </h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelected(null)}
                    >
                      Close details
                    </Button>
                  </div>
                  <RecordDetails
                    record={selectedRecord}
                    busy={!!busy}
                    onDownload={
                      selectedRecord.canDownload
                        ? (index) =>
                            void archive.download(
                              '/api/archive/records/' +
                                selectedRecord.id +
                                '/files/' +
                                index,
                              selectedRecord
                                .receipt!.files[index].path.split('/')
                                .at(-1) || 'archive-file',
                            )
                        : undefined
                    }
                  />
                  <div className={styles.actions}>
                    {selectedRecord.sourceRetained ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!!busy}
                        onClick={() =>
                          void archive.download(
                            '/api/documents/' +
                              encodeURIComponent(selectedRecord.documentId),
                            selectedRecord.filename,
                          )
                        }
                      >
                        Download original
                      </Button>
                    ) : (
                      <p className={styles.muted}>
                        The imported original is no longer retained in Aster.
                        Its archive receipt remains available.
                      </p>
                    )}
                    {canManage && selectedRecord.receipt ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          void archive.run(
                            { action: 'verify', jobId: selectedRecord.id },
                            'Archive integrity check completed.',
                          )
                        }
                      >
                        <FileCheck2 data-icon="inline-start" />
                        Verify saved files
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className={styles.row}>
                <p className={styles.muted}>
                  {data.records.length
                    ? `Showing ${offset + 1}–${offset + data.records.length}.`
                    : ''}{' '}
                  Archive status is separate from financial review.
                </p>
                <div className={styles.actions}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy || offset === 0}
                    onClick={() => {
                      setSelected(null);
                      setOffset(Math.max(0, offset - 50));
                    }}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy || !data.hasMore}
                    onClick={() => {
                      setSelected(null);
                      setOffset(offset + 50);
                    }}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </section>
  );
}

function RecordDetails({
  record,
  busy = false,
  onDownload,
}: {
  record: ArchiveRecord;
  busy?: boolean;
  onDownload?: (index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3 py-3">
      {record.receipt ? (
        <ReceiptDetails
          receipt={record.receipt}
          directory={record.destinationDirectory}
          busy={busy}
          onDownload={onDownload}
        />
      ) : (
        <p className={styles.muted}>
          {record.status === 'archived'
            ? 'This original is archived. Saved file locations are available to authorized office users.'
            : record.errorCode === 'DESTINATION_CHANGED'
              ? 'This archive attempt belongs to an earlier destination. Use Archive existing originals in settings to copy the source into the current destination.'
              : record.status === 'failed'
                ? 'The archive copy did not complete. Check the destination and retry; the imported original remains in Aster.'
                : 'The archive worker will copy the retained original and record its location here.'}
        </p>
      )}
      {record.errorCode ? (
        <p className={styles.muted}>Archive error: {record.errorCode}</p>
      ) : null}
      {record.lastVerification ? (
        <Verification result={record.lastVerification} />
      ) : null}
    </div>
  );
}
function Verification({
  result,
}: {
  result: { checkedAt: string; issues: string[] };
}) {
  return (
    <Alert
      variant={result.issues.length ? 'destructive' : 'default'}
      aria-live="polite"
      className="mt-3"
    >
      <AlertTitle>
        {result.issues.length
          ? 'Saved files need attention'
          : 'Saved files verified'}
      </AlertTitle>
      <AlertDescription>
        {result.issues.length ? (
          result.issues.map((issue, index) => <p key={index}>{issue}</p>)
        ) : (
          <p>
            Manifest and file hashes matched at {timestamp(result.checkedAt)}.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function DocumentArchiveStatus({ documentId }: { documentId: string }) {
  const { key } = useWorkspaceRequest();
  return (
    <ScopedDocumentArchiveStatus
      key={key + documentId}
      documentId={documentId}
    />
  );
}
function ScopedDocumentArchiveStatus({ documentId }: { documentId: string }) {
  const archive = useArchiveResource<ArchiveDocumentResponse>(
    '/api/archive/documents/' + encodeURIComponent(documentId),
  );
  const { data, error, busy } = archive;
  return (
    <section className={styles.document} aria-label="Original archive status">
      <div className={styles.row}>
        <h3>
          <Archive />
          Original archive
        </h3>
        {data?.records[0] ? (
          <ArchiveBadge status={data.records[0].status} />
        ) : null}
      </div>
      {error ? (
        <p role="alert" className={styles.muted}>
          {error}{' '}
          <Button variant="link" size="sm" onClick={() => void archive.load()}>
            Retry status
          </Button>
        </p>
      ) : !data ? (
        <p className={styles.muted}>Checking archive status…</p>
      ) : data.records.length ? (
        <details className={styles.details}>
          <summary>
            View saved locations and archive history ({data.records.length})
          </summary>
          {data.records.map((record) => (
            <div key={record.id}>
              <div className={styles.row}>
                <span className={styles.muted}>
                  Destination version {record.destinationRevision}
                </span>
                <ArchiveBadge status={record.status} />
              </div>
              <RecordDetails
                record={record}
                busy={!!busy}
                onDownload={
                  record.canDownload
                    ? (index) =>
                        void archive.download(
                          '/api/archive/records/' +
                            record.id +
                            '/files/' +
                            index,
                          record.receipt!.files[index].path.split('/').at(-1) ||
                            'archive-file',
                        )
                    : undefined
                }
              />
              {data.canManage &&
              record.status === 'failed' &&
              record.errorCode !== 'DESTINATION_CHANGED' ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy || !data.destinationEnabled}
                  onClick={() =>
                    void archive.run(
                      {
                        action: 'retry',
                        expectedRevision: data.destinationRevision ?? 0,
                        idempotencyKey: crypto.randomUUID(),
                        jobId: record.id,
                      },
                      'Archive retry queued.',
                    )
                  }
                >
                  <RefreshCw data-icon="inline-start" />
                  Retry archive
                </Button>
              ) : null}
            </div>
          ))}
        </details>
      ) : (
        <p className={styles.muted}>
          {!data.configured
            ? 'Archive storage is not configured for this installation.'
            : !data.destinationEnabled
              ? 'This office’s archive is not enabled.'
              : 'This original has not been queued for archiving yet.'}
        </p>
      )}
      {archive.notice ? (
        <output className={styles.muted}>{archive.notice}</output>
      ) : null}
      {data?.canManage ? (
        <Link
          className={buttonVariants({ variant: 'link', size: 'sm' })}
          href="/?view=connections&tab=archive"
        >
          Archive settings
        </Link>
      ) : null}
    </section>
  );
}
