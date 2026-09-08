'use client';

import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  Bot,
  Check,
  CheckCheck,
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
import { Checkbox } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { factAcceptanceIssue } from '@/lib/fact-review';
import type { Holding } from '@/data/types';
import type {
  ExtractedFact,
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
type ReviewSelection = { factIndex: number; holdingId: string | null };
type JobAction = 'accept' | 'reject' | 'retry' | 'cancel';
type ReviewResponse = {
  ok: boolean;
  status: string;
  applied: number;
  duplicates: number;
};
type FactChoice = { selected: boolean; holdingId: string | null };

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
const factLabels: Record<ExtractedFact['kind'], string> = {
  valuation: 'Valuation',
  capital_call: 'Capital call',
  distribution: 'Distribution',
  news: 'Manager update',
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
function calendarDate(value: string | null) {
  if (!value) return 'Not provided';
  const date = new Date(value + 'T12:00:00Z');
  return Number.isNaN(date.getTime())
    ? 'Not provided'
    : date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
}
function factAmount(fact: ExtractedFact) {
  if (fact.amount === null) return 'Amount not provided';
  const [whole, decimals] = fact.amount.split('.');
  const amount =
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
    (decimals ? '.' + decimals : '');
  return (fact.currency || 'Currency not provided') + ' ' + amount;
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

export function ProcessingView() {
  const { data, reload } = useWorkspace();
  const [snapshot, setSnapshot] = useState<ProcessingResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    if (mutationLock.current) return;
    mutationLock.current = true;
    responseEpoch.current += 1;
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      done(await run());
    } catch (error) {
      setActionError(errorMessage(error));
      if (
        error instanceof ProcessingRequestError &&
        [401, 403].includes(error.status)
      )
        setSnapshot(null);
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
  function reviewJob(
    job: ProcessingJob,
    action: JobAction,
    selections?: ReviewSelection[],
  ) {
    if (!canWrite) return;
    void mutate(
      job.id,
      () =>
        requestJson<ReviewResponse>(
          '/api/processing/' + encodeURIComponent(job.id),
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              action === 'accept' ? { action, selections } : { action },
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
                        errorCode: null,
                        updatedAt: new Date().toISOString(),
                      }
                    : item,
                ),
              }
            : current,
        );
        if (action === 'accept') {
          setNotice(
            result.applied +
              ' selected ' +
              (result.applied === 1 ? 'fact' : 'facts') +
              ' applied. ' +
              (result.duplicates
                ? result.duplicates + ' already recorded. '
                : '') +
              'Review closed; unselected facts were not applied.',
          );
          reload();
        } else {
          setNotice(
            action === 'retry'
              ? 'Job queued again using its original processing mode.'
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
        <Status tone="success">
          <ShieldCheck className="size-3" /> Local only
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
          subtitle="One local pipeline. Two ways to read your documents."
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
                ? 'Your configured local model examines the document through bounded extraction steps.'
                : 'Fixed stages classify and parse the document, with optional local-model extraction for unresolved fields.'}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <LockKeyhole className="size-3.5" /> No cloud fallback
              </span>
              {snapshot ? (
                <span>Policy revision {snapshot.policy.revision}</span>
              ) : null}
              {busy === 'policy' ? <output>Saving mode…</output> : null}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Changes apply to new uploads. Existing jobs keep their recorded
              mode.
              {snapshot && !canManage
                ? ' A workspace owner or admin can change the default.'
                : ''}
            </p>
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
                key={selected.id + ':' + selected.updatedAt}
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
                onAction={(action, selections) =>
                  reviewJob(selected, action, selections)
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
  onAction: (action: JobAction, selections?: ReviewSelection[]) => void;
}) {
  const [choices, setChoices] = useState<Record<number, FactChoice>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const result = job.result;
  const unreadableSource = result?.trace.some(
    (entry) => entry.stage === 'input_coverage' && entry.status === 'warning',
  );
  const partiallyUnreadableSource = result?.warnings.some((warning) =>
    /has no native text|local OCR (?:failed|found no readable text)|Attachment \d+ skipped|Email body part skipped/i.test(
      warning,
    ),
  );
  const reviewing = job.status === 'awaiting_review';
  const selections = Object.entries(choices)
    .filter(([, choice]) => choice.selected)
    .map(([index, choice]) => ({
      factIndex: Number(index),
      holdingId: choice.holdingId,
    }));
  const complete =
    selections.length > 0 &&
    selections.every(
      (selection) =>
        !!selection.holdingId &&
        holdings.some((holding) => holding.id === selection.holdingId) &&
        !!result?.facts[selection.factIndex] &&
        !factAcceptanceIssue(result.facts[selection.factIndex]),
    );
  const options = holdings.map((holding) => ({
    value: holding.id,
    label: holding.name,
  }));
  function updateChoice(index: number, update: Partial<FactChoice>) {
    setChoices((current) => ({
      ...current,
      [index]: {
        ...(current[index] ?? { selected: false, holdingId: null }),
        ...update,
      },
    }));
    setConfirmed(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Status tone={statusTone(job.status)}>
            {statusLabels[job.status] ?? job.status}
          </Status>
          <Status>{modeName(job.mode)}</Status>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <LockKeyhole className="size-3" /> Local execution
          </span>
        </div>
        <h3 className="break-words text-lg font-medium tracking-tight">
          {job.filename}
        </h3>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Received {timestamp(job.createdAt)} · Policy {job.policyRevision}
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
              : 'Waiting for the local worker'}
          </AlertTitle>
          <AlertDescription>
            {job.status === 'processing'
              ? 'Results will appear here when extraction finishes. You can leave this screen while the job runs.'
              : 'This document is queued. Its selected mode and source are retained until a worker is available.'}
          </AlertDescription>
        </Alert>
      ) : null}
      {job.status === 'failed' ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Processing did not finish</AlertTitle>
          <AlertDescription>
            Try again after checking that your local processor and configured
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
            Only the facts selected during acceptance were applied. Unselected
            facts were not applied.
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
                attachments. Supply readable copies of any skipped content before
                relying on the extraction result.
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
            <FieldSet>
              <FieldLegend>
                {reviewing ? 'Review extracted facts' : 'Extracted facts'}
              </FieldLegend>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {reviewing
                  ? 'Select the facts to accept, link each to an existing investment, and compare the quoted source.'
                  : 'This is the extraction record. It includes facts that may not have been selected during review.'}
              </p>
              {reviewing && !holdings.length ? (
                <Alert>
                  <AlertCircle />
                  <AlertTitle>Add an investment first</AlertTitle>
                  <AlertDescription>
                    Create an investment in the Investments view, then return
                    here to link and accept its facts.
                  </AlertDescription>
                </Alert>
              ) : null}
              {result.facts.map((fact, index) => {
                const choice = choices[index] ?? {
                  selected: false,
                  holdingId: null,
                };
                const issue = factAcceptanceIssue(fact);
                const selectable = reviewing && canWrite;
                const missingHolding = choice.selected && !choice.holdingId;
                const checkboxId = 'fact-' + job.id + '-' + index;
                return (
                  <article
                    key={index}
                    className={cn(
                      'flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4',
                      choice.selected && 'border-primary/40 bg-accent/20',
                    )}
                  >
                    <Field
                      orientation="horizontal"
                      data-disabled={
                        selectable && (!!issue || !holdings.length || busy)
                      }
                    >
                      {selectable ? (
                        <Checkbox
                          id={checkboxId}
                          checked={choice.selected}
                          disabled={!!issue || !holdings.length || busy}
                          onCheckedChange={(checked) =>
                            updateChoice(index, { selected: checked })
                          }
                          aria-describedby={
                            issue ? checkboxId + '-issue' : undefined
                          }
                        />
                      ) : null}
                      <FieldContent>
                        {selectable ? (
                          <FieldLabel htmlFor={checkboxId}>
                            {fact.investmentName}
                          </FieldLabel>
                        ) : (
                          <h4 className="break-words text-sm font-medium">
                            {fact.investmentName}
                          </h4>
                        )}
                        <FieldDescription>
                          {factLabels[fact.kind]}
                        </FieldDescription>
                      </FieldContent>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        Fact {index + 1}
                      </span>
                    </Field>
                    <p className="break-words text-sm leading-relaxed">
                      {fact.summary}
                    </p>
                    <dl className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <dt className="text-muted-foreground">
                          Reported amount
                        </dt>
                        <dd className="mt-1 break-words font-medium">
                          {factAmount(fact)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">
                          Effective date
                        </dt>
                        <dd className="mt-1">
                          {calendarDate(fact.effectiveDate)}
                        </dd>
                      </div>
                      {fact.dueDate ? (
                        <div>
                          <dt className="text-muted-foreground">Due date</dt>
                          <dd className="mt-1">{calendarDate(fact.dueDate)}</dd>
                        </div>
                      ) : null}
                    </dl>
                    <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <FileText className="size-3.5" /> Source evidence · Page{' '}
                        {fact.evidence.page}
                      </span>
                      <blockquote className="whitespace-pre-wrap break-words text-xs leading-relaxed">
                        {fact.evidence.quote}
                      </blockquote>
                    </div>
                    {selectable ? (
                      <Field
                        data-invalid={missingHolding}
                        data-disabled={busy || !!issue || !holdings.length}
                      >
                        <FieldLabel htmlFor={checkboxId + '-holding'}>
                          Link to investment
                        </FieldLabel>
                        <Select
                          value={choice.holdingId}
                          items={options}
                          disabled={busy || !!issue || !holdings.length}
                          onValueChange={(holdingId) =>
                            updateChoice(index, { holdingId })
                          }
                        >
                          <SelectTrigger
                            id={checkboxId + '-holding'}
                            className="w-full"
                            aria-invalid={missingHolding}
                          >
                            <SelectValue
                              placeholder={
                                holdings.length
                                  ? 'Choose an existing investment'
                                  : 'No investments in this workspace'
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {options.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {missingHolding ? (
                          <FieldError>
                            Choose the investment this selected fact belongs to.
                          </FieldError>
                        ) : null}
                        {issue ? (
                          <FieldDescription id={checkboxId + '-issue'}>
                            {issue}
                          </FieldDescription>
                        ) : null}
                      </Field>
                    ) : null}
                  </article>
                );
              })}
            </FieldSet>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileSearch />
                </EmptyMedia>
                <EmptyTitle>No supported facts found</EmptyTitle>
                <EmptyDescription>
                  Review the original and processing warnings. You can reject
                  this review if it contains no usable investment update.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {reviewing && canWrite ? (
            <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
              <p className="text-sm font-medium">
                {selections.length} {selections.length === 1 ? 'fact' : 'facts'}{' '}
                selected for acceptance
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Accepted valuations update reported marks. Capital calls and
                distributions add source-linked events; a capital call also
                creates a review task. Acceptance does not move money or change
                cash balances.
              </p>
              <Field orientation="horizontal" data-disabled={!complete || busy}>
                <Checkbox
                  id={'confirm-' + job.id}
                  checked={confirmed}
                  disabled={!complete || busy}
                  onCheckedChange={setConfirmed}
                />
                <FieldContent>
                  <FieldLabel htmlFor={'confirm-' + job.id}>
                    I have checked the selected facts and their investment
                    links.
                  </FieldLabel>
                  <FieldDescription>
                    Accepting closes this review. All unselected facts are
                    ignored; they do not remain pending.
                  </FieldDescription>
                </FieldContent>
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmReject((current) => !current)}
                >
                  {confirmReject ? 'Keep reviewing' : 'Reject review'}
                </Button>
                <Button
                  disabled={busy || !complete || !confirmed}
                  onClick={() => onAction('accept', selections)}
                >
                  <Check data-icon="inline-start" /> Accept selected facts{' '}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </div>
              {confirmReject ? (
                <Alert>
                  <AlertTitle>Reject this document review?</AlertTitle>
                  <AlertDescription>
                    No facts will be applied. The original document and
                    extraction record remain available.
                  </AlertDescription>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => onAction('reject')}
                    >
                      Confirm rejection
                    </Button>
                  </div>
                </Alert>
              ) : null}
            </div>
          ) : null}

          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Processing trace · {result.trace.length} steps
            </summary>
            <div className="mt-4 flex flex-col gap-4">
              {result.model ? (
                <p className="break-words text-xs text-muted-foreground">
                  Local model: {result.model}
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
