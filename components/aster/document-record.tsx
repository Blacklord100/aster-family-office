'use client';

import Link from 'next/link';
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpRight,
  CheckCheck,
  Clock3,
  FileSearch,
  FileText,
  GitBranch,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Holding } from '@/data/types';
import type { ProcessingJob } from '@/lib/processing-contract';
import type { ReviewDecision } from '@/lib/review-contract';
import { reviewedFact } from '@/lib/review-contract';
import {
  documentNextStep,
  documentStage,
  documentTimestamp,
  documentTone,
  durationLabel,
  factCounts,
  factTypeLabel,
  reportedAmountLabel,
} from '@/lib/document-pipeline';
import { ReviewWorkbench } from './review-workbench';
import { DocumentArchiveStatus } from './archive-settings';
import { Status } from './primitives';
import styles from './document-pipeline.module.css';

export type DocumentRecordTab = 'extracted' | 'review' | 'activity';
export type DocumentJobAction = 'review' | 'reject' | 'retry' | 'cancel';

export function DocumentRecord({
  job,
  holdings,
  canWrite,
  busy,
  loadingDetails,
  tab,
  onTab,
  onAction,
}: {
  job: ProcessingJob;
  holdings: Holding[];
  canWrite: boolean;
  busy: boolean;
  loadingDetails: boolean;
  tab: DocumentRecordTab;
  onTab: (tab: DocumentRecordTab) => void;
  onAction: (
    action: DocumentJobAction,
    decisions?: ReviewDecision[],
    revision?: number,
  ) => Promise<boolean>;
}) {
  const result = job.result;
  const counts = factCounts(job);
  const active = ['queued', 'processing'].includes(job.status);
  const loadingResult =
    !result &&
    loadingDetails &&
    ['awaiting_review', 'accepted', 'rejected'].includes(job.status);
  const issue =
    job.errorCode === 'PROCESSOR_HTTP_422'
      ? 'The source could not be read or validated. Check the original for protected or unreadable content and provide a readable copy if needed.'
      : job.errorCode === 'PROCESSOR_HTTP_413'
        ? 'The source exceeded a processing limit. Provide a smaller supported document before retrying.'
        : job.errorCode === 'PROCESSOR_HTTP_504'
          ? 'Extraction reached its time limit. Check the source and engine availability, then retry.'
          : 'Extraction did not finish. Check the original and engine availability before retrying.';
  return (
    <div className={styles.record}>
      <div className={styles.recordMeta}>
        <div className="flex flex-wrap items-center gap-2">
          <Status tone={documentTone(job.status)}>{documentStage(job)}</Status>
          <span>
            {job.mode === 'agentic' ? 'Agentic' : 'Classical workflow'} ·{' '}
            {job.engine?.model ?? result?.model ?? 'Engine not recorded'}
          </span>
        </div>
        <a
          href={'/api/documents/' + encodeURIComponent(job.documentId)}
          download
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <ArrowDownToLine data-icon="inline-start" />
          Download original
        </a>
      </div>
      <dl className={styles.recordStats}>
        <div>
          <dt>Extracted facts</dt>
          <dd>{counts?.extractedCount ?? '—'}</dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>{counts?.acceptedCount ?? '—'}</dd>
        </div>
        <div>
          <dt>Decisions remaining</dt>
          <dd>{counts?.remainingCount ?? '—'}</dd>
        </div>
        <div>
          <dt>
            {job.status === 'processing'
              ? 'Extraction elapsed'
              : 'Extraction time'}
          </dt>
          <dd className={styles.timeValue}>
            {durationLabel(
              job.status === 'processing'
                ? job.timing?.elapsedProcessingMs
                : job.timing?.processingDurationMs,
            )}
          </dd>
        </div>
      </dl>
      <div className={styles.recordContext}>
        <span>{job.source?.displayName ?? 'Direct upload'}</span>
        {job.source?.familyNames.length ? (
          <span>
            {job.source.familyContext === 'source_path'
              ? 'Folder hint: '
              : 'Linked family: '}
            {job.source.familyNames.join(', ')}
          </span>
        ) : null}
        <span>Received {documentTimestamp(job.createdAt)}</span>
      </div>

      <DocumentArchiveStatus documentId={job.documentId} />

      {active ? (
        <Alert aria-live="polite">
          {job.status === 'processing' ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Clock3 />
          )}
          <AlertTitle>{documentStage(job)}</AlertTitle>
          <AlertDescription>
            {documentNextStep(job).detail} The record updates automatically.
            Detailed reading steps and supported facts appear when extraction
            finishes.
            {job.activity?.availableAt &&
            job.activity.stage === 'waiting_for_capacity' ? (
              <p>
                Next scheduled pickup:{' '}
                {documentTimestamp(job.activity.availableAt)}
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {job.status === 'failed' ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Input needs attention</AlertTitle>
          <AlertDescription>
            {issue}
            {job.errorCode ? (
              <details className="mt-2">
                <summary>Technical reference</summary>
                {job.errorCode}
              </details>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {canWrite && (active || ['failed', 'cancelled'].includes(job.status)) ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void onAction(active ? 'cancel' : 'retry')}
          >
            {active ? (
              <X data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            {active ? 'Cancel extraction' : 'Retry extraction'}
          </Button>
          {job.status === 'failed' ? (
            <Link
              href="/?view=connections&tab=engines"
              className={buttonVariants({ variant: 'ghost' })}
            >
              Check engine settings
              <ArrowUpRight data-icon="inline-end" />
            </Link>
          ) : null}
        </div>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(value) => onTab(value as DocumentRecordTab)}
      >
        <div className={styles.recordTabs}>
          <TabsList variant="line" aria-label="Document record sections">
            <TabsTrigger value="extracted">Extracted information</TabsTrigger>
            <TabsTrigger value="review">Review & source</TabsTrigger>
            <TabsTrigger value="activity">Activity & timing</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="extracted" keepMounted>
          {loadingResult ? (
            <div className="flex flex-col gap-4">
              <p>Loading extracted information…</p>
              <Skeleton className="h-36 w-full" />
            </div>
          ) : result && !active ? (
            <>
              <div className={styles.sectionIntro}>
                <div>
                  <h3>
                    {result.facts.length
                      ? 'What this document contained'
                      : 'Extraction outcome'}
                  </h3>
                  <p>
                    {result.documentType.replaceAll('_', ' ')}
                    {counts?.remainingCount
                      ? ` · ${counts.remainingCount} ${counts.remainingCount === 1 ? 'decision still needs' : 'decisions still need'} attention`
                      : ''}
                  </p>
                </div>
                {canWrite && job.status === 'awaiting_review' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onTab('review')}
                  >
                    Review document
                    <ArrowUpRight data-icon="inline-end" />
                  </Button>
                ) : null}
              </div>
              {result.facts.length ? (
                <div className={styles.factList}>
                  {result.facts.map((original, index) => {
                    const decision = job.review?.facts.find(
                      (item) => item.factIndex === index,
                    );
                    const fact = reviewedFact(original, decision);
                    const state =
                      decision?.status ??
                      (job.status === 'accepted'
                        ? 'legacy'
                        : job.status === 'rejected'
                          ? 'rejected'
                          : 'pending');
                    const label = {
                      accepted: 'Recorded',
                      pending: 'Needs review',
                      deferred: 'Deferred',
                      rejected: 'Dismissed',
                      legacy: 'Earlier decision unavailable',
                    }[state];
                    const linked = holdings.find(
                      (holding) => holding.id === decision?.holdingId,
                    );
                    return (
                      <article className={styles.factCard} key={index}>
                        <div className={styles.factHeading}>
                          <span>{factTypeLabel(fact.kind)}</span>
                          <Status
                            tone={
                              state === 'accepted'
                                ? 'success'
                                : ['pending', 'deferred'].includes(state)
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {label}
                          </Status>
                        </div>
                        <h4>{fact.investmentName}</h4>
                        <p>{fact.summary}</p>
                        <dl className={styles.factValues}>
                          {fact.kind !== 'news' ? (
                            <div>
                              <dt>Reported amount</dt>
                              <dd>
                                {fact.amount !== null
                                  ? `${fact.currency ?? 'Currency missing'} ${reportedAmountLabel(fact.amount)}`
                                  : 'Not reported'}
                              </dd>
                            </div>
                          ) : null}
                          <div>
                            <dt>Effective date</dt>
                            <dd>{fact.effectiveDate ?? 'Not reported'}</dd>
                          </div>
                          {fact.dueDate ? (
                            <div>
                              <dt>Due date</dt>
                              <dd>{fact.dueDate}</dd>
                            </div>
                          ) : null}
                        </dl>
                        {decision?.rationale ? (
                          <p className={styles.decisionNote}>
                            <strong>
                              {state === 'deferred'
                                ? 'Still to resolve'
                                : 'Decision note'}
                              :
                            </strong>{' '}
                            {decision.rationale}
                          </p>
                        ) : null}
                        <div className={styles.factFooter}>
                          <details>
                            <summary>
                              Source quote · Page {fact.evidence.page}
                            </summary>
                            <blockquote>{fact.evidence.quote}</blockquote>
                          </details>
                          {linked ? (
                            <Link
                              href={
                                '/?view=investments&holding=' +
                                encodeURIComponent(linked.id)
                              }
                              className={buttonVariants({
                                variant: 'link',
                                size: 'sm',
                              })}
                            >
                              Open investment
                              <ArrowUpRight data-icon="inline-end" />
                            </Link>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FileSearch />
                    </EmptyMedia>
                    <EmptyTitle>
                      {result.relevant
                        ? 'No supported facts found'
                        : 'No investment update identified'}
                    </EmptyTitle>
                    <EmptyDescription>
                      {job.status === 'awaiting_review'
                        ? 'Check the original and notes, then close this review or provide a clearer source.'
                        : 'The original and extraction outcome remain available in this record.'}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {result.warnings.length ? (
                <details className={styles.notes}>
                  <summary>Extraction notes · {result.warnings.length}</summary>
                  <ul>
                    {result.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileText />
                </EmptyMedia>
                <EmptyTitle>
                  {active
                    ? 'Extraction is still in progress'
                    : 'No extraction available'}
                </EmptyTitle>
                <EmptyDescription>
                  {active
                    ? 'Supported facts will appear here when this attempt finishes.'
                    : job.summary?.availability === 'size_limit'
                      ? 'This extraction exceeds the record display limit. Download the original to inspect the source.'
                      : 'The extracted information could not be loaded. Refresh the document or download the original source.'}
                </EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" onClick={() => onTab('activity')}>
                View activity
              </Button>
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="review" keepMounted>
          {result && !active ? (
            result.facts.length ? (
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
                  <EmptyTitle>No fact decisions to make</EmptyTitle>
                  <EmptyDescription>
                    Check the original and extraction notes before closing this
                    review.
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
            )
          ) : loadingResult ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {active
                    ? 'Review follows extraction'
                    : 'No extraction available to review'}
                </EmptyTitle>
                <EmptyDescription>
                  {active
                    ? 'Fact decisions become available once the document has been read.'
                    : 'Refresh the document or inspect the original source before making a decision.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="activity" keepMounted>
          <div className={styles.sectionIntro}>
            <div>
              <h3>Document history</h3>
              <p>
                Recorded events for this source and its latest extraction
                attempt.
              </p>
            </div>
          </div>
          <ol className={styles.history}>
            <HistoryItem
              title="Source received"
              at={job.createdAt}
              description={
                job.source?.displayName ?? 'Document added to this office'
              }
            />
            <HistoryItem
              title={
                job.status === 'queued'
                  ? 'Waiting for extraction'
                  : 'Extraction started'
              }
              at={job.timing?.startedAt}
              description={
                job.timing?.startedAt
                  ? `${job.mode === 'agentic' ? 'Agentic' : 'Classical workflow'} · ${job.engine?.model ?? 'Recorded engine'}`
                  : active
                    ? documentNextStep(job).detail
                    : 'A start time was not recorded for this older attempt.'
              }
              pending={!job.timing?.startedAt}
            />
            {job.timing?.completedAt ? (
              <HistoryItem
                title="Extraction finished"
                at={job.timing.completedAt}
                description={
                  job.timing.processingDurationMs != null
                    ? `${durationLabel(job.timing.processingDurationMs)} processing time · ${counts?.extractedCount ?? 'Unknown'} supported ${counts?.extractedCount === 1 ? 'fact' : 'facts'}`
                    : 'Completion recorded; processing duration unavailable.'
                }
              />
            ) : null}
            {job.timing?.failedAt ? (
              <HistoryItem
                title="Extraction failed"
                at={job.timing.failedAt}
                description={issue}
              />
            ) : null}
            {(job.review?.history ?? []).slice(-20).map((revision) => (
              <HistoryItem
                key={revision.revision}
                title={`Review saved · revision ${revision.revision}`}
                at={revision.at}
                description={revision.decisions
                  .map(
                    (decision) =>
                      `Fact ${decision.factIndex + 1}: ${decision.status}`,
                  )
                  .join(' · ')}
              />
            ))}
          </ol>
          {(job.review?.history.length ?? 0) > 20 ? (
            <p className="text-xs text-muted-foreground">
              The latest 20 review events are shown. Earlier decisions remain in
              the review history.
            </p>
          ) : null}
          <p className={styles.timingNote}>
            Extraction time measures a recorded worker attempt. Queue waiting
            and later review time are separate. No completion estimate is
            inferred.
          </p>
          {result?.trace.length && !active ? (
            <details className={styles.notes}>
              <summary>Reading steps · {result.trace.length}</summary>
              <ol className={styles.trace}>
                {result.trace.map((step, index) => (
                  <li key={index}>
                    <div>
                      <GitBranch />
                      <strong>{step.stage.replaceAll('_', ' ')}</strong>
                      <Status>{step.status}</Status>
                    </div>
                    <p>{step.detail}</p>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {job.engineLegacy ? (
            <p className={styles.timingNote}>
              This older document did not originally record an engine profile
              for every attempt.
            </p>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function HistoryItem({
  title,
  at,
  description,
  pending = false,
}: {
  title: string;
  at?: string | null;
  description: string;
  pending?: boolean;
}) {
  return (
    <li className={styles.historyItem}>
      <span className={styles.historyIcon}>
        {pending ? <Clock3 /> : <CheckCheck />}
      </span>
      <div>
        <div className={styles.historyHeading}>
          <h4>{title}</h4>
          <time dateTime={at ?? undefined}>{documentTimestamp(at)}</time>
        </div>
        <p>{description}</p>
      </div>
    </li>
  );
}
