'use client';

import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import {
  AlertCircle,
  ArrowDownToLine,
  Bot,
  Check,
  CheckCheck,
  Cloud,
  FileSearch,
  FileText,
  GitBranch,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ReviewWorkbench } from './review-workbench';
import type { ReviewDecision, ReviewState } from '@/lib/review-contract';
import type { Holding } from '@/data/types';
import type {
  ProcessingJob,
  ProcessingMode,
  ProcessingPolicy,
  WorkspaceIdentity,
} from '@/lib/processing-contract';
import { PageHeading, Panel, Status } from './primitives';
import { useWorkspace } from './workspace-context';

type ProcessingResponse = {
  jobs: ProcessingJob[];
  policy: ProcessingPolicy;
  role: WorkspaceIdentity['role'];
};
type ReviewSelection = ReviewDecision;
type JobAction = 'review' | 'reject' | 'retry' | 'cancel';
type ReviewResponse = {
  ok: boolean;
  status: string;
  applied: number;
  duplicates: number;
  review?: ReviewState;
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const statusLabels: Record<string, string> = {
  queued: 'Queued',
  processing: 'Processing',
  awaiting_review: 'Needs review',
  accepted: 'Accepted',
  failed: 'Failed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};
const modeName = (mode: ProcessingMode) =>
  mode === 'agentic' ? 'Agentic' : 'Classical workflow';
const isActive = (job: ProcessingJob) =>
  job.status === 'queued' || job.status === 'processing';

function statusTone(status: string) {
  if (status === 'accepted') return 'success';
  if (status === 'awaiting_review' || status === 'failed') return 'warning';
  if (status === 'processing') return 'violet';
  return 'neutral';
}
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : date.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}
class ProcessingRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function requestJson<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      'message' in payload &&
      typeof payload.message === 'string'
        ? payload.message
        : 'The request could not be completed. Please try again.';
    throw new ProcessingRequestError(message, response.status);
  }
  if (payload === null)
    throw new Error('Aster returned an empty response. Please refresh.');
  return payload as T;
}
function errorMessage(error: unknown) {
  return error instanceof ProcessingRequestError
    ? error.message
    : 'Aster could not connect. Check your connection and try again.';
}

