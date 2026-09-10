'use client';

import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  Settings2,
  Upload,
  X,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { ReviewDecision, ReviewState } from '@/lib/review-contract';
import type {
  ProcessingJob,
  ProcessingPage,
  ProcessingPolicy,
  WorkspaceIdentity,
} from '@/lib/processing-contract';
import {
  documentNextStep,
  documentStage,
  documentStages,
  documentTimestamp,
  documentTone,
  durationLabel,
  factCounts,
  factTypeLabel,
} from '@/lib/document-pipeline';
import {
  DocumentRecord,
  type DocumentRecordTab,
  type DocumentJobAction,
} from './document-record';
import { PageHeading, Status } from './primitives';
import { useWorkspace } from './workspace-context';
import styles from './document-pipeline.module.css';

type ProcessingResponse = {
  jobs: ProcessingJob[];
  policy: ProcessingPolicy;
  role: WorkspaceIdentity['role'];
  page: ProcessingPage;
};
type ReviewSelection = ReviewDecision;
type JobAction = DocumentJobAction;
type ReviewResponse = {
  ok: boolean;
  status: string;
  applied: number;
  duplicates: number;
  review?: ReviewState;
};
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const isActive = (job: ProcessingJob) =>
  job.status === 'queued' || job.status === 'processing';
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
  const [detailsLoadedId, setDetailsLoadedId] = useState<string | null>(null);
  const [recordTab, setRecordTab] = useState<DocumentRecordTab>('extracted');
  const [stage, setStage] = useState('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [listingStale, setListingStale] = useState(false);
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
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

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
        const params = new URLSearchParams({
          limit: '50',
          offset: String(offset),
        });
        if (selectedId) params.set('jobId', selectedId);
        if (stage !== 'all') params.set('status', stage);
        if (search) params.set('q', search);
        const result = await requestJson<ProcessingResponse>(
          '/api/processing?' + params,
          { signal: controller.signal },
        );
        if (
          !Array.isArray(result.jobs) ||
          !result.policy ||
          !result.page ||
          !Array.isArray(result.page.jobIds)
        )
          throw new Error('Invalid document response');
        if (!disposed && epoch === responseEpoch.current) {
          setSnapshot(result);
          setDetailsLoadedId(selectedId);
          setListingStale(false);
          setLoadError(null);
          delay =
            result.page.statusCounts.queued +
              result.page.statusCounts.processing >
            0
              ? 5000
              : 15_000;
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
  }, [refreshKey, selectedId, stage, search, offset]);
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
  const selected = jobs.find((job) => job.id === selectedId);
  const pageIds = new Set(snapshot?.page.jobIds ?? []);
  const selectedStage = documentStages.find((item) => item.value === stage);
  const rows = jobs.filter(
    (job) =>
      pageIds.has(job.id) &&
      (stage === 'all' ||
        selectedStage?.statuses.some((status) => status === job.status)),
  );
  const canWrite = !!snapshot && snapshot.role !== 'viewer';
  const totals = listingStale ? undefined : snapshot?.page.statusCounts;
  const allCount = totals
    ? Object.values(totals).reduce((sum, count) => sum + count, 0)
    : null;
  const counts = rows.map(factCounts);
  const extracted = counts.reduce(
    (sum, item) => sum + (item?.extractedCount ?? 0),
    0,
  );
  const accepted = counts.reduce(
    (sum, item) => sum + (item?.acceptedCount ?? 0),
    0,
  );
  const remaining = counts.reduce(
    (sum, item) => sum + (item?.remainingCount ?? 0),
    0,
  );
  const unavailable = rows.filter(
    (job, index) => !counts[index] && !isActive(job),
  ).length;
  function openRecord(job: ProcessingJob, action = false) {
    setSelectedId(job.id);
    setActionError(null);
    setNotice(null);
    setRecordTab(
      action
        ? job.status === 'awaiting_review'
          ? 'review'
          : ['failed', 'queued', 'processing', 'cancelled'].includes(job.status)
            ? 'activity'
            : 'extracted'
        : 'extracted',
    );
  }
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
        setListingStale(true);
        setSelectedId(result.jobId);
        setRecordTab('extracted');
        setUploadOpen(false);
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
        setListingStale(true);
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
                        summary: undefined,
                        ...(action === 'retry'
                          ? {
                              result: null,
                              review: null,
                              timing: undefined,
                              activity: {
                                stage: 'queued' as const,
                                availableAt: null,
                              },
                            }
                          : {}),
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
    <div className={styles.pipeline}>
      <PageHeading
        title="Document pipeline"
        subtitle="Every source, the information it produced, and the next step."
      >
        <Link
          href="/?view=connections&tab=engines"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <Settings2 data-icon="inline-start" />
          Engine settings
        </Link>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Refresh documents"
          disabled={!!busy || refreshing}
          onClick={() => setRefreshKey((value) => value + 1)}
        >
          <RefreshCw className={cn(refreshing && 'animate-spin')} />
        </Button>
        <Button onClick={() => setUploadOpen(true)} disabled={!canWrite}>
          <Upload data-icon="inline-start" />
          Add document
        </Button>
      </PageHeading>
      {loadError || actionError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>
            {actionError
              ? 'Action could not be completed'
              : 'Documents could not be refreshed'}
          </AlertTitle>
          <AlertDescription>
            {actionError || loadError}
            {loadError && snapshot ? ' Showing the last loaded records.' : ''}
          </AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert aria-live="polite">
          <Check />
          <AlertTitle>Document updated</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      <section className={styles.register} aria-label="Document pipeline">
        <div className={styles.stageBar}>
          <Tabs
            value={stage}
            onValueChange={(value) => {
              setStage(String(value));
              setOffset(0);
            }}
          >
            <TabsList variant="line" aria-label="Document stage">
              {documentStages.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                  <span className={styles.tabCount}>
                    {totals
                      ? item.value === 'all'
                        ? allCount
                        : item.statuses.reduce(
                            (sum, status) => sum + totals[status],
                            0,
                          )
                      : '—'}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className={styles.toolbar}>
          <InputGroup className="w-full sm:max-w-sm">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search document filenames"
              placeholder="Search filenames…"
              maxLength={200}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
            />
            {query ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Clear document search"
                  onClick={() => {
                    setQuery('');
                    setOffset(0);
                  }}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          <p className={styles.pageSummary} aria-live="polite">
            {loading ? (
              'Loading documents…'
            ) : !snapshot ? (
              'Document totals are unavailable.'
            ) : listingStale ? (
              loadError ? (
                'Refresh to update document totals.'
              ) : (
                'Refreshing document totals…'
              )
            ) : (
              <>
                <strong>{extracted}</strong> facts · <strong>{accepted}</strong>{' '}
                recorded · <strong>{remaining}</strong>{' '}
                {remaining === 1 ? 'decision' : 'decisions'} left
                <span>
                  Across {rows.length} shown{' '}
                  {rows.length === 1 ? 'document' : 'documents'}
                  {unavailable
                    ? ` · ${unavailable} without extraction counts`
                    : ''}
                </span>
              </>
            )}
          </p>
        </div>
        {loading ? (
          <div
            className="flex flex-col gap-5 p-6"
            aria-label="Loading documents"
          >
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : !snapshot ? (
          <Empty className="min-h-80">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertCircle />
              </EmptyMedia>
              <EmptyTitle>Documents could not be loaded</EmptyTitle>
              <EmptyDescription>
                Your document count and records are not available yet. Try
                refreshing.
              </EmptyDescription>
            </EmptyHeader>
            <Button
              variant="outline"
              disabled={refreshing}
              onClick={() => setRefreshKey((value) => value + 1)}
            >
              Refresh documents
            </Button>
          </Empty>
        ) : rows.length ? (
          <>
            <div className={styles.desktopList}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[33%]">Document & source</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Extracted information</TableHead>
                    <TableHead>Extraction time</TableHead>
                    <TableHead className="text-right">Next step</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((job) => {
                    const next = documentNextStep(job);
                    return (
                      <TableRow
                        key={job.id}
                        data-state={
                          selectedId === job.id ? 'selected' : undefined
                        }
                      >
                        <TableCell>
                          <DocumentIdentity
                            job={job}
                            onOpen={() => openRecord(job)}
                          />
                        </TableCell>
                        <TableCell>
                          <div className={styles.cellStack}>
                            <Status tone={documentTone(job.status)}>
                              {documentStage(job)}
                            </Status>
                            <small>
                              Received {documentTimestamp(job.createdAt)}
                            </small>
                          </div>
                        </TableCell>
                        <TableCell>
                          <ExtractionSummary job={job} />
                        </TableCell>
                        <TableCell>
                          <DocumentTiming job={job} />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className={styles.nextStep}>
                            <Button
                              variant={
                                job.status === 'awaiting_review' ||
                                job.status === 'failed'
                                  ? 'outline'
                                  : 'ghost'
                              }
                              size="sm"
                              onClick={() => openRecord(job, true)}
                            >
                              {next.label}
                              <ChevronRight data-icon="inline-end" />
                            </Button>
                            <small>
                              {job.status === 'awaiting_review'
                                ? 'Confirm the source and investment.'
                                : next.detail}
                            </small>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className={styles.mobileList} aria-label="Document records">
              {rows.map((job) => (
                <article key={job.id} className={styles.mobileRecord}>
                  <DocumentIdentity job={job} onOpen={() => openRecord(job)} />
                  <div className={styles.mobileMeta}>
                    <Status tone={documentTone(job.status)}>
                      {documentStage(job)}
                    </Status>
                    <DocumentTiming job={job} />
                  </div>
                  <ExtractionSummary job={job} />
                  <div className={styles.mobileAction}>
                    <small>Received {documentTimestamp(job.createdAt)}</small>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openRecord(job, true)}
                    >
                      {documentNextStep(job).label}
                      <ChevronRight data-icon="inline-end" />
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : (
          <Empty className="min-h-80">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText />
              </EmptyMedia>
              <EmptyTitle>
                {query || stage !== 'all'
                  ? 'No documents match this view'
                  : 'Your document pipeline starts here'}
              </EmptyTitle>
              <EmptyDescription>
                {query || stage !== 'all'
                  ? 'Try another filename or stage.'
                  : 'Connect a mailbox or folder, or add an email, report or statement. Its extracted information and review history will appear here.'}
              </EmptyDescription>
            </EmptyHeader>
            {query || stage !== 'all' ? (
              <Button
                variant="outline"
                onClick={() => {
                  setQuery('');
                  setStage('all');
                  setOffset(0);
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Link
                href="/?view=connections"
                className={buttonVariants({ variant: 'outline' })}
              >
                Connect a source
              </Link>
            )}
          </Empty>
        )}
        <div className={styles.footer}>
          <p>
            {listingStale
              ? 'Refresh to update the document list'
              : snapshot
                ? `${rows.length ? snapshot.page.offset + 1 : 0}–${rows.length ? Math.min(snapshot.page.offset + rows.length, snapshot.page.total) : 0} of ${snapshot.page.total} documents`
                : loading
                  ? 'Loading records'
                  : 'Records unavailable'}
            <span>
              {refreshing ? ' · Updating…' : ' · Updates automatically'}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!snapshot || offset === 0 || refreshing || listingStale}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              <ChevronLeft data-icon="inline-start" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={
                !snapshot?.page.hasMore ||
                snapshot.page.nextOffset === null ||
                refreshing ||
                listingStale
              }
              onClick={() => {
                if (snapshot?.page.nextOffset != null)
                  setOffset(snapshot.page.nextOffset);
              }}
            >
              Next
              <ChevronRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
        {snapshot?.page.hasMore && snapshot.page.nextOffset === null ? (
          <p className="px-5 pb-4 text-sm text-muted-foreground">
            Narrow the filename search to reach older documents.
          </p>
        ) : null}
      </section>
      <Sheet
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setSelectedId(null);
        }}
      >
        <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-[min(1080px,94vw)] gap-0">
          <SheetHeader className="border-b pr-12">
            <SheetTitle>Document record</SheetTitle>
            <SheetDescription className="[overflow-wrap:anywhere]">
              {selected?.filename ?? 'Loading the selected document…'}
            </SheetDescription>
          </SheetHeader>
          <div className={styles.recordBody}>
            {loadError ? (
              <Alert variant="destructive">
                <AlertTitle>Document could not be refreshed</AlertTitle>
                <AlertDescription>
                  {loadError}{' '}
                  {selected?.result ? 'Showing the last loaded record.' : ''}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={refreshing || !!busy}
                    onClick={() => setRefreshKey((value) => value + 1)}
                  >
                    Refresh document
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {actionError || notice ? (
              <Alert variant={actionError ? 'destructive' : 'default'}>
                <AlertTitle>
                  {actionError ? 'Action needs attention' : 'Saved'}
                </AlertTitle>
                <AlertDescription>{actionError || notice}</AlertDescription>
              </Alert>
            ) : null}
            {selected ? (
              <DocumentRecord
                key={selected.id}
                job={selected}
                holdings={data.holdings}
                canWrite={canWrite}
                busy={!!busy}
                loadingDetails={!loadError && detailsLoadedId !== selected.id}
                tab={recordTab}
                onTab={setRecordTab}
                onAction={(action, selections, revision) =>
                  reviewJob(selected, action, selections, revision)
                }
              />
            ) : detailsLoadedId === selectedId && !loadError ? (
              <Alert variant="destructive">
                <AlertTitle>Document unavailable</AlertTitle>
                <AlertDescription>
                  This document is no longer available in this office.
                </AlertDescription>
              </Alert>
            ) : !loadError ? (
              <Skeleton className="h-60 w-full" />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      <Dialog
        open={uploadOpen}
        onOpenChange={(open) => {
          if (busy !== 'upload') setUploadOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a document</DialogTitle>
            <DialogDescription>
              Upload an email, statement or manager update to this office’s
              pipeline.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={upload}>
            <FieldGroup>
              <Field
                data-invalid={!!fileError}
                data-disabled={!canWrite || !!busy}
              >
                <FieldLabel htmlFor="processing-document">
                  Source document
                </FieldLabel>
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
                  PDF, TXT or EML · Up to 10 MB. Originals and results are
                  retained encrypted.
                </FieldDescription>
                {fileError ? <FieldError>{fileError}</FieldError> : null}
              </Field>
              <p className="text-sm text-muted-foreground">
                {snapshot?.policy.engine?.model ?? 'Configured engine'} ·{' '}
                {snapshot?.policy.mode === 'agentic'
                  ? 'Agentic'
                  : 'Classical workflow'}{' '}
                ·{' '}
                {snapshot?.policy.execution === 'cloud'
                  ? 'Document content goes to the selected cloud provider.'
                  : 'Local inference'}
              </p>
              <div className="flex justify-end">
                <Button type="submit" disabled={!file || !canWrite || !!busy}>
                  {busy === 'upload' ? (
                    <Loader2
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : (
                    <Upload data-icon="inline-start" />
                  )}
                  {busy === 'upload' ? 'Uploading…' : 'Upload & extract'}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DocumentIdentity({
  job,
  onOpen,
}: {
  job: ProcessingJob;
  onOpen: () => void;
}) {
  const names = job.summary?.investmentNames ?? [];
  const kind = job.source?.kind;
  return (
    <div className={styles.identity}>
      <div className={styles.sourceIcon}>
        {kind === 'folder' ? (
          <FolderOpen />
        ) : kind === 'mailbox' || /\.eml$/i.test(job.filename) ? (
          <Mail />
        ) : (
          <FileText />
        )}
      </div>
      <div className={styles.identityText}>
        <button type="button" className={styles.documentLink} onClick={onOpen}>
          {job.filename}
        </button>
        <span>
          {names.length
            ? names.slice(0, 2).join(' · ')
            : (job.summary?.documentType?.replaceAll('_', ' ') ??
              'Information pending extraction')}
        </span>
        <small>
          {job.source?.displayName ??
            (kind === 'folder'
              ? 'Folder import'
              : kind === 'mailbox'
                ? 'Mailbox import'
                : 'Direct upload')}
          {job.source?.familyNames.length
            ? ` · ${job.source.familyContext === 'source_path' ? 'Folder hint: ' : ''}${job.source.familyNames.join(', ')}`
            : ''}
        </small>
      </div>
    </div>
  );
}
function ExtractionSummary({ job }: { job: ProcessingJob }) {
  const counts = factCounts(job);
  if (!counts)
    return (
      <div className={styles.cellStack}>
        <span>{isActive(job) ? 'Waiting for results' : 'Not available'}</span>
        <small>
          {isActive(job)
            ? 'Counts appear after extraction'
            : job.status === 'failed'
              ? 'Input requires attention'
              : 'Open the record for details'}
        </small>
      </div>
    );
  return (
    <div className={styles.cellStack}>
      <span>
        <strong>{counts.extractedCount}</strong> extracted ·{' '}
        <strong>{counts.acceptedCount}</strong> recorded
      </span>
      <small>
        {counts.remainingCount
          ? `${counts.remainingCount} ${counts.remainingCount === 1 ? 'decision' : 'decisions'} left${counts.deferredCount ? ` · ${counts.deferredCount} deferred` : ''}`
          : counts.legacyCount
            ? `${counts.legacyCount} older decisions unavailable`
            : counts.rejectedCount
              ? `${counts.rejectedCount} dismissed`
              : 'No fact decisions remaining'}
      </small>
      {job.summary?.factTypes.length ? (
        <small>{job.summary.factTypes.map(factTypeLabel).join(' · ')}</small>
      ) : null}
    </div>
  );
}
function DocumentTiming({ job }: { job: ProcessingJob }) {
  const active = job.status === 'processing';
  return (
    <div className={styles.cellStack}>
      <span className={styles.duration}>
        {durationLabel(
          active
            ? job.timing?.elapsedProcessingMs
            : job.timing?.processingDurationMs,
        )}
        {active && job.timing?.elapsedProcessingMs != null ? ' elapsed' : ''}
      </span>
      <small>
        {job.timing?.processingDurationMs != null
          ? 'Extraction attempt'
          : active
            ? 'Currently extracting'
            : job.status === 'queued'
              ? 'Not started'
              : 'Historical timing unavailable'}
      </small>
    </div>
  );
}
