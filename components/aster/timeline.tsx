'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  activityDate,
  orderActivity,
  type ActivityDateMode,
  type ActivityDirection,
} from '@/lib/activity-order';
import styles from './investment-history.module.css';
import {
  FileText,
  Wallet,
  ArrowDownToLine,
  Newspaper,
  Clock3,
  ChevronRight,
} from 'lucide-react';
import type { TimelineEvent } from '@/data';
import {
  PageHeading,
  FamilyPicker,
  Picker,
  ViewTabs,
  Status,
  dateLabel,
} from './primitives';
import { useWorkspace } from './workspace-context';
const icons = {
  Valuation: FileText,
  'Capital call': Wallet,
  Distribution: ArrowDownToLine,
  'Manager update': Newspaper,
  'Public news': Newspaper,
  Review: Clock3,
};
export function TimelineList({
  events,
  onSource,
  selectedId,
  compact = false,
  dateMode = 'effective',
  direction = 'newest',
}: {
  events: TimelineEvent[];
  onSource: (id: string) => void;
  selectedId?: string;
  compact?: boolean;
  dateMode?: ActivityDateMode;
  direction?: ActivityDirection;
}) {
  const { data } = useWorkspace();
  if (!events.length)
    return (
      <div className="empty-inline">
        <Clock3 />
        <h3>No events in this view</h3>
        <p>Try another event type or family.</p>
      </div>
    );
  return (
    <div className={compact ? 'timeline-list compact' : 'timeline-list'}>
      {orderActivity(events, dateMode, direction).map((e) => {
        const Icon = icons[e.type];
        const date = activityDate(e, dateMode);
        const sourceAvailable = data.evidence.some(
          (source) => source.id === e.sourceId,
        );
        const fallback = e.dateBasis === 'Receipt date fallback';
        return (
          <button
            key={e.id}
            className={
              'timeline-item ' + (e.sourceId === selectedId ? 'selected' : '')
            }
            onClick={() => sourceAvailable && onSource(e.sourceId)}
            disabled={!sourceAvailable}
          >
            <span className={styles.eventDate}>
              {date ? (
                <time dateTime={date}>{dateLabel(date)}</time>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Effective date not supplied
                </span>
              )}
              <small>
                {dateMode === 'effective'
                  ? 'Imported / recorded ' +
                    dateLabel(e.receivedAt.slice(0, 10))
                  : fallback
                    ? 'Effective date not supplied'
                    : 'Effective ' + dateLabel(e.date)}
              </small>
            </span>
            <span
              className={
                'timeline-symbol ' +
                (e.type === 'Capital call'
                  ? 'amber'
                  : e.type === 'Distribution'
                    ? 'teal'
                    : 'violet')
              }
            >
              <Icon />
            </span>
            <div className="timeline-body">
              <div className="timeline-title">
                <h3>{e.title}</h3>
                <Status
                  tone={
                    e.status === 'Accepted'
                      ? 'success'
                      : e.status === 'Needs review'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {e.status}
                </Status>
              </div>
              <p>{e.summary}</p>
              <small>
                {e.type} ·{' '}
                {data.families.find((f) => f.id === e.familyId)?.name ??
                  'Unassigned'}{' '}
                family
                {fallback ? ' · Source did not supply an effective date' : ''}
              </small>
              <span className="source-link">
                <FileText />
                {sourceAvailable ? 'View source' : 'Source unavailable'}{' '}
                {sourceAvailable ? <ChevronRight /> : null}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
export function InvestmentActivity({
  events,
  onSource,
}: {
  events: TimelineEvent[];
  onSource: (id: string) => void;
}) {
  const [mode, setMode] = useState<ActivityDateMode>('effective');
  const [direction, setDirection] = useState<ActivityDirection>('newest');
  return (
    <section aria-label="Investment activity">
      <ActivityControls
        mode={mode}
        direction={direction}
        onMode={setMode}
        onDirection={setDirection}
      />
      <p className="method-note mb-4">
        {mode === 'effective'
          ? 'Economic dates in chronological order. Events without a supplied effective date remain in an undated group at the end.'
          : 'Arrival in Aster, using retained import or recording timestamps. These are not independently verified provider delivery times.'}
      </p>
      <div className="standalone-timeline">
        <TimelineList
          events={events}
          onSource={onSource}
          dateMode={mode}
          direction={direction}
        />
      </div>
    </section>
  );
}
function ActivityControls({
  mode,
  direction,
  onMode,
  onDirection,
}: {
  mode: ActivityDateMode;
  direction: ActivityDirection;
  onMode: (value: ActivityDateMode) => void;
  onDirection: (value: ActivityDirection) => void;
}) {
  return (
    <div className={styles.activityControls}>
      <div>
        <Picker
          label="Activity date basis"
          value={mode}
          onChange={(value) => onMode(value as ActivityDateMode)}
          options={[
            { value: 'effective', label: 'Effective date' },
            { value: 'imported', label: 'Imported / recorded date' },
          ]}
        />
        <Picker
          label="Activity order"
          value={direction}
          onChange={(value) => onDirection(value as ActivityDirection)}
          options={[
            { value: 'newest', label: 'Newest first' },
            { value: 'oldest', label: 'Oldest first' },
          ]}
        />
      </div>
    </div>
  );
}
export function TimelineView({
  family,
  onFamily,
  onSource,
}: {
  family: string;
  onFamily: (value: string) => void;
  onSource: (id: string) => void;
}) {
  const [tab, setTab] = useState('all');
  const [mode, setMode] = useState<ActivityDateMode>('effective');
  const [direction, setDirection] = useState<ActivityDirection>('newest');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const { data } = useWorkspace();
  const events = orderActivity(
    data.events.filter((event) => {
      const holdings = data.holdings.filter((holding) =>
        event.holdingIds.includes(holding.id),
      );
      return (
        (family === 'all' || event.familyId === family) &&
        (tab === 'all' ||
          (tab === 'valuations' && event.type === 'Valuation') ||
          (tab === 'cash notices' &&
            ['Capital call', 'Distribution'].includes(event.type)) ||
          (tab === 'updates' &&
            ['Manager update', 'Public news'].includes(event.type)) ||
          (tab === 'review' && event.type === 'Review')) &&
        [
          event.title,
          event.summary,
          ...holdings.flatMap((holding) => [holding.name, holding.manager]),
        ]
          .join(' ')
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      );
    }),
    mode,
    direction,
  );
  const start = Math.min(
    offset,
    Math.max(0, Math.floor((events.length - 1) / 50) * 50),
  );
  return (
    <>
      <PageHeading
        title="Activity"
        subtitle="Economic developments and source arrivals, with their dates kept distinct."
      >
        <FamilyPicker
          value={family}
          onChange={(value) => {
            setOffset(0);
            onFamily(value);
          }}
        />
      </PageHeading>
      <ViewTabs
        value={tab}
        onChange={(value) => {
          setTab(value);
          setOffset(0);
        }}
        items={['All', 'Valuations', 'Cash notices', 'Updates', 'Review']}
      />
      <div className={styles.activityControls}>
        <div className="w-full sm:max-w-sm">
          <Input
            aria-label="Search activity"
            placeholder="Search developments, investments or managers…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <ActivityControls
          mode={mode}
          direction={direction}
          onMode={(value) => {
            setMode(value);
            setOffset(0);
          }}
          onDirection={(value) => {
            setDirection(value);
            setOffset(0);
          }}
        />
      </div>
      <div className="timeline-summary">
        <span>{events.length} developments</span>
        <span>
          {mode === 'effective'
            ? 'Effective chronology · undated events last'
            : 'Imported / recorded chronology'}
        </span>
      </div>
      <div className="standalone-timeline">
        <TimelineList
          events={events.slice(start, start + 50)}
          onSource={onSource}
          dateMode={mode}
          direction={direction}
        />
      </div>
      <div className={styles.footer}>
        <span>
          {events.length ? start + 1 : 0}–{Math.min(start + 50, events.length)}{' '}
          of {events.length} developments
        </span>
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={start === 0}
            onClick={() => setOffset(Math.max(0, start - 50))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={start + 50 >= events.length}
            onClick={() => setOffset(start + 50)}
          >
            Next
          </Button>
        </div>
      </div>
    </>
  );
}
