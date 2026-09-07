'use client';
import { useState } from 'react';
import {
  Play,
  Square,
  Check,
  Bot,
  Sparkles,
  GitMerge,
  FileSearch,
  ArrowRight,
  ChevronDown,
  CheckCircle2,
  Mail,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useWorkspace } from './workspace-context';
import { agentRuns, sources } from '@/data';
import { PageHeading, Panel, Status, Metric } from './primitives';
const roles = [
  {
    name: 'Discovery',
    icon: FileSearch,
    text: 'Finds investments and reconstructs their history.',
    tools: 'Mailbox search · Entity matching',
  },
  {
    name: 'Reporting',
    icon: GitMerge,
    text: 'Extracts statements and reconciles changes.',
    tools: 'Document parsing · Valuation checks',
  },
  {
    name: 'Intelligence',
    icon: Sparkles,
    text: 'Connects updates to the right investments.',
    tools: 'Source matching · Timeline updates',
  },
];
export function AgentsView({
  onSource,
  onTimeline,
}: {
  onSource: (id: string) => void;
  onTimeline: () => void;
}) {
  const { state, mutate } = useWorkspace();
  const [expanded, setExpanded] = useState<string | null>(null),
    [starting, setStarting] = useState(false);
  const current = state.engine.runs.at(-1);
  const running = current?.status === 'running';
  async function run() {
    setStarting(true);
    await mutate({ type: 'run', id: crypto.randomUUID() });
    setStarting(false);
  }
  return (
    <>
      <PageHeading
        title="Agents"
        subtitle="Your investment operations, working together."
      >
        <Status tone="violet">Simulation mode</Status>
        <Button onClick={() => void run()} disabled={running || starting}>
          <Play data-icon="inline-start" />
          {starting
            ? 'Starting…'
            : running
              ? 'Workflow running'
              : 'Run demo workflow'}
        </Button>
      </PageHeading>
      <div className="agent-roles">
        {roles.map((r) => (
          <section key={r.name} className="agent-role">
            <span className="agent-role-icon">
              <r.icon />
            </span>
            <h2>{r.name}</h2>
            <p>{r.text}</p>
            <span>{r.tools}</span>
          </section>
        ))}
      </div>
      <Panel
        title="From incoming mail to investment knowledge"
        subtitle="Five sample copies · three business events · one connected workflow"
        className="workflow-panel"
        action={
          running ? (
            <Button
              variant="outline"
              onClick={() => void mutate({ type: 'cancel', id: current.id })}
            >
              <Square data-icon="inline-start" />
              Stop run
            </Button>
          ) : (
            <Status
              tone={current?.status === 'completed' ? 'success' : 'neutral'}
            >
              {current
                ? current.status === 'completed'
                  ? 'Completed'
                  : current.status === 'cancelled'
                    ? 'Stopped'
                    : 'Ready'
                : 'Ready to run'}
            </Status>
          )
        }
      >
        <div className="workflow-stages">
          {(
            current?.stages ?? [
              { id: 'intake', label: 'Intake', status: 'pending' },
              {
                id: 'entity_matching',
                label: 'Entity matching',
                status: 'pending',
              },
              { id: 'extraction', label: 'Extraction', status: 'pending' },
              { id: 'validation', label: 'Validation', status: 'pending' },
              {
                id: 'timeline_commit',
                label: 'Timeline commit',
                status: 'pending',
              },
            ]
          ).map((s, i) => (
            <div className={'workflow-stage ' + s.status} key={s.id}>
              <span>
                {s.status === 'completed' ? (
                  <Check />
                ) : s.status === 'running' ? (
                  <span className="running-orbit" />
                ) : (
                  i + 1
                )}
              </span>
              <strong>{s.label}</strong>
              <small>
                {s.status === 'running'
                  ? 'Working…'
                  : s.status === 'completed'
                    ? 'Complete'
                    : s.status === 'cancelled'
                      ? 'Stopped'
                      : 'Waiting'}
              </small>
              {i < 4 ? <ArrowRight className="stage-arrow" /> : null}
            </div>
          ))}
        </div>
        <div className="workflow-progress">
          <Progress
            value={
              current
                ? (current.stages.filter((s) => s.status === 'completed')
                    .length /
                    5) *
                  100
                : 0
            }
          />
          <span>
            {current?.stages.filter((s) => s.status === 'completed').length ??
              0}{' '}
            / 5 stages
          </span>
        </div>
        {current ? (
          <div className="run-trace">
            {current.stages
              .filter((s) => s.detail)
              .map((s) => (
                <div key={s.id}>
                  <CheckCircle2 />
                  <span>{s.detail}</span>
                </div>
              ))}
            {current.issues.map((issue, i) => (
              <p className="negative" key={i}>
                {issue.message}
              </p>
            ))}
          </div>
        ) : (
          <div className="workflow-intro">
            <Mail />
            <p>
              Process a capital call received by three colleagues, a corrected
              Northstar statement, and a Pacific manager update.
            </p>
            <Button variant="link" onClick={() => void run()}>
              Start the workflow <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        )}
        {current?.status === 'completed' ? (
          <div className="run-result">
            <div>
              <strong>{current.uniqueEventCount} unique events</strong>
              <p>
                {current.publishedEventCount} published ·{' '}
                {current.replayedEventCount} already present · cash balances
                unchanged
              </p>
            </div>
            <Button variant="outline" onClick={onTimeline}>
              Open timeline <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        ) : null}
      </Panel>
      <div className="reporting-grid lower-grid">
        <Panel title="Recent runs" subtitle="A visible record of agent work">
          <div className="agent-run-list">
            {[...state.engine.runs]
              .reverse()
              .slice(0, 4)
              .map((r) => (
                <div key={r.id}>
                  <button
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                  >
                    <span className="activity-icon">
                      <Bot />
                    </span>
                    <div>
                      <strong>Mailbox intelligence workflow</strong>
                      <small>
                        {new Date(r.startedAt).toLocaleTimeString('en-GB', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        · {r.inputCopyCount} source copies
                      </small>
                    </div>
                    <Status
                      tone={
                        r.status === 'completed'
                          ? 'success'
                          : r.status === 'cancelled'
                            ? 'neutral'
                            : 'violet'
                      }
                    >
                      {r.status}
                    </Status>
                    <ChevronDown />
                  </button>
                  {expanded === r.id ? (
                    <p className="run-expanded">
                      {r.uniqueEventCount} unique events.{' '}
                      {r.publishedEventCount} published. {r.replayedEventCount}{' '}
                      safely skipped on replay. {r.issues.length} unresolved
                      issues.
                    </p>
                  ) : null}
                </div>
              ))}
            {agentRuns.slice(0, 3).map((r) => (
              <div key={r.id}>
                <button
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                >
                  <span className="activity-icon">
                    <Bot />
                  </span>
                  <div>
                    <strong>{r.name}</strong>
                    <small>Sample history · {r.sourcesProcessed} sources</small>
                  </div>
                  <Status
                    tone={r.status === 'Completed' ? 'success' : 'warning'}
                  >
                    {r.status}
                  </Status>
                  <ChevronDown />
                </button>
                {expanded === r.id ? (
                  <p className="run-expanded">{r.summary}</p>
                ) : null}
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="What this demo demonstrates">
          <div className="methodology">
            <GitMerge />
            <div>
              <h3>One event, multiple sources</h3>
              <p>
                Three copies of a €420,000 call become one expected obligation.
              </p>
            </div>
            <FileSearch />
            <div>
              <h3>Corrections with history</h3>
              <p>
                A revised €9.72M NAV replaces €9.60M while retaining the
                original evidence.
              </p>
              <button
                className="inline-link"
                onClick={() => onSource('source-demo-northstar-revision')}
              >
                Inspect the correction <ArrowRight />
              </button>
            </div>
            <Bot />
            <div>
              <h3>Inspect every step</h3>
              <p>
                This is a deterministic simulation. It uses no live mailbox or
                language model.
              </p>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
export function ConnectionsView() {
  const { state, mutate } = useWorkspace();
  const [syncing, setSyncing] = useState<string | null>(null),
    [expanded, setExpanded] = useState<string | null>(null);
  async function sync(id: string) {
    setSyncing(id);
    await mutate({ type: 'sync', id });
    setSyncing(null);
  }
  return (
    <>
      <PageHeading
        title="Connections"
        subtitle="A complete view of where your information comes from."
      >
        <Status tone="violet">Sample connections</Status>
      </PageHeading>
      <div className="metrics-row three">
        <Metric
          label="Source mailboxes"
          value="3"
          note="Across the investment team"
        />
        <Metric
          label="Historical messages"
          value={sources
            .reduce((s, m) => s + m.messagesIndexed, 0)
            .toLocaleString('en-GB')}
          note="Illustrative coverage inventory"
        />
        <Metric
          label="Relevant correspondence"
          value={sources
            .reduce((s, m) => s + m.relevantMessages, 0)
            .toLocaleString('en-GB')}
          note="Linked to investment knowledge"
        />
      </div>
      <div className="connections-list">
        {sources.map((m) => (
          <section className="connection-panel" key={m.id}>
            <div className="connection-heading">
              <span className="mailbox-avatar">
                {m.person
                  .split(' ')
                  .map((p) => p[0])
                  .join('')}
              </span>
              <div>
                <h2>{m.person}</h2>
                <p>{m.email}</p>
              </div>
              <Status tone="success">Demo connected</Status>
              <Button
                variant="outline"
                disabled={syncing === m.id}
                onClick={() => void sync(m.id)}
              >
                {syncing === m.id ? 'Checking…' : 'Simulate sync'}
              </Button>
            </div>
            <div className="connection-stats">
              <div>
                <span>Provider</span>
                <strong>{m.provider}</strong>
              </div>
              <div>
                <span>Messages indexed</span>
                <strong>{m.messagesIndexed.toLocaleString('en-GB')}</strong>
              </div>
              <div>
                <span>History coverage</span>
                <strong>Sep 2024 – Sep 2026</strong>
              </div>
              <div>
                <span>Last checked</span>
                <strong>
                  {state.syncs[m.id]
                    ? new Date(state.syncs[m.id]).toLocaleTimeString('en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Today, 08:42'}
                </strong>
              </div>
            </div>
            <div className="coverage-progress">
              <Progress value={100} />
              <span>Sample primary mailbox complete</span>
            </div>
            <button
              className="coverage-toggle"
              onClick={() => setExpanded(expanded === m.id ? null : m.id)}
            >
              {expanded === m.id ? 'Hide' : 'View'} folder coverage{' '}
              <ChevronDown />
            </button>
            {expanded === m.id ? (
              <div className="folder-coverage">
                {['Inbox', 'Sent', 'Archive', 'Investment reports'].map((f) => (
                  <div key={f}>
                    <Mail />
                    <span>{f}</span>
                    <CheckCircle2 />
                    <small>Covered in sample</small>
                  </div>
                ))}
                <p>
                  Spam, Trash and separate Online Archives are outside this
                  sample. No real account is connected.
                </p>
              </div>
            ) : null}
          </section>
        ))}
      </div>
      <Panel
        title="Connect once. Keep the whole story."
        className="connection-note"
      >
        <p>
          Historical collection and ongoing monitoring share the same evidence
          pipeline. The current workspace uses synthetic messages; real Google
          and Microsoft authorization is a subsequent integration.
        </p>
      </Panel>
    </>
  );
}
