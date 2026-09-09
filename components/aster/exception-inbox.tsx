'use client';

import { useMemo, useState } from 'react';
import {
  AlarmClock,
  ArrowUp,
  ArrowUpRight,
  CheckCheck,
  CircleAlert,
  Flag,
  Inbox,
  RefreshCw,
  ShieldAlert,
  UserRound,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ReportObligationsResponse } from '@/lib/report-obligations-api';
import {
  REPORT_EXCEPTION_CATEGORIES,
  REPORT_EXCEPTION_PRIORITIES,
  type ReportException,
  type ReportExceptionAction,
} from '@/lib/report-obligations-contract';
import { cn } from '@/lib/utils';
import { ObligationDetail } from './obligation-detail';
import { ExceptionActionDialog } from './obligations-forms';
import {
  EvidenceLinks,
  humanLabel,
  instantLabel,
  OperationHistory,
  OperationsEmpty,
  OperationsFeedback,
  OperationsSearch,
  OwnerLabel,
  scopeLabel,
  useReportObligations,
  type ObligationsMutation,
  type ObligationsNavigation,
  type ObligationsViewProps,
} from './obligations-shared';
import { FamilyPicker, PageHeading, Picker } from './primitives';
import { useWorkspace } from './workspace-context';
import styles from './obligations.module.css';

const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
function Priority({ value }: { value: ReportException['priority'] }) {
  return (
    <span
      className={cn(
        styles.priority,
        (value === 'urgent' || value === 'high') && styles.highPriority,
      )}
    >
      <ArrowUp />
      {humanLabel(value)}
    </span>
  );
}