export function ProcessingView({
  initialJobId = null,
}: { initialJobId?: string | null } = {}) {
  const { data, reload } = useWorkspace();
  const [snapshot, setSnapshot] = useState<ProcessingResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialJobId);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mutationLock = useRef(false);
  const responseEpoch = useRef(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function poll() {
      if (disposed) return;
      if (mutationLock.current) {
        timer = setTimeout(() => void poll(), 1000);
        return;
      }
      const epoch = responseEpoch.current;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 20_000);
      setRefreshing(true);
      let delay = 15_000;
      try {
        const result = await requestJson<ProcessingResponse>(
          '/api/processing' +
            (selectedId ? '?jobId=' + encodeURIComponent(selectedId) : ''),
          { signal: controller.signal },
        );
        if (
          !Array.isArray(result.jobs) ||
          !result.policy ||
          !['workflow', 'agentic'].includes(result.policy.mode)
        ) {
          throw new Error('Invalid processing response');
        }
        if (!disposed && epoch === responseEpoch.current) {
          setSnapshot(result);
          setLoadError(null);
          delay = result.jobs.some(isActive) ? 5000 : 15_000;
        }
      } catch (error) {
        if (!disposed && epoch === responseEpoch.current) {
          setLoadError(errorMessage(error));
          if (
            error instanceof ProcessingRequestError &&
            [401, 403].includes(error.status)
          )
            setSnapshot(null);
        }
      } finally {
        clearTimeout(timeout);
        if (!disposed) {
          setLoading(false);
          setRefreshing(false);
          timer = setTimeout(() => void poll(), delay);
        }
      }
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [refreshKey, selectedId]);

  async function mutate<T>(
    key: string,
    run: () => Promise<T>,
    done: (result: T) => void,
  ) {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    responseEpoch.current += 1;
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      done(await run());
      return true;
    } catch (error) {
      setActionError(errorMessage(error));
      if (
        error instanceof ProcessingRequestError &&
        [401, 403].includes(error.status)
      )
        setSnapshot(null);
      return false;
    } finally {
      mutationLock.current = false;
      setBusy(null);
      setRefreshKey((current) => current + 1);
    }
  }

  const jobs = snapshot?.jobs ?? [];
  const selected = jobs.find((job) => job.id === selectedId) ?? jobs[0];
  const canWrite = !!snapshot && snapshot.role !== 'viewer';
  const canManage = snapshot?.role === 'owner' || snapshot?.role === 'admin';
  const queuedCount = jobs.filter(isActive).length;
  const reviewCount = jobs.filter(
    (job) => job.status === 'awaiting_review',
  ).length;

  function chooseFile(next: File | null) {
    setFileError(null);
    if (
      next &&
      (!/\.(pdf|txt|eml)$/i.test(next.name) ||
        next.size < 1 ||
        next.size > MAX_FILE_BYTES)
    ) {
      setFile(null);
      setFileError('Choose a non-empty PDF, TXT or EML file of 10 MB or less.');
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setFile(next);
  }
  function upload(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !snapshot || !canWrite) return;
    const body = new FormData();
    body.append('file', file);
    body.append('mode', snapshot.policy.mode);
    void mutate(
      'upload',
      () =>
        requestJson<{ jobId: string; deduplicated: boolean }>(
          '/api/documents',
          {
            method: 'POST',
            body,
          },
        ),
      (result) => {
        setSelectedId(result.jobId);
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
        setNotice(
          result.deduplicated
            ? 'Document recognized. Its processing job is available below.'
            : 'Document queued. You can review its results here when processing finishes.',
        );
      },
    );
  }
  function changeMode(mode: ProcessingMode) {
    if (!canManage || !snapshot || mode === snapshot.policy.mode) return;
    void mutate(
      'policy',
      () =>
        requestJson<ProcessingPolicy>('/api/processing', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        }),
      (policy) => {
        setSnapshot((current) => (current ? { ...current, policy } : current));
        setNotice(
          modeName(policy.mode) + ' is now the default for new uploads.',
        );
      },
    );
  }
  async function reviewJob(
    job: ProcessingJob,
    action: JobAction,
    selections?: ReviewSelection[],
    expectedRevision?: number,
  ) {
    if (!canWrite) return false;
    return mutate(
      job.id,
      () =>
        requestJson<ReviewResponse>(
          '/api/processing/' + encodeURIComponent(job.id),
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              action === 'review'
                ? {
                    action,
                    decisions: selections,
                    expectedRevision:
                      expectedRevision ?? job.review?.revision ?? 0,
                  }
                : { action },
            ),
          },
        ),
      (result) => {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                jobs: current.jobs.map((item) =>
                  item.id === job.id
                    ? {
                        ...item,
                        status: result.status,
                        review: result.review ?? item.review,
                        errorCode: null,
                        updatedAt: new Date().toISOString(),
                      }
                    : item,
                ),
              }
            : current,
        );
        if (action === 'review') {
          setNotice(
            'Review decision saved. ' +
              (result.applied
                ? result.applied +
                  (result.applied === 1
                    ? ' fact applied. '
                    : ' facts applied. ')
                : '') +
              (result.duplicates
                ? result.duplicates + ' already recorded. '
                : '') +
              'Other facts remain unchanged.',
          );
          reload();
        } else {
          setNotice(
            action === 'retry'
              ? job.engine
                ? 'Job queued again using its recorded processing mode and engine.'
                : 'Legacy job queued in its original mode. The deployment-local engine will be recorded when the worker claims it.'
              : action === 'cancel'
                ? 'Job cancelled. Its document remains available.'
                : 'Document review rejected. No extracted facts were applied.',
          );
        }
      },
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading
        title="Document processing"
        subtitle="Turn statements and correspondence into source-linked updates."
      >
        <Status
          tone={snapshot?.policy.execution === 'cloud' ? 'warning' : 'success'}
        >
          {snapshot?.policy.execution === 'cloud' ? <Cloud /> : <ShieldCheck />}
          {snapshot
            ? snapshot.policy.execution === 'cloud'
              ? 'Cloud selected'
              : 'Local selected'
            : 'Loading policy'}
        </Status>
        {snapshot?.role === 'viewer' ? <Status>View only</Status> : null}
        <Button
          variant="outline"
          disabled={!!busy || refreshing}
          onClick={() => setRefreshKey((value) => value + 1)}
        >
          <RefreshCw
            data-icon="inline-start"
            className={cn(refreshing && 'animate-spin')}
          />
          Refresh
        </Button>
      </PageHeading>

      {loadError || actionError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>
            {actionError
              ? 'Action could not be completed'
              : 'Processing status is unavailable'}
          </AlertTitle>
          <AlertDescription>
            {actionError || loadError}
            {loadError && snapshot
              ? ' The last loaded results are still shown below.'
              : ''}
          </AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert aria-live="polite">
          <Check />
          <AlertTitle>Workspace updated</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <Panel
          title="Processing mode"
          subtitle="One evidence standard. Two ways to read your documents."
        >
          <div className="flex flex-col gap-4 py-3">
            {loading ? (
              <Skeleton className="h-9 w-72 max-w-full" />
            ) : (
              <ToggleGroup
                aria-label="Default processing mode"
                value={snapshot ? [snapshot.policy.mode] : []}
                onValueChange={(values) => {
                  const value = values[0];
                  if (value === 'workflow' || value === 'agentic')
                    changeMode(value);
                }}
                variant="outline"
                disabled={!canManage || !!busy}
              >
                <ToggleGroupItem
                  value="workflow"
                  aria-label="Classical workflow"
                >
                  <GitBranch data-icon="inline-start" /> Classical workflow
                </ToggleGroupItem>
                <ToggleGroupItem value="agentic" aria-label="Agentic">
                  <Bot data-icon="inline-start" /> Agentic
                </ToggleGroupItem>
              </ToggleGroup>
            )}
            <p className="text-sm leading-relaxed text-muted-foreground">
              {snapshot?.policy.mode === 'agentic'
                ? 'Your selected model examines the document through bounded extraction steps.'
                : 'Fixed stages classify and parse the document, with model extraction for unresolved fields.'}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <LockKeyhole className="size-3.5" /> No automatic provider
                fallback
              </span>
              {snapshot ? (
                <span>Policy revision {snapshot.policy.revision}</span>
              ) : null}
              {busy === 'policy' ? <output>Saving mode…</output> : null}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Changes apply to new uploads. Existing jobs keep their recorded
              mode and engine. Choose a model in AI engines.
              {snapshot && !canManage
                ? ' A workspace owner or admin can change the default.'
                : ''}
            </p>
            {snapshot?.policy.engine ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                New documents use {snapshot.policy.engine.model}.
                {snapshot.policy.execution === 'cloud'
                  ? ' Document content will be sent to the selected cloud provider.'
                  : ' Inference runs on the configured local runtime.'}
              </p>
            ) : null}
          </div>
        </Panel>
        <Panel
          title="Add a source document"
          subtitle="Statements, fund notices and email correspondence."
        >
          <form onSubmit={upload} className="py-3">
            <FieldGroup>
              <Field
                data-invalid={!!fileError}
                data-disabled={!canWrite || !!busy}
              >
                <FieldLabel htmlFor="processing-document">Document</FieldLabel>
                <Input
                  ref={fileInput}
                  id="processing-document"
                  type="file"
                  accept=".pdf,.txt,.eml,application/pdf,text/plain,message/rfc822"
                  disabled={!canWrite || !!busy}
                  aria-invalid={!!fileError}
                  aria-describedby="processing-file-help"
                  onChange={(event) =>
                    chooseFile(event.target.files?.[0] ?? null)
                  }
                />
                <FieldDescription id="processing-file-help">
                  PDF, TXT or EML · Up to 10 MB per file
                </FieldDescription>
                {fileError ? <FieldError>{fileError}</FieldError> : null}
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {file
                    ? file.name +
                      ' · ' +
                      (file.size < 1024 * 1024
                        ? Math.max(1, Math.round(file.size / 1024)) + ' KB'
                        : (file.size / 1024 / 1024).toFixed(1) + ' MB')
                    : canWrite
                      ? 'The original and extracted results are stored encrypted.'
                      : 'Upload access requires an analyst, admin or owner role.'}
                </p>
                {file ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove selected document"
                    disabled={!!busy}
                    onClick={() => {
                      chooseFile(null);
                      if (fileInput.current) fileInput.current.value = '';
                    }}
                  >
                    <X />
                  </Button>
                ) : null}
                <Button type="submit" disabled={!file || !canWrite || !!busy}>
                  {busy === 'upload' ? (
                    <Loader2
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : (
                    <Upload data-icon="inline-start" />
                  )}
                  {busy === 'upload' ? 'Uploading…' : 'Upload & process'}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </Panel>
      </div>

      <section
        className="flex min-w-0 flex-col gap-3"
        aria-labelledby="processing-jobs-title"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 id="processing-jobs-title" className="text-base font-medium">
              Processing queue
            </h2>
            {reviewCount ? (
              <Status tone="warning">{reviewCount} to review</Status>
            ) : null}
            {queuedCount ? (
              <Status tone="violet">{queuedCount} in progress</Status>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {loading
              ? 'Loading documents…'
              : jobs.length +
                ' recent ' +
                (jobs.length === 1 ? 'job' : 'jobs') +
                ' · Updates automatically'}
          </p>
        </div>
        <div className="grid min-w-0 overflow-hidden rounded-lg border border-border bg-background lg:grid-cols-[minmax(230px,0.72fr)_minmax(0,1.6fr)]">
          <div className="min-w-0 border-b border-border lg:border-r lg:border-b-0">
            {loading ? (
              <div
                className="flex flex-col gap-5 p-5"
                aria-label="Loading processing jobs"
              >
                {[0, 1, 2].map((index) => (
                  <div className="flex flex-col gap-3" key={index}>
                    <Skeleton className="h-4 w-4/5" />
                    <Skeleton className="h-3 w-3/5" />
                    <Skeleton className="h-5 w-24" />
                  </div>
                ))}
              </div>
            ) : jobs.length ? (
              <div
                className="max-h-[620px] overflow-y-auto lg:max-h-[900px]"
                aria-label="Recent processing jobs"
              >
                {jobs.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    aria-pressed={selected?.id === job.id}
                    onClick={() => setSelectedId(job.id)}
                    className={cn(
                      'flex w-full min-w-0 flex-col gap-3 border-b border-border px-5 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]',
                      selected?.id === job.id &&
                        'bg-accent/50 shadow-[inset_3px_0_0_var(--primary)]',
                    )}
                  >
                    <div className="flex min-w-0 items-start gap-2.5">
                      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 break-words text-sm font-medium">
                        {job.filename}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Status tone={statusTone(job.status)}>
                        {statusLabels[job.status] ?? job.status}
                      </Status>
                      <span className="text-xs text-muted-foreground">
                        {modeName(job.mode)}
                      </span>
                    </div>
                    <time
                      dateTime={job.createdAt}
                      className="text-xs text-muted-foreground"
                    >
                      {timestamp(job.createdAt)}
                    </time>
                  </button>
                ))}
              </div>
            ) : (
              <Empty className="min-h-64">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileText />
                  </EmptyMedia>
                  <EmptyTitle>No documents yet</EmptyTitle>
                  <EmptyDescription>
                    Upload your first statement or email to begin.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
          <div className="min-w-0 p-5 sm:p-6">
            {selected ? (
              <JobDetail
                key={selected.id}
                job={selected}
                holdings={data.holdings}
                canWrite={canWrite}
                busy={!!busy}
                loadingResult={
                  !selected.result &&
                  !isActive(selected) &&
                  ['awaiting_review', 'accepted', 'rejected'].includes(
                    selected.status,
                  ) &&
                  !loadError
                }
                onAction={(action, selections, expectedRevision) =>
                  reviewJob(selected, action, selections, expectedRevision)
                }
              />
            ) : loading ? (
              <div className="flex flex-col gap-5">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : (
              <Empty className="min-h-80">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileSearch />
                  </EmptyMedia>
                  <EmptyTitle>Every update starts with its source</EmptyTitle>
                  <EmptyDescription>
                    Open a document to inspect extracted facts, page evidence
                    and the processing trace before accepting changes.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function JobDetail({
  job,
  holdings,
  canWrite,
  busy,
  loadingResult,
  onAction,
}: {
  job: ProcessingJob;
  holdings: Holding[];
  canWrite: boolean;
  busy: boolean;
  loadingResult: boolean;
  onAction: (
    action: JobAction,
    selections?: ReviewSelection[],
    expectedRevision?: number,
  ) => Promise<boolean>;
}) {
  const result = job.result;
  const unreadableSource = result?.trace.some(
    (entry) => entry.stage === 'input_coverage' && entry.status === 'warning',
  );
  const partiallyUnreadableSource = result?.warnings.some((warning) =>
    /has no native text|local OCR (?:failed|found no readable text)|Attachment \d+ skipped|Email body part skipped/i.test(
      warning,
    ),
  );
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Status tone={statusTone(job.status)}>
            {statusLabels[job.status] ?? job.status}
          </Status>
          <Status>{modeName(job.mode)}</Status>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {job.engine?.execution === 'cloud' ||
            result?.execution === 'cloud' ? (
              <Cloud className="size-3" />
            ) : (
              <LockKeyhole className="size-3" />
            )}
            {job.engine?.execution === 'cloud' || result?.execution === 'cloud'
              ? 'Cloud execution'
              : 'Local execution'}
          </span>
        </div>
        <h3 className="break-words text-lg font-medium tracking-tight">
          {job.filename}
        </h3>
        {job.engineLegacy ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {job.engine
              ? 'Legacy job: this engine was recorded when processing resumed. Earlier attempts did not record an engine profile.'
              : 'Legacy job: no engine profile was recorded. A retry will capture the deployment-local default at worker pickup.'}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Received {timestamp(job.createdAt)} · Policy {job.policyRevision}
            {job.engine
              ? ` · ${job.engine.model} · Engine revision ${job.engine.revision}`
              : ''}
          </p>
          <a
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            href={'/api/documents/' + encodeURIComponent(job.documentId)}
            download
          >
            <ArrowDownToLine data-icon="inline-start" /> Download original
          </a>
        </div>
      </div>

      {isActive(job) ? (
        <Alert aria-live="polite">
          {job.status === 'processing' ? (
            <Loader2 className="animate-spin" />
          ) : (
            <GitBranch />
          )}
          <AlertTitle>
            {job.status === 'processing'
              ? 'Reading the document'
              : 'Waiting for a document worker'}
          </AlertTitle>
          <AlertDescription>
            {job.status === 'processing'
              ? 'Results will appear here when extraction finishes. You can leave this screen while the job runs.'
              : 'This document is queued. Its selected mode, engine and source are retained until a worker is available.'}
          </AlertDescription>
        </Alert>
      ) : null}
      {job.status === 'failed' ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Processing did not finish</AlertTitle>
          <AlertDescription>
            Try again after checking that your selected processor and configured
            model are available.
            {job.errorCode ? (
              <p className="mt-2 break-words text-xs">
                Reference: {job.errorCode}
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {job.status === 'accepted' ? (
        <Alert aria-live="polite">
          <CheckCheck />
          <AlertTitle>Review closed</AlertTitle>
          <AlertDescription>
            Every current fact decision is retained below. Accepted values and
            any amendments have their own review history.
          </AlertDescription>
        </Alert>
      ) : null}
      {job.status === 'rejected' || job.status === 'cancelled' ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          {job.status === 'rejected'
            ? 'This review was rejected. No extracted facts were applied.'
            : 'This job was cancelled. The original document remains available.'}
        </p>
      ) : null}

      {canWrite &&
      (isActive(job) || ['failed', 'cancelled'].includes(job.status)) ? (
        <div className="flex justify-start">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onAction(isActive(job) ? 'cancel' : 'retry')}
          >
            {isActive(job) ? (
              <X data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            {isActive(job) ? 'Cancel job' : 'Retry processing'}
          </Button>
        </div>
      ) : null}

      {loadingResult ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="text-sm text-muted-foreground">
            Loading this document’s extraction…
          </p>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : null}
      {result && !isActive(job) ? (
        <>
          <div className="grid grid-cols-2 gap-4 rounded-lg bg-muted/40 p-4 text-sm sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Document type
              </span>
              <span className="break-words">
                {result.documentType.replaceAll('_', ' ')}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Extracted facts
              </span>
              <span>{result.facts.length}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Relevance score
              </span>
              <span>{Math.round(result.confidence * 100)}%</span>
              <span className="text-xs text-muted-foreground">
                Uncalibrated classifier probability
              </span>
            </div>
          </div>

          {unreadableSource || partiallyUnreadableSource ? (
            <Alert>
              <AlertCircle />
              <AlertTitle>
                {unreadableSource
                  ? 'Source could not be read'
                  : 'Source could only be read in part'}
              </AlertTitle>
              <AlertDescription>
                Open the original document and check its contents, including
                attachments. Supply readable copies of any skipped content
                before relying on the extraction result.
              </AlertDescription>
            </Alert>
          ) : !result.relevant ? (
            <Alert>
              <FileSearch />
              <AlertTitle>Classified as not investment-related</AlertTitle>
              <AlertDescription>
                Check the original source before deciding whether to keep any
                extracted information.
              </AlertDescription>
            </Alert>
          ) : null}
          {result.warnings.length ? (
            <Alert>
              <AlertCircle />
              <AlertTitle>
                {result.warnings.length} processing{' '}
                {result.warnings.length === 1 ? 'warning' : 'warnings'}
              </AlertTitle>
              <AlertDescription>
                <ul className="ml-4 flex list-disc flex-col gap-2">
                  {result.warnings.map((warning, index) => (
                    <li key={index} className="break-words">
                      {warning}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {result.facts.length ? (
            <ReviewWorkbench
              job={job}
              holdings={holdings}
              canWrite={canWrite}
              busy={busy}
              onReview={(decisions, revision) =>
                onAction('review', decisions, revision)
              }
            />
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileSearch />
                </EmptyMedia>
                <EmptyTitle>No supported facts found</EmptyTitle>
                <EmptyDescription>
                  Check the original source and warnings. No facts have been
                  posted.
                </EmptyDescription>
              </EmptyHeader>
              {canWrite && job.status === 'awaiting_review' ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void onAction('reject')}
                >
                  Close empty review
                </Button>
              ) : null}
            </Empty>
          )}

          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Processing trace · {result.trace.length} steps
            </summary>
            <div className="mt-4 flex flex-col gap-4">
              {result.model ? (
                <p className="break-words text-xs text-muted-foreground">
                  Model: {result.model}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No model identifier returned
                </p>
              )}
              {result.trace.length ? (
                <ol className="flex flex-col gap-4">
                  {result.trace.map((step, index) => (
                    <li key={index} className="flex min-w-0 gap-3">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="break-words text-xs font-medium">
                            {step.stage.replaceAll('_', ' ')}
                          </h4>
                          <Status>{step.status}</Status>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                          {step.detail}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No trace steps were returned.
                </p>
              )}
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}
