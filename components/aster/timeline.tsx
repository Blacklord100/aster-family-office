'use client';
import { useState } from 'react';
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
}: {
  events: TimelineEvent[];
  onSource: (id: string) => void;
  selectedId?: string;
  compact?: boolean;
}) {
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
      {events.map((e) => {
        const Icon = icons[e.type];
        return (
          <button
            key={e.id}
            className={
              'timeline-item ' + (e.sourceId === selectedId ? 'selected' : '')
            }
            onClick={() => onSource(e.sourceId)}
          >
            <time>{dateLabel(e.date)}</time>
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
                  {e.status === 'Accepted' ? 'Verified' : e.status}
                </Status>
              </div>
              <p>{e.summary}</p>
              <small>
                {e.type} ·{' '}
                {e.familyId === 'bergstrom'
                  ? 'Bergström'
                  : e.familyId[0].toUpperCase() + e.familyId.slice(1)}{' '}
                family
              </small>
              <span className="source-link">
                <FileText />
                View source <ChevronRight />
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
export function TimelineView({
  family,
  onFamily,
  onSource,
}: {
  family: string;
  onFamily: (s: string) => void;
  onSource: (id: string) => void;
}) {
  const [tab, setTab] = useState('all');
  const { data } = useWorkspace();
  const events = data.events.filter(
    (e) =>
      (family === 'all' || e.familyId === family) &&
      (tab === 'all' ||
        (tab === 'reporting' && e.type === 'Valuation') ||
        (tab === 'cash flows' &&
          ['Capital call', 'Distribution'].includes(e.type)) ||
        (tab === 'updates' &&
          ['Manager update', 'Public news'].includes(e.type)) ||
        (tab === 'review' && e.type === 'Review')),
  );
  return (
    <>
      <PageHeading
        title="Timeline"
        subtitle="Every development, connected to its source."
      >
        <FamilyPicker value={family} onChange={onFamily} />
      </PageHeading>
      <ViewTabs
        value={tab}
        onChange={setTab}
        items={['All', 'Reporting', 'Cash flows', 'Updates', 'Review']}
      />
      <div className="timeline-summary">
        <span>{events.length} developments</span>
        <span>Showing effective dates · received dates in source</span>
      </div>
      <div className="standalone-timeline">
        <TimelineList events={events} onSource={onSource} />
      </div>
    </>
  );
}
