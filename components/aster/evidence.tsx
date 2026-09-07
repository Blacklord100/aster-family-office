'use client';
import {
  FileText,
  Download,
  CheckCircle2,
  ArrowUpRight,
  Check,
  Clock3,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { EvidenceSource } from '@/data';
import { useWorkspace } from './workspace-context';
import { dateLabel, Status } from './primitives';
export const REVIEW_IDS = [
  'source-event-01',
  'source-event-03',
  'source-event-04',
];
export function EvidencePanel({
  sourceId,
  onHolding,
  embedded = false,
}: {
  sourceId: string;
  onHolding?: (id: string) => void;
  embedded?: boolean;
}) {
  const { state, data, mutate } = useWorkspace();
  const source: EvidenceSource | undefined = data.evidence.find(
    (s) => s.id === sourceId,
  );
  if (!source)
    return (
      <div className="empty-inline">
        <FileText />
        <h3>Source unavailable</h3>
        <p>This record has no source in the current workspace.</p>
      </div>
    );
  const base = data.holdings.find((h) => h.id === source.holdingId);
  const relatedTasks = data.tasks.filter((t) => t.sourceId === sourceId);
  const reviewed =
    state.reviews[sourceId] !== undefined
      ? state.reviews[sourceId] === 'Accepted'
      : !REVIEW_IDS.includes(sourceId) && source.status === 'Accepted';
  const isStatement = source.filename.endsWith('.pdf');
  const download = () => {
    const blob = new Blob([source.excerpt], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = source.id + '-excerpt.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className={embedded ? 'evidence-panel embedded' : 'evidence-panel'}>
      <div className="evidence-heading">
        <FileText />
        <h2>Source document</h2>
        <Status tone={reviewed ? 'success' : 'warning'}>
          {reviewed ? 'Reviewed' : 'Needs review'}
        </Status>
      </div>
      {sourceId === 'source-demo-northstar-revision' &&
      !state.engine.valuationVersions.some(
        (v) =>
          v.status === 'active' && v.evidenceCitationIds.includes(sourceId),
      ) ? (
        <p className="method-note">
          Sample candidate correction · Run the sample workflow to reconcile
          this statement. Portfolio values have not changed.
        </p>
      ) : null}
      <h3 className="source-subject">{source.subject}</h3>
      <p className="source-meta">
        Received {dateLabel(source.receivedAt.slice(0, 10))} ·{' '}
        {isStatement ? 'Page ' + source.page : 'Email'}
      </p>
      <div className={isStatement ? 'document-paper' : 'email-paper'}>
        <div className="document-letterhead">
          {source.synthetic
            ? 'SAMPLE SOURCE'
            : source.documentId
              ? 'UPLOADED SOURCE'
              : 'MANUAL RECORD'}
        </div>
        <div className="document-rule" />
        <h3>{source.filename}</h3>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {source.excerpt}
        </p>
        <span className="document-demo">
          {source.synthetic
            ? 'SYNTHETIC SOURCE · DEMONSTRATION ONLY'
            : source.documentId
              ? 'EXTRACTED PASSAGE · CHECK AGAINST THE ORIGINAL'
              : 'MANUAL ENTRY · NOT INDEPENDENT SOURCE EVIDENCE'}
        </span>
      </div>
      <div className="evidence-status">
        <span>
          <i />
          {source.synthetic
            ? 'Sample evidence'
            : source.documentId
              ? 'Source passage retained'
              : 'Manually entered record'}
        </span>
        {source.documentId && !source.synthetic ? (
          <Button
            variant="outline"
            onClick={() =>
              window.location.assign(
                '/api/documents/' + encodeURIComponent(source.documentId!),
              )
            }
          >
            <Download data-icon="inline-start" />
            Download original
          </Button>
        ) : null}
        <Button variant="outline" onClick={download}>
          <Download data-icon="inline-start" />
          Download excerpt
        </Button>
      </div>
      <details className="source-excerpt">
        <summary>Exact source passage</summary>
        <p>{source.excerpt}</p>
      </details>
      <div className="evidence-attributes">
        <span>Effective date</span>
        <strong>{dateLabel(source.effectiveDate)}</strong>
        <span>Linked investment</span>
        <button onClick={() => onHolding?.(source.holdingId)}>
          {base?.name ?? 'Unlinked investment'}
          <ArrowUpRight />
        </button>
        <span>Source mailbox</span>
        <strong>
          {data.mailboxes.find((m) => m.id === source.mailboxId)?.person ??
            (source.mailboxId === 'upload'
              ? 'Document upload'
              : source.mailboxId === 'manual'
                ? 'Manual entry'
                : 'Unavailable')}
        </strong>
      </div>
      {source.synthetic && sourceId === 'source-event-01' ? (
        <div className="copy-evidence">
          <div className="avatar-stack">
            <span>CL</span>
            <span>SB</span>
            <span>DC</span>
          </div>
          <p>
            One notice · three mailbox copies
            <br />
            <small>A single €420,000 expected obligation</small>
          </p>
        </div>
      ) : null}
      {relatedTasks.map((t) => {
        const status = state.taskStatus[t.id] ?? t.status;
        return (
          <div className="evidence-task" key={t.id}>
            <div>
              <Clock3 />
              <strong>{t.title}</strong>
            </div>
            <p>{t.description}</p>
            <div className="task-foot">
              <span>
                {t.assignee} · {dateLabel(t.dueDate)}
              </span>
              <Button
                size="sm"
                variant={status === 'Done' ? 'secondary' : 'outline'}
                onClick={() =>
                  void mutate({
                    type: 'task',
                    id: t.id,
                    status: status === 'Done' ? 'To do' : 'Done',
                  })
                }
              >
                <Check data-icon="inline-start" />
                {status === 'Done' ? 'Completed' : 'Complete task'}
              </Button>
            </div>
          </div>
        );
      })}
      <div className="evidence-actions">
        <Button
          variant={reviewed ? 'secondary' : 'default'}
          onClick={() =>
            void mutate({
              type: 'review',
              id: sourceId,
              status: reviewed ? 'Needs review' : 'Accepted',
            })
          }
        >
          <CheckCircle2 data-icon="inline-start" />
          {reviewed ? 'Reopen review' : 'Mark reviewed'}
        </Button>
        <span>Reviewing a source does not record a payment.</span>
      </div>
    </div>
  );
}
