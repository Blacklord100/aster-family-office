'use client';
import { useState } from 'react';
import { Search, Mail, FileText, CheckCheck } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useWorkspace } from './workspace-context';
import {
  PageHeading,
  FamilyPicker,
  ViewTabs,
  Picker,
  Status,
  dateLabel,
} from './primitives';
import { EvidencePanel, REVIEW_IDS } from './evidence';
export function InboxView({
  family,
  onFamily,
  onHolding,
}: {
  family: string;
  onFamily: (s: string) => void;
  onHolding: (id: string) => void;
}) {
  const { state, data } = useWorkspace();
  const [tab, setTab] = useState('all sources'),
    [owner, setOwner] = useState('all'),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState('');
  const items = data.evidence
    .filter(
      (s) =>
        (family === 'all' || s.familyId === family) &&
        (owner === 'all' || s.mailboxId === owner) &&
        s.subject.toLowerCase().includes(query.toLowerCase()) &&
        (tab === 'all sources' ||
          (tab === 'needs review' &&
            (s.status === 'Needs review' ||
              (state.sampleData && REVIEW_IDS.includes(s.id)) ||
              state.reviews[s.id] === 'Needs review') &&
            state.reviews[s.id] !== 'Accepted') ||
          (tab === 'reviewed' &&
            (state.reviews[s.id] !== undefined
              ? state.reviews[s.id] === 'Accepted'
              : !REVIEW_IDS.includes(s.id) && s.status === 'Accepted'))),
    )
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const active = items.find((s) => s.id === selected) ?? items[0];
  return (
    <>
      <PageHeading
        title="Source library"
        subtitle="Source evidence linked to your families and investments."
      >
        <FamilyPicker value={family} onChange={onFamily} />
      </PageHeading>
      <ViewTabs
        value={tab}
        onChange={setTab}
        items={['Needs review', 'All sources', 'Reviewed']}
      />
      <div className="list-toolbar">
        <div className="search-input">
          <Search />
          <Input
            aria-label="Search source library"
            placeholder="Search reports and emails…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Picker
          label="Mailbox filter"
          value={owner}
          onChange={setOwner}
          options={[
            { value: 'all', label: 'All mailboxes' },
            ...data.mailboxes.map((s) => ({ value: s.id, label: s.person })),
          ]}
        />
        <span className="toolbar-count">{items.length} sources</span>
      </div>
      <div className="inbox-workbench">
        <div className="inbox-list">
          {items.length ? (
            items.map((s) => (
              <button
                key={s.id}
                className={
                  'inbox-item ' + (active?.id === s.id ? 'selected' : '')
                }
                onClick={() => setSelected(s.id)}
              >
                <div className="inbox-item-top">
                  <span>{s.sender.split('<')[0]}</span>
                  <time>{dateLabel(s.receivedAt.slice(0, 10))}</time>
                </div>
                <h3>{s.subject}</h3>
                <p>{s.excerpt.replace('SYNTHETIC DEMONSTRATION. ', '')}</p>
                <div className="inbox-item-foot">
                  <span>
                    <FileText />
                    {s.filename.endsWith('.pdf') ? 'Statement' : 'Email'}
                  </span>
                  <Status
                    tone={
                      state.reviews[s.id] === 'Accepted'
                        ? 'success'
                        : REVIEW_IDS.includes(s.id) ||
                            state.reviews[s.id] === 'Needs review' ||
                            s.status === 'Needs review'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {state.reviews[s.id] === 'Accepted'
                      ? 'Reviewed'
                      : REVIEW_IDS.includes(s.id) ||
                          state.reviews[s.id] === 'Needs review' ||
                          s.status === 'Needs review'
                        ? 'Needs review'
                        : 'Processed'}
                  </Status>
                </div>
              </button>
            ))
          ) : (
            <div className="empty-inline">
              <CheckCheck />
              <h3>No linked sources in this view</h3>
              <p>No sources match this view.</p>
            </div>
          )}
        </div>
        <div className="inbox-detail">
          {active ? (
            <EvidencePanel sourceId={active.id} onHolding={onHolding} />
          ) : (
            <div className="empty-inline">
              <Mail />
              <h3>Every update, with its source</h3>
              <p>
                Reports and emails shared with your families appear here with
                their original source and linked investments.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
