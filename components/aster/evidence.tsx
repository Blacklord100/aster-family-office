'use client';
import {
  FileText,
  Download,
  CheckCircle2,
  ArrowUpRight,
  Mail,
  Check,
  Clock3,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-context';
import { holdings as baseHoldings, tasks } from '@/data';
import { money, dateLabel, Status } from './primitives';
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
  const source = data.evidence.find((s) => s.id === sourceId);
  if (!source)
    return (
      <div className="empty-inline">
        <FileText />
        <h3>Source unavailable</h3>
        <p>This record has no source in the demo dataset.</p>
      </div>
    );
  const base = baseHoldings.find((h) => h.id === source.holdingId)!;
  const value =
    sourceId === 'source-demo-northstar-revision'
      ? base.valueEUR + 120000
      : base.valueEUR;
  const relatedTasks = tasks.filter((t) => t.sourceId === sourceId);
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
          Candidate correction · Run the demo workflow to reconcile this
          statement. Portfolio values have not changed.
        </p>
      ) : null}
      <h3 className="source-subject">{source.subject}</h3>
      <p className="source-meta">
        Received {dateLabel(source.receivedAt.slice(0, 10))} ·{' '}
        {isStatement ? 'Page ' + source.page : 'Email'}
      </p>
      {isStatement ? (
        <div className="document-paper">
          <div className="document-letterhead">
            {base.manager.toUpperCase()}
          </div>
          <div className="document-rule" />
          <h3>Investor valuation statement</h3>
          <p>Period ended {dateLabel(source.effectiveDate)}</p>
          <div className="document-owner">
            {base.familyId[0].toUpperCase() + base.familyId.slice(1)} Capital ·
            Investor account
          </div>
          <dl>
            <div>
              <dt>Investment</dt>
              <dd>{base.name}</dd>
            </div>
            <div>
              <dt>Cost basis</dt>
              <dd>{money(base.costBasisEUR, 2)}</dd>
            </div>
            <div className="highlight-value">
              <dt>Net asset value</dt>
              <dd>{money(value, 2)}</dd>
            </div>
            <div>
              <dt>Unfunded commitment</dt>
              <dd>{money(base.unfundedCommitmentEUR, 2)}</dd>
            </div>
          </dl>
          <span className="document-demo">
            SYNTHETIC STATEMENT · DEMONSTRATION ONLY
          </span>
        </div>
      ) : (
        <div className="email-paper">
          <div className="email-from">
            <Mail />
            <div>
              <strong>{source.sender.split('<')[0]}</strong>
              <span>To Aster investment team</span>
            </div>
          </div>
          <p>{source.excerpt.replace('SYNTHETIC DEMONSTRATION. ', '')}</p>
          <div className="email-signature">
            Kind regards,
            <br />
            {base.manager} reporting team
          </div>
          <span className="document-demo">
            SYNTHETIC EMAIL · DEMONSTRATION ONLY
          </span>
        </div>
      )}
      <div className="evidence-status">
        <span>
          <i />
          {isStatement ? 'Matched to source statement' : 'Source-linked update'}
        </span>
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
          {base.name}
          <ArrowUpRight />
        </button>
        <span>Source mailbox</span>
        <strong>{source.mailboxId.replace('mailbox-', '')}</strong>
      </div>
      {sourceId === 'source-event-01' ? (
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
