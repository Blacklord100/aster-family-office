'use client';
import { useEffect, useState } from 'react';
import { Search, Mail, FileText, CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import type { ProcessingJob } from '@/lib/processing-contract';
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
  const [pendingJobs, setPendingJobs] = useState<number | null>(null);
  const canProcess = !state.identity?.dataScope;
  useEffect(() => {
    if (!canProcess) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!document.hidden) {
        try {
          const response = await fetch('/api/processing', {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (response.ok) {
            const result = (await response.json()) as { jobs: ProcessingJob[] };
            if (!controller.signal.aborted)
              setPendingJobs(
                result.jobs.filter((job) =>
                  [
                    'queued',
                    'processing',
                    'awaiting_review',
                    'failed',
                  ].includes(job.status),
                ).length,
              );
          }
        } catch {
          /* The linked inbox remains usable if processing is temporarily unavailable. */
        }
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 15000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [canProcess]);
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
        title="Inbox"
        subtitle="Source evidence linked to your families and investments."
      >
        <FamilyPicker value={family} onChange={onFamily} />
      </PageHeading>
      {canProcess ? (
        <Alert className="mb-5">
          <AlertDescription>
            <span>
              {pendingJobs
                ? `${pendingJobs} recent documents are processing or need review. `
                : ''}
              Originals awaiting extraction and fact review are in Processing.
            </span>
            <Link
              href="/?view=agents"
              className={buttonVariants({ variant: 'link' })}
            >
              Open Processing
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      <ViewTabs
        value={tab}
        onChange={setTab}
        items={['Needs review', 'All sources', 'Reviewed']}
      />
      <div className="list-toolbar">
        <div className="search-input">
          <Search />
          <Input
            aria-label="Search inbox"
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
                Import a PDF, TXT or EML in Processing, then review its
                extracted candidates.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
