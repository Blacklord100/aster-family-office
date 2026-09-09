'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  FileText,
  History,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import type { ReportObligationsResponse } from '@/lib/report-obligations-api';
import type {
  ReportDeliveryStatus,
  ReportEvidenceReference,
  ReportHistoryEntry,
} from '@/lib/report-obligations-contract';
import styles from './obligations.module.css';

export type ObligationsNavigation = {
  onSource: (id: string) => void;
  onReview: (jobId: string) => void;
  onHolding: (id: string) => void;
};
export type ObligationsViewProps = ObligationsNavigation & {
  family: string;
  onFamily: (id: string) => void;
};
export type ObligationsMutation = (
  input: Record<string, unknown>,
) => Promise<boolean>;
export const humanLabel = (value: string) =>
  value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
export const calendarDate = (value: string, timeZone = 'UTC') =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
export const instantLabel = (value: string | null, timeZone = 'UTC') =>
  value
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone,
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : 'No due date';
export const memberName = (
  value: string | null,
  response: ReportObligationsResponse,
) =>
  !value
    ? 'Unassigned'
    : (response.options.members.find((member) => member.userId === value)
        ?.name ?? 'Assigned member');
export const scopeLabel = (
  holdingIds: string[],
  response: ReportObligationsResponse,
) =>
  holdingIds
    .map(
      (id) =>
        response.options.holdings.find((holding) => holding.id === id)?.name ??
        'Holding',
    )
    .join(' · ');
export const reportTypeLabel = (value: string) =>
  value === 'nav_statement' ? 'NAV statement' : humanLabel(value);

/** One visible view owns one request stream. Polls cannot overwrite a mutation or a newer response. */
export function useReportObligations() {
  const [response, setResponse] = useState<ReportObligationsResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const current = useRef<ReportObligationsResponse | null>(null);
  const request = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const retryIdentity = useRef<{ fingerprint: string; key: string } | null>(
    null,
  );
  const mounted = useRef(true);
  const sequence = useRef(0);
  const accept = useCallback((value: ReportObligationsResponse) => {
    current.current = value;
    setResponse(value);
  }, []);
  const refresh = useCallback(async () => {
    if (mutation.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++sequence.current;
    try {
      const result = await fetch('/api/report-obligations', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      const body = await result.json();
      if (!result.ok)
        throw new Error(
          body.message ?? 'Reporting operations could not be loaded.',
        );
      if (mounted.current && version === sequence.current) {
        accept(body);
        setError(null);
      }
    } catch (cause) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        version === sequence.current
      )
        setError(
          cause instanceof Error
            ? cause.message
            : 'Reporting operations could not be loaded.',
        );
    } finally {
      if (mounted.current && version === sequence.current) setLoading(false);
    }
  }, [accept]);
  const cancelRequests = useCallback(() => {
    ++sequence.current;
    request.current?.abort();
  }, []);
  useEffect(() => {
    mounted.current = true;
    const initial = window.setTimeout(() => void refresh(), 0);
    const visibleRefresh = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = window.setInterval(visibleRefresh, 30_000);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => {
      mounted.current = false;
      cancelRequests();
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibleRefresh);
    };
  }, [refresh, cancelRequests]);
  const mutate = useCallback<ObligationsMutation>(
    async (input) => {
      if (!current.current || mutation.current) return false;
      mutation.current = true;
      setBusy(true);
      setError(null);
      request.current?.abort();
      ++sequence.current;
      const controller = new AbortController();
      request.current = controller;
      const payload = {
        ...input,
        expectedRevision: input.expectedRevision ?? current.current.revision,
      };
      const fingerprint = JSON.stringify(payload);
      if (retryIdentity.current?.fingerprint !== fingerprint)
        retryIdentity.current = { fingerprint, key: crypto.randomUUID() };
      const idempotencyKey = retryIdentity.current.key;
      try {
        const result = await fetch('/api/report-obligations', {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, idempotencyKey }),
        });
        const body = await result.json();
        if (!result.ok)
          throw new Error(body.message ?? 'The change could not be saved.');
        retryIdentity.current = null;
        if (mounted.current) accept(body);
        return true;
      } catch (cause) {
        if (mounted.current && !controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'The change could not be saved.',
          );
        return false;
      } finally {
        mutation.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [accept],
  );
  return { response, error, loading, busy, refresh, mutate };
}

