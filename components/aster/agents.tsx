'use client';
import { FileText, Mail, ArrowRight, ShieldCheck, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { EvidenceSource } from '@/data';
import { useWorkspace } from './workspace-context';
import { PageHeading, Panel, Status, Metric, dateLabel } from './primitives';

/** Kept for existing imports; the main navigation renders ProcessingView. */
export function AgentsView({
  onTimeline,
}: {
  onSource: (id: string) => void;
  onTimeline: () => void;
}) {
  return (
    <>
      <PageHeading
        title="Processing"
        subtitle="Local document extraction with a reviewable record of each step."
      />
      <Panel title="Review before recording">
        <p className="method-note">
          Import a document in Processing, inspect the extracted candidates, and
          link accepted updates to a holding.
        </p>
        <Button variant="outline" onClick={onTimeline}>
          Open timeline
          <ArrowRight data-icon="inline-end" />
        </Button>
      </Panel>
    </>
  );
}

export function ConnectionsView() {
  const { state, data } = useWorkspace();
  const sampleMailboxes = state.sampleData ? data.mailboxes : [];
  const evidence: EvidenceSource[] = data.evidence;
  const imported = evidence.filter(
    (source) => !source.synthetic && source.documentId,
  );
  const documents = new Set(imported.map((source) => source.documentId));
  return (
    <>
      <PageHeading
        title="Connections"
        subtitle="Know where each record comes from."
      >
        <Status>Document import available</Status>
      </PageHeading>
      <div className="metrics-row three">
        <Metric
          label="Connected mailboxes"
          value="0"
          note="No live mailbox integration is configured"
        />
        <Metric
          label="Imported source files"
          value={String(documents.size)}
          note="Accepted records linked to retained originals"
        />
        <Metric
          label="Imported source passages"
          value={String(imported.length)}
          note="Available in the investment timeline"
        />
      </div>
      <div className="reporting-grid">
        <Panel
          title="Bring in a report"
          subtitle="PDF, TXT and exported EML files"
        >
          <div className="methodology">
            <FileText />
            <div>
              <h3>Import, extract, review</h3>
              <p>
                Upload a report in Processing. Choose workflow or agentic
                extraction, then inspect source passages before accepting a
                candidate.
              </p>
            </div>
            <ShieldCheck />
            <div>
              <h3>Local processing</h3>
              <p>
                The configured processor reads the file locally. Original
                downloads remain available to authorized workspace members.
              </p>
            </div>
          </div>
          <div className="report-builder-actions">
            <Button onClick={() => window.location.assign('?view=agents')}>
              Open Processing
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        </Panel>
        <Panel
          title="Mailbox connections"
          subtitle="Google Workspace and Microsoft 365"
        >
          <div className="methodology">
            <Mail />
            <div>
              <h3>Not connected</h3>
              <p>
                This build does not authorize or continuously synchronize a
                mailbox. Export relevant messages as EML and import them with
                their supported attachments.
              </p>
            </div>
            <Bot />
            <div>
              <h3>Account access needs a connector</h3>
              <p>
                Historical backfill and ongoing synchronization require provider
                authorization and a deployed connector. Uploading an EML does
                not connect its sender’s account.
              </p>
            </div>
          </div>
        </Panel>
      </div>
      {sampleMailboxes.length ? (
        <Panel
          title="Sample mailbox inventory"
          subtitle="Illustrative coverage only. These accounts are not connected."
          className="saved-reports"
        >
          <div className="connections-list">
            {sampleMailboxes.map((mailbox) => (
              <section className="connection-panel" key={mailbox.id}>
                <div className="connection-heading">
                  <span className="mailbox-avatar">
                    {mailbox.person
                      .split(' ')
                      .map((part) => part[0])
                      .join('')}
                  </span>
                  <div>
                    <h2>{mailbox.person}</h2>
                    <p>{mailbox.email}</p>
                  </div>
                  <Status tone="violet">Sample source</Status>
                </div>
                <div className="connection-stats">
                  <div>
                    <span>Provider example</span>
                    <strong>{mailbox.provider}</strong>
                  </div>
                  <div>
                    <span>Sample messages</span>
                    <strong>
                      {mailbox.messagesIndexed.toLocaleString('en-GB')}
                    </strong>
                  </div>
                  <div>
                    <span>Illustrative history</span>
                    <strong>
                      {dateLabel(mailbox.coverageStart)} –{' '}
                      {dateLabel(mailbox.coverageEnd)}
                    </strong>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </Panel>
      ) : null}
    </>
  );
}
