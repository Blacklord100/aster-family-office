'use client';

import { useMemo, useState } from 'react';
import {
  CalendarDays,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock3,
  List,
  Plus,
  RefreshCw,
  Settings2,
  TimerOff,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type {
  ReportOccurrence,
  ReportSchedule,
} from '@/lib/report-obligations-contract';
import type { ReportObligationsResponse } from '@/lib/report-obligations-api';
import {
  reportLocalDate,
  summarizeReportOccurrence,
} from '@/lib/report-obligations';
import { cn } from '@/lib/utils';
import { ObligationDetail } from './obligation-detail';
import { ScheduleDialog } from './obligations-forms';
import {
  DeliveryBadge,
  humanLabel,
  instantLabel,
  memberName,
  OperationsEmpty,
  OperationsFeedback,
  OperationsSearch,
  OwnerLabel,
  reportTypeLabel,
  scopeLabel,
  useReportObligations,
  type ObligationsViewProps,
} from './obligations-shared';
import { dateLabel, FamilyPicker, PageHeading, Picker } from './primitives';
import styles from './obligations.module.css';

const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthLabel = (month: string) =>
  new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
function shiftedMonth(month: string, count: number) {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 7);
}

function OccurrenceList({
  items,
  response,
  onSelect,
}: {
  items: ReportOccurrence[];
  response: ReportObligationsResponse;
  onSelect: (id: string) => void;
}) {
  const [limit, setLimit] = useState(60);
  return (
    <>
      <div className={styles.listHeader} aria-hidden="true">
        <span>Expected report</span>
        <span>Delivery</span>
        <span>Owner</span>
        <span>Due date</span>
      </div>
      {items.length ? (
        items.slice(0, limit).map((item) => {
          const summary = summarizeReportOccurrence(item, response.asOf);
          return (
            <button
              key={item.id}
              className={styles.listRow}
              onClick={() => onSelect(item.id)}
            >
              <div className={styles.rowTitle}>
                <span className={styles.rowIcon}>
                  <CalendarDays />
                </span>
                <div className={styles.rowText}>
                  <strong>{item.name}</strong>
                  <small>{scopeLabel(item.holdingIds, response)}</small>
                  <small>
                    {dateLabel(item.periodStart)} – {dateLabel(item.periodEnd)}
                  </small>
                </div>
              </div>
              <div className={styles.rowCell}>
                <DeliveryBadge status={summary.deliveryStatus} />
                <small>
                  {summary.failedCount
                    ? `${summary.failedCount} unreadable`
                    : summary.pendingCount
                      ? `${summary.pendingCount} pending review`
                      : summary.acceptedCount
                        ? 'Review accepted'
                        : 'No accepted report'}
                </small>
              </div>
              <div className={styles.rowCell}>
                <OwnerLabel userId={item.ownerUserId} response={response} />
              </div>
              <div className={styles.rowCell}>
                <span>
                  {dateLabel(reportLocalDate(item.dueAt, item.timezone))}
                </span>
                <small>
                  {item.dueLocalTime} · {item.timezone}
                </small>
              </div>
            </button>
          );
        })
      ) : (
        <OperationsEmpty
          title="No reports in this view"
          description="Adjust the filters or month to see other reporting obligations."
        />
      )}
      {items.length > limit ? (
        <div className={styles.surfaceHeading}>
          <span className={styles.note}>
            Showing {limit} of {items.length} obligations
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
    </>
  );
}

function MonthCalendar({
  month,
  items,
  response,
  onSelect,
  onDay,
}: {
  month: string;
  items: ReportOccurrence[];
  response: ReportObligationsResponse;
  onSelect: (id: string) => void;
  onDay: (date: string) => void;
}) {
  const days = useMemo(() => {
    const first = new Date(`${month}-01T12:00:00Z`);
    const offset = (first.getUTCDay() + 6) % 7;
    first.setUTCDate(1 - offset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(first);
      date.setUTCDate(first.getUTCDate() + index);
      return date.toISOString().slice(0, 10);
    });
  }, [month]);
  const byDay = useMemo(() => {
    const grouped = new Map<string, ReportOccurrence[]>();
    for (const item of items) {
      const date = reportLocalDate(item.dueAt, item.timezone);
      const entries = grouped.get(date) ?? [];
      entries.push(item);
      grouped.set(date, entries);
    }
    return grouped;
  }, [items]);
  const today = response.asOf.slice(0, 10);
  return (
    <div className={styles.desktopCalendar}>
      <div className={styles.weekdays} aria-hidden="true">
        {weekdayNames.map((name) => (
          <div key={name}>{name}</div>
        ))}
      </div>
      <div
        className={styles.calendar}
        aria-label={`Reporting deadlines in ${monthLabel(month)}`}
      >
        {days.map((date) => {
          const events = byDay.get(date) ?? [];
          return (
            <div
              key={date}
              className={cn(
                styles.day,
                !date.startsWith(month) && styles.outside,
              )}
            >
              <time
                dateTime={date}
                className={cn(styles.dayNumber, today === date && styles.today)}
                aria-label={dateLabel(date)}
              >
                {Number(date.slice(-2))}
              </time>
              {events.slice(0, 3).map((item) => {
                const status = summarizeReportOccurrence(
                  item,
                  response.asOf,
                ).deliveryStatus;
                return (
                  <button
                    key={item.id}
                    className={cn(
                      styles.calendarEvent,
                      status === 'overdue' && styles.overdue,
                      status.startsWith('received') && styles.delivered,
                      (status === 'cancelled' || status === 'waived') &&
                        styles.closed,
                    )}
                    onClick={() => onSelect(item.id)}
                    aria-label={`${item.name}, due ${dateLabel(date)}, ${humanLabel(status)}`}
                  >
                    <strong>{item.name}</strong>
                    <span>
                      {item.dueLocalTime} · {humanLabel(status)}
                    </span>
                  </button>
                );
              })}
              {events.length > 3 ? (
                <button className={styles.more} onClick={() => onDay(date)}>
                  +{events.length - 3} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScheduleCards({
  schedules,
  response,
  onEdit,
}: {
  schedules: ReportSchedule[];
  response: ReportObligationsResponse;
  onEdit: (schedule: ReportSchedule) => void;
}) {
  const [limit, setLimit] = useState(40);
  return (
    <>
      <div className={styles.scheduleCards}>
        {schedules.slice(0, limit).map((schedule) => {
          const version = schedule.versions.at(-1)!;
          const definition = version.definition;
          return (
            <article className={styles.scheduleCard} key={schedule.id}>
              <div className={styles.between}>
                <Badge
                  variant={
                    version.status === 'active' ? 'secondary' : 'outline'
                  }
                >
                  {humanLabel(version.status)}
                </Badge>
                <span className={styles.note}>Version {version.version}</span>
              </div>
              <div>
                <h3>{definition.name}</h3>
                <p className={styles.note}>
                  {scopeLabel(definition.holdingIds, response)}
                </p>
              </div>
              <dl className={styles.details}>
                <div>
                  <dt>Cadence</dt>
                  <dd>
                    {humanLabel(definition.cadence)} ·{' '}
                    {reportTypeLabel(definition.reportType)}
                  </dd>
                </div>
                <div>
                  <dt>Due rule</dt>
                  <dd>
                    {definition.dueDaysAfterPeriodEnd} days after period end
                  </dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>
                    <OwnerLabel
                      userId={definition.ownerUserId}
                      response={response}
                    />
                  </dd>
                </div>
                <div>
                  <dt>Due time</dt>
                  <dd>
                    {definition.dueLocalTime}
                    <br />
                    <span className={styles.note}>{definition.timezone}</span>
                  </dd>
                </div>
                <div>
                  <dt>Disclosure age limit</dt>
                  <dd>
                    {definition.staleAfterDays
                      ? `${definition.staleAfterDays} days`
                      : 'Not configured'}
                  </dd>
                </div>
                <div>
                  <dt>Version effective from</dt>
                  <dd>{dateLabel(version.effectiveFrom)}</dd>
                </div>
              </dl>
              <div className={styles.between}>
                <span className={styles.note}>
                  {definition.graceHours} hours of grace
                </span>
                {response.canAdmin ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onEdit(schedule)}
                  >
                    <Settings2 data-icon="inline-start" />
                    Edit schedule
                  </Button>
                ) : null}
              </div>
              <details>
                <summary className={styles.note}>
                  View schedule versions ({schedule.versions.length})
                </summary>
                <ol className={styles.history}>
                  {[...schedule.versions].reverse().map((entry) => (
                    <li key={entry.id}>
                      <strong>
                        Version {entry.version} · {humanLabel(entry.status)} ·
                        from {dateLabel(entry.effectiveFrom)}
                      </strong>
                      <p>{entry.reason}</p>
                      <time dateTime={entry.createdAt}>
                        {instantLabel(entry.createdAt)} UTC ·{' '}
                        {memberName(entry.createdBy, response)}
                      </time>
                    </li>
                  ))}
                </ol>
              </details>
            </article>
          );
        })}
      </div>
      {schedules.length > limit ? (
        <Button
          variant="outline"
          onClick={() => setLimit((value) => value + 40)}
        >
          Show more schedules
        </Button>
      ) : null}
    </>
  );
}

export function ReportingCalendarView({
  family,
  onFamily,
  onSource,
  onReview,
  onHolding,
}: ObligationsViewProps) {
  const { response, error, loading, busy, refresh, mutate } =
    useReportObligations();
  const [tab, setTab] = useState('calendar');
  const [layout, setLayout] = useState('month');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [owner, setOwner] = useState('all');
  const [selectedDate, setSelectedDate] = useState('');
  const [selected, setSelected] = useState('');
  const [editor, setEditor] = useState<ReportSchedule | 'new' | null>(null);
  const scoped = useMemo(
    () =>
      response?.state.occurrences.filter(
        (item) => family === 'all' || item.familyIds.includes(family),
      ) ?? [],
    [response, family],
  );
  const schedules = useMemo(
    () =>
      response?.state.schedules.filter((item) =>
        item.versions.some(
          (version) =>
            family === 'all' || version.definition.familyIds.includes(family),
        ),
      ) ?? [],
    [response, family],
  );
  const stats = useMemo(() => {
    const values = { overdue: 0, upcoming: 0, received: 0, pending: 0 };
    if (!response) return values;
    const soon = Date.parse(response.asOf) + 30 * 86_400_000;
    for (const item of scoped) {
      const summary = summarizeReportOccurrence(item, response.asOf);
      if (summary.deliveryStatus === 'overdue') values.overdue++;
      if (
        (summary.deliveryStatus === 'upcoming' ||
          summary.deliveryStatus === 'due') &&
        Date.parse(item.dueAt) <= soon
      )
        values.upcoming++;
      if (summary.deliveryStatus.startsWith('received')) values.received++;
      if (summary.pendingCount || summary.failedCount || summary.rejectedCount)
        values.pending++;
    }
    return values;
  }, [response, scoped]);
  const filtered = useMemo(
    () =>
      !response
        ? []
        : scoped
            .filter((item) => {
              const delivery = summarizeReportOccurrence(
                item,
                response.asOf,
              ).deliveryStatus;
              const date = reportLocalDate(item.dueAt, item.timezone);
              return (
                date.startsWith(month) &&
                (status === 'all' ||
                  (status === 'received' && delivery.startsWith('received')) ||
                  status === delivery) &&
                (owner === 'all' || owner === item.ownerUserId) &&
                `${item.name} ${scopeLabel(item.holdingIds, response)} ${item.reportType}`
                  .toLowerCase()
                  .includes(query.toLowerCase())
              );
            })
            .sort((left, right) => left.dueAt.localeCompare(right.dueAt)),
    [response, scoped, month, status, owner, query],
  );
  const active = response?.state.occurrences.find(
    (item) => item.id === selected,
  );
  const editSchedule =
    editor && editor !== 'new'
      ? (response?.state.schedules.find(
          (schedule) => schedule.id === editor.id,
        ) ?? editor)
      : null;
  return (
    <div className={styles.root}>
      <PageHeading
        title="Reporting calendar"
        subtitle="Every expected report. A clear owner. Nothing quietly missed."
      >
        <FamilyPicker value={family} onChange={onFamily} />
        <Button
          variant="outline"
          size="sm"
          aria-label="Refresh reporting calendar"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
        {response?.canAdmin ? (
          <Button size="sm" onClick={() => setEditor('new')}>
            <Plus data-icon="inline-start" />
            New schedule
          </Button>
        ) : null}
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
                <TimerOff />
                Overdue reports
              </span>
              <strong className={styles.metricValue}>{stats.overdue}</strong>
              <span className={styles.metricNote}>
                Past their configured grace period
              </span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>
                <CalendarDays />
                Due in 30 days
              </span>
              <strong className={styles.metricValue}>{stats.upcoming}</strong>
              <span className={styles.metricNote}>
                Open reporting obligations
              </span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>
                <CheckCheck />
                Received
              </span>
              <strong className={styles.metricValue}>{stats.received}</strong>
              <span className={styles.metricNote}>
                A confirmed report match exists
              </span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>
                <Clock3 />
                Review outstanding
              </span>
              <strong className={styles.metricValue}>{stats.pending}</strong>
              <span className={styles.metricNote}>
                Received does not mean accepted
              </span>
            </div>
          </div>
          <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
            <TabsList variant="line">
              <TabsTrigger value="calendar">Calendar</TabsTrigger>
              <TabsTrigger value="schedules">
                Schedules <Badge variant="secondary">{schedules.length}</Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {!schedules.length && !scoped.length ? (
            <div className={styles.surface}>
              <OperationsEmpty
                title="Give every report a place on the calendar"
                description="Add a manager or holding’s reporting agreement. A missed deadline then creates one assigned exception, and a confirmed receipt updates delivery separately from review."
              >
                {response.canAdmin ? (
                  <Button
                    onClick={() => setEditor('new')}
                    disabled={!response.options.holdings.length}
                  >
                    <Plus data-icon="inline-start" />
                    Create your first schedule
                  </Button>
                ) : null}
                {!response.options.holdings.length ? (
                  <p className={styles.note}>
                    Register a holding before creating reporting expectations.
                  </p>
                ) : null}
              </OperationsEmpty>
            </div>
          ) : tab === 'schedules' ? (
            <>
              <p className={styles.muted}>
                Versioned expectations keep historical periods intact. Pause a
                future schedule or change its owner, cadence and disclosure
                policy.
              </p>
              <ScheduleCards
                schedules={schedules}
                response={response}
                onEdit={setEditor}
              />
            </>
          ) : (
            <>
              <div className={styles.toolbar}>
                <OperationsSearch
                  value={query}
                  onChange={setQuery}
                  label="Search reporting calendar"
                  placeholder="Find a manager, holding or report…"
                />
                <Picker
                  value={status}
                  onChange={setStatus}
                  label="Delivery status filter"
                  options={[
                    { value: 'all', label: 'All delivery states' },
                    ...[
                      'upcoming',
                      'due',
                      'overdue',
                      'received',
                      'waived',
                      'cancelled',
                    ].map((value) => ({ value, label: humanLabel(value) })),
                  ]}
                />
                <Picker
                  value={owner}
                  onChange={setOwner}
                  label="Reporting owner filter"
                  options={[
                    { value: 'all', label: 'All owners' },
                    ...response.options.members.map((member) => ({
                      value: member.userId,
                      label: member.name,
                    })),
                  ]}
                />
                <span className={styles.filterCount}>
                  {filtered.length}{' '}
                  {filtered.length === 1 ? 'obligation' : 'obligations'}
                </span>
              </div>
              <div className={styles.surface}>
                <div className={styles.surfaceHeading}>
                  <div className={styles.actions}>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Previous month"
                      onClick={() => {
                        setMonth(shiftedMonth(month, -1));
                        setSelectedDate('');
                      }}
                    >
                      <ChevronLeft />
                    </Button>
                    <h2 className={styles.monthHeading}>{monthLabel(month)}</h2>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Next month"
                      onClick={() => {
                        setMonth(shiftedMonth(month, 1));
                        setSelectedDate('');
                      }}
                    >
                      <ChevronRight />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setMonth(response.asOf.slice(0, 7));
                        setSelectedDate('');
                      }}
                    >
                      Today
                    </Button>
                  </div>
                  <ToggleGroup
                    value={[layout]}
                    onValueChange={(value) => {
                      if (value[0]) {
                        setLayout(value[0]);
                        setSelectedDate('');
                      }
                    }}
                    aria-label="Calendar display"
                    size="sm"
                    variant="outline"
                  >
                    <ToggleGroupItem value="month" aria-label="Month view">
                      <CalendarDays data-icon="inline-start" />
                      Month
                    </ToggleGroupItem>
                    <ToggleGroupItem value="agenda" aria-label="Agenda view">
                      <List data-icon="inline-start" />
                      Agenda
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
                {layout === 'month' ? (
                  <>
                    <MonthCalendar
                      month={month}
                      items={filtered}
                      response={response}
                      onSelect={setSelected}
                      onDay={(date) => {
                        setSelectedDate(date);
                        setLayout('agenda');
                      }}
                    />
                    <div className={styles.mobileAgenda}>
                      <OccurrenceList
                        items={filtered}
                        response={response}
                        onSelect={setSelected}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    {selectedDate ? (
                      <div className={styles.surfaceHeading}>
                        <p className={styles.muted}>
                          Due {dateLabel(selectedDate)}
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelectedDate('')}
                        >
                          Show entire month
                        </Button>
                      </div>
                    ) : null}
                    <OccurrenceList
                      items={
                        selectedDate
                          ? filtered.filter(
                              (item) =>
                                reportLocalDate(item.dueAt, item.timezone) ===
                                selectedDate,
                            )
                          : filtered
                      }
                      response={response}
                      onSelect={setSelected}
                    />
                  </>
                )}
              </div>
              <p className={styles.note}>
                Deadlines use each schedule’s local date and timezone. Periods
                appear when they begin. Arrival means import into Aster, rather
                than the sender’s email date; review and disclosure age remain
                separate. Refreshed {instantLabel(response.asOf)} UTC.
              </p>
            </>
          )}
        </>
      ) : null}
      {response && active ? (
        <ObligationDetail
          key={active.id}
          occurrence={active}
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
      {response && editor ? (
        <ScheduleDialog
          key={editor === 'new' ? 'new' : editor.id}
          schedule={editSchedule}
          response={response}
          busy={busy}
          mutationError={error}
          mutate={mutate}
          onClose={() => setEditor(null)}
          family={family}
        />
      ) : null}
    </div>
  );
}