export function OperationsFeedback({
  loading,
  error,
  response,
  refresh,
}: {
  loading: boolean;
  error: string | null;
  response: ReportObligationsResponse | null;
  refresh: () => Promise<void>;
}) {
  return (
    <>
      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Unable to complete this request</AlertTitle>
          <AlertDescription>
            {error}
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              <RefreshCw data-icon="inline-start" />
              Refresh current state
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {loading && !response ? (
        <div
          className={styles.loading}
          aria-label="Loading reporting operations"
        >
          <Skeleton className={styles.skeleton} />
          <Skeleton className={styles.skeleton} />
        </div>
      ) : null}
      {response?.coverage.truncated ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>Processing coverage is incomplete</AlertTitle>
          <AlertDescription>
            {response.coverage.jobsScanned} of {response.coverage.totalJobs}{' '}
            source documents were evaluated. The visible queue is not a complete
            statement of reporting coverage.
          </AlertDescription>
        </Alert>
      ) : null}
      {response &&
      (response.monitor.status === 'delayed' ||
        response.monitor.status === 'error') ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>Background monitoring needs attention</AlertTitle>
          <AlertDescription>
            This page was evaluated on refresh. Unattended reporting updates
            need the background worker to recover; ask your operator to check
            it.
          </AlertDescription>
        </Alert>
      ) : null}
      {response && !response.canWrite ? (
        <p className={styles.note}>
          Read-only access. You can inspect reporting obligations, evidence and
          history within your permitted families.
        </p>
      ) : null}
    </>
  );
}
export function OperationsEmpty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Empty className={styles.empty}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileText />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children}
    </Empty>
  );
}
export function OperationsSearch({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <InputGroup className={styles.search}>
      <InputGroupInput
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
    </InputGroup>
  );
}
export function DeliveryBadge({ status }: { status: ReportDeliveryStatus }) {
  return (
    <Badge
      variant={
        status === 'overdue'
          ? 'destructive'
          : status === 'received' || status === 'received_late'
            ? 'secondary'
            : 'outline'
      }
    >
      {humanLabel(status)}
    </Badge>
  );
}
export function OwnerLabel({
  userId,
  response,
}: {
  userId: string | null;
  response: ReportObligationsResponse;
}) {
  const name = memberName(userId, response);
  return (
    <span className={styles.owner}>
      <span className={styles.avatar} aria-hidden="true">
        {userId
          ? name
              .split(' ')
              .slice(0, 2)
              .map((part) => part[0])
              .join('')
          : '—'}
      </span>
      <span>{name}</span>
    </span>
  );
}
export function OperationHistory({
  history,
  response,
}: {
  history: ReportHistoryEntry[];
  response: ReportObligationsResponse;
}) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        <History />
        Activity history
      </h3>
      {history.length ? (
        <ol className={styles.history}>
          {[...history].reverse().map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <strong>
                {humanLabel(entry.action)} ·{' '}
                {entry.actorUserId === 'system' ||
                entry.actorUserId.startsWith('system:')
                  ? 'System'
                  : memberName(entry.actorUserId, response)}
              </strong>
              {entry.reason ? <p>{entry.reason}</p> : null}
              <time dateTime={entry.at}>{instantLabel(entry.at)} UTC</time>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.note}>
          Activity appears here as this item changes.
        </p>
      )}
    </section>
  );
}
export function EvidenceLinks({
  evidence,
  response,
  onSource,
  onReview,
  onHolding,
}: ObligationsNavigation & {
  evidence: ReportEvidenceReference[];
  response: ReportObligationsResponse;
}) {
  return (
    <div className={styles.section}>
      {evidence.map((item, index) => {
        const source =
          item.kind === 'document'
            ? response.options.documents.find((entry) => entry.id === item.id)
            : null;
        const jobId = source?.jobId;
        return (
          <div
            className={styles.source}
            key={`${item.kind}-${item.id}-${index}`}
          >
            <div className={styles.sourceTitle}>
              <FileText />
              <span>
                {source?.filename ?? item.label ?? humanLabel(item.kind)}
              </span>
            </div>
            <div className={styles.actions}>
              {item.kind === 'document' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onSource(item.id)}
                >
                  Open original
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              ) : item.kind === 'holding' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onHolding(item.id)}
                >
                  Open holding
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              ) : item.kind === 'review' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onReview(item.id)}
                >
                  Open review
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              ) : null}
              {jobId ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onReview(jobId)}
                >
                  Review extracted facts
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