function ExceptionDetail({
  issue,
  response,
  busy,
  mutate,
  error,
  onClose,
  onSource,
  onReview,
  onHolding,
}: ObligationsNavigation & {
  issue: ReportException;
  response: ReportObligationsResponse;
  busy: boolean;
  mutate: ObligationsMutation;
  error: string | null;
  onClose: () => void;
}) {
  const [action, setAction] = useState<ReportExceptionAction['action'] | null>(
    null,
  );
  const [showOccurrence, setShowOccurrence] = useState(false);
  const occurrence = response.state.occurrences.find(
    (item) => item.id === issue.occurrenceId,
  );
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <SheetContent className={styles.sheet}>
        <SheetHeader className={styles.sheetHeader}>
          <div className={styles.statusLine}>
            <Badge
              variant={issue.status === 'open' ? 'destructive' : 'outline'}
            >
              {humanLabel(issue.status)}
            </Badge>
            <Badge variant="outline">{humanLabel(issue.category)}</Badge>
            <Priority value={issue.priority} />
          </div>
          <SheetTitle className={styles.sheetTitle}>{issue.title}</SheetTitle>
          <SheetDescription>
            {scopeLabel(issue.holdingIds, response) ||
              'Office reporting operations'}
          </SheetDescription>
        </SheetHeader>
        <div className={styles.sheetBody}>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <p className={styles.muted}>{issue.description}</p>
          <dl className={styles.details}>
            <div>
              <dt>Assignee</dt>
              <dd>
                <OwnerLabel userId={issue.assigneeUserId} response={response} />
              </dd>
            </div>
            <div>
              <dt>Due date</dt>
              <dd>
                {instantLabel(issue.dueAt)}
                {issue.dueAt ? <span className={styles.note}> UTC</span> : null}
              </dd>
            </div>
            <div>
              <dt>Underlying condition</dt>
              <dd>
                {issue.sourceActive ? 'Still present' : 'No longer detected'}
              </dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>{instantLabel(issue.updatedAt)} UTC</dd>
            </div>
            {issue.snoozedUntil ? (
              <div className={styles.wide}>
                <dt>Returns to open queue</dt>
                <dd>{instantLabel(issue.snoozedUntil)} UTC</dd>
              </div>
            ) : null}
          </dl>
          {(issue.status === 'waived' ||
            issue.status === 'resolved' ||
            issue.status === 'snoozed') &&
          issue.sourceActive ? (
            <Alert>
              <ShieldAlert />
              <AlertDescription>
                The underlying gap is still present. This{' '}
                {issue.status === 'snoozed' ? 'snooze' : 'disposition'} remains
                visible and does not indicate that reporting or financial review
                is complete.
              </AlertDescription>
            </Alert>
          ) : null}
          {response.canWrite ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Manage exception</h3>
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setAction('assign')}
                >
                  <UserRound data-icon="inline-start" />
                  Assign
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setAction('priority')}
                >
                  <Flag data-icon="inline-start" />
                  Priority
                </Button>
                {issue.status === 'open' || issue.status === 'snoozed' ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setAction('snooze')}
                    >
                      <AlarmClock data-icon="inline-start" />
                      Snooze
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => setAction('resolve')}
                    >
                      <CheckCheck data-icon="inline-start" />
                      Resolve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setAction('waive')}
                    >
                      Waive
                    </Button>
                    {issue.status === 'snoozed' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setAction('reopen')}
                      >
                        Wake now
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setAction('reopen')}
                  >
                    Reopen
                  </Button>
                )}
              </div>
              <p className={styles.note}>
                Every change requires a reason and records the actor, time and
                supporting evidence.
              </p>
            </section>
          ) : null}
          {occurrence ? (
            <section className={styles.source}>
              <h3 className={styles.sectionTitle}>
                Linked reporting obligation
              </h3>
              <p className={styles.muted}>{occurrence.name}</p>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowOccurrence(true)}
                >
                  Open reporting period
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              </div>
            </section>
          ) : null}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Supporting evidence</h3>
            {issue.evidence.length ? (
              <EvidenceLinks
                evidence={issue.evidence}
                response={response}
                onSource={onSource}
                onReview={onReview}
                onHolding={onHolding}
              />
            ) : (
              <p className={styles.muted}>
                No source has been attached yet. The reporting expectation and
                its history remain available above.
              </p>
            )}
          </section>
          <OperationHistory history={issue.history} response={response} />
        </div>
        {action ? (
          <ExceptionActionDialog
            key={action}
            issue={issue}
            action={action}
            response={response}
            busy={busy}
            mutationError={error}
            mutate={mutate}
            onClose={() => setAction(null)}
          />
        ) : null}
        {showOccurrence && occurrence ? (
          <ObligationDetail
            occurrence={occurrence}
            response={response}
            busy={busy}
            mutate={mutate}
            error={error}
            onClose={() => setShowOccurrence(false)}
            onSource={onSource}
            onReview={onReview}
            onHolding={onHolding}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export function ExceptionInboxView({
  family,
  onFamily,
  onSource,
  onReview,
  onHolding,
}: ObligationsViewProps) {
  const { response, error, loading, busy, refresh, mutate } =
    useReportObligations();
  const { state: workspace } = useWorkspace();
  const [tab, setTab] = useState('open');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [priority, setPriority] = useState('all');
  const [due, setDue] = useState('all');
  const [owner, setOwner] = useState('all');
  const [holding, setHolding] = useState('all');
  const [selected, setSelected] = useState('');
  const [limit, setLimit] = useState(60);
  const scoped = useMemo(
    () =>
      response?.state.exceptions.filter(
        (issue) => family === 'all' || issue.familyIds.includes(family),
      ) ?? [],
    [response, family],
  );
  const stats = useMemo(
    () => ({
      open: scoped.filter((issue) => issue.status === 'open').length,
      snoozed: scoped.filter((issue) => issue.status === 'snoozed').length,
      urgent: scoped.filter(
        (issue) =>
          issue.status === 'open' &&
          (issue.priority === 'urgent' || issue.priority === 'high'),
      ).length,
      unassigned: scoped.filter(
        (issue) => issue.status === 'open' && !issue.assigneeUserId,
      ).length,
      closed: scoped.filter(
        (issue) => issue.status === 'resolved' || issue.status === 'waived',
      ).length,
    }),
    [scoped],
  );
  const items = useMemo(
    () =>
      !response
        ? []
        : scoped
            .filter(
              (issue) =>
                (tab === 'all' ||
                  (tab === 'closed' &&
                    (issue.status === 'resolved' ||
                      issue.status === 'waived')) ||
                  tab === issue.status) &&
                (category === 'all' || issue.category === category) &&
                (priority === 'all' || issue.priority === priority) &&
                (due === 'all' ||
                  (due === 'none' && !issue.dueAt) ||
                  (due === 'overdue' &&
                    issue.dueAt !== null &&
                    Date.parse(issue.dueAt) < Date.parse(response.asOf)) ||
                  (due === 'week' &&
                    issue.dueAt !== null &&
                    Date.parse(issue.dueAt) >= Date.parse(response.asOf) &&
                    Date.parse(issue.dueAt) <=
                      Date.parse(response.asOf) + 7 * 86_400_000)) &&
                (holding === 'all' || issue.holdingIds.includes(holding)) &&
                (owner === 'all' ||
                  (owner === 'unassigned' && !issue.assigneeUserId) ||
                  owner === issue.assigneeUserId) &&
                `${issue.title} ${issue.description} ${scopeLabel(issue.holdingIds, response)} ${response.options.holdings
                  .filter((item) => issue.holdingIds.includes(item.id))
                  .map((item) => item.manager)
                  .join(' ')} ${humanLabel(issue.category)}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
            )
            .sort(
              (left, right) =>
                priorityOrder[left.priority] - priorityOrder[right.priority] ||
                (left.dueAt ?? '9999').localeCompare(right.dueAt ?? '9999') ||
                right.updatedAt.localeCompare(left.updatedAt),
            ),
    [scoped, response, tab, category, priority, due, holding, owner, query],
  );
  const active = response?.state.exceptions.find(
    (issue) => issue.id === selected,
  );
  const userId = workspace.identity?.user.id;
  return (
    <div className={styles.root}>
      <PageHeading
        title="Exceptions"
        subtitle="One place for the reporting gaps that need a decision."
      >
        <FamilyPicker value={family} onChange={onFamily} />
        <Button
          variant="outline"
          size="sm"
          aria-label="Refresh exceptions"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
      </PageHeading>
      <OperationsFeedback
        response={response}
        error={error}
        loading={loading}
        refresh={refresh}
      />
      {response ? (
        <>
          <div className={styles.metrics}>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>
                <Inbox />
                Open exceptions
              </span>
              <strong className={styles.metricValue}>{stats.open}</strong>
              <span className={styles.metricNote}>
                Ready for an owner’s decision
              </span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>
                <CircleAlert />
                High priority
              </span>
              <strong className={styles.metricValue}>{stats.urgent}</strong>
              <span className={styles.metricNote}>
                High and urgent, currently open
              </span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>
                <AlarmClock />
                Snoozed
              </span>
              <strong className={styles.metricValue}>{stats.snoozed}</strong>
              <span className={styles.metricNote}>
                Wake dates keep follow-up visible
              </span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>
                <UserRound />
                Unassigned
              </span>
              <strong className={styles.metricValue}>{stats.unassigned}</strong>
              <span className={styles.metricNote}>
                Open items without an owner
              </span>
            </div>
          </div>
          <div className={styles.between}>
            <Tabs
              value={tab}
              onValueChange={(value) => {
                setTab(String(value));
                setLimit(60);
              }}
            >
              <TabsList variant="line">
                <TabsTrigger value="open">
                  Open <Badge variant="secondary">{stats.open}</Badge>
                </TabsTrigger>
                <TabsTrigger value="snoozed">Snoozed</TabsTrigger>
                <TabsTrigger value="closed">Resolved & waived</TabsTrigger>
                <TabsTrigger value="all">All</TabsTrigger>
              </TabsList>
            </Tabs>
            {userId ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOwner(owner === userId ? 'all' : userId)}
              >
                {owner === userId ? 'Show everyone’s work' : 'Assigned to me'}
              </Button>
            ) : null}
          </div>
          <div className={styles.toolbar}>
            <OperationsSearch
              value={query}
              onChange={setQuery}
              label="Search exceptions"
              placeholder="Search gaps, managers or holdings…"
            />
            <Picker
              value={category}
              onChange={setCategory}
              label="Exception category filter"
              options={[
                { value: 'all', label: 'All categories' },
                ...REPORT_EXCEPTION_CATEGORIES.map((value) => ({
                  value,
                  label: humanLabel(value),
                })),
              ]}
            />
            <Picker
              value={priority}
              onChange={setPriority}
              label="Exception priority filter"
              options={[
                { value: 'all', label: 'All priorities' },
                ...REPORT_EXCEPTION_PRIORITIES.map((value) => ({
                  value,
                  label: humanLabel(value),
                })),
              ]}
            />
            <Picker
              value={owner}
              onChange={setOwner}
              label="Exception assignee filter"
              options={[
                { value: 'all', label: 'All assignees' },
                { value: 'unassigned', label: 'Unassigned' },
                ...response.options.members.map((member) => ({
                  value: member.userId,
                  label: member.name,
                })),
              ]}
            />
            <Picker
              value={holding}
              onChange={setHolding}
              label="Exception holding filter"
              options={[
                { value: 'all', label: 'All holdings' },
                ...response.options.holdings
                  .filter(
                    (item) => family === 'all' || item.familyId === family,
                  )
                  .map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
            <Picker
              value={due}
              onChange={setDue}
              label="Exception due date filter"
              options={[
                { value: 'all', label: 'All due dates' },
                { value: 'overdue', label: 'Overdue' },
                { value: 'week', label: 'Due next 7 days' },
                { value: 'none', label: 'No due date' },
              ]}
            />
            <span className={styles.filterCount}>
              {items.length} {items.length === 1 ? 'exception' : 'exceptions'}
            </span>
          </div>
          <div className={styles.surface}>
            <div
              className={cn(styles.listHeader, styles.issueHeader)}
              aria-hidden="true"
            >
              <span>Issue and scope</span>
              <span>Status</span>
              <span>Assignee</span>
              <span>Due date · UTC</span>
            </div>
            {items.length ? (
              items.slice(0, limit).map((issue) => (
                <button
                  key={issue.id}
                  className={cn(styles.listRow, styles.issueRow)}
                  onClick={() => setSelected(issue.id)}
                >
                  <div className={styles.rowTitle}>
                    <span className={styles.rowIcon}>
                      {issue.category === 'missing_report' ||
                      issue.category === 'late_report' ? (
                        <AlarmClock />
                      ) : (
                        <CircleAlert />
                      )}
                    </span>
                    <div className={styles.rowText}>
                      <strong>{issue.title}</strong>
                      <small>
                        {scopeLabel(issue.holdingIds, response) ||
                          humanLabel(issue.category)}
                      </small>
                      <small>{humanLabel(issue.category)}</small>
                    </div>
                  </div>
                  <div className={styles.rowCell}>
                    <Badge
                      variant={
                        issue.status === 'open' &&
                        (issue.priority === 'high' ||
                          issue.priority === 'urgent')
                          ? 'destructive'
                          : 'outline'
                      }
                    >
                      {humanLabel(issue.status)}
                    </Badge>
                    <Priority value={issue.priority} />
                  </div>
                  <div className={styles.rowCell}>
                    <OwnerLabel
                      userId={issue.assigneeUserId}
                      response={response}
                    />
                  </div>
                  <div className={styles.rowCell}>
                    <span>
                      {issue.dueAt
                        ? new Date(issue.dueAt).toLocaleDateString('en-GB', {
                            timeZone: 'UTC',
                            day: 'numeric',
                            month: 'short',
                          })
                        : '—'}
                    </span>
                    <small>
                      {issue.status === 'snoozed' && issue.snoozedUntil
                        ? `Wakes ${instantLabel(issue.snoozedUntil)}`
                        : issue.sourceActive
                          ? 'Condition present'
                          : 'Condition cleared'}
                    </small>
                  </div>
                </button>
              ))
            ) : (
              <OperationsEmpty
                title={
                  !scoped.length
                    ? 'A clear view of reporting gaps'
                    : 'No exceptions match this view'
                }
                description={
                  !scoped.length
                    ? 'Configured reporting deadlines and imported documents feed this inbox. Missing reports, failed processing and outstanding reviews appear here with evidence and history.'
                    : 'Try a different status or filter. Snoozed and waived issues remain available in their own views.'
                }
              />
            )}
            {items.length > limit ? (
              <div className={styles.surfaceHeading}>
                <span className={styles.note}>
                  Showing {limit} of {items.length} exceptions
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setLimit((value) => value + 60)}
                >
                  Show more
                </Button>
              </div>
            ) : null}
          </div>
          <p className={styles.note}>
            Repeated evaluations update the same issue. Receipt, financial
            review and explicit dispositions keep separate histories. Refreshed{' '}
            {instantLabel(response.asOf)} UTC.
          </p>
        </>
      ) : null}
      {response && active ? (
        <ExceptionDetail
          key={active.id}
          issue={active}
          response={response}
          busy={busy}
          mutate={mutate}
          error={error}
          onClose={() => setSelected('')}
          onSource={onSource}
          onReview={onReview}
          onHolding={onHolding}
        />
      ) : null}
    </div>
  );
}
