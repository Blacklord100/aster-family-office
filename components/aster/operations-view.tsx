'use client';
import { useEffect, useState } from 'react';
import { Activity, ShieldCheck, Database, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorkspace } from './workspace-context';
import type {
  OperationsStatus,
  RetentionPreview,
  OperationalPolicy,
} from '@/lib/operations-contract';
import styles from './operations.module.css';
import {
  useWorkspaceRequest,
  WorkspaceRequestError,
} from './use-workspace-request';
export function OperationsView() {
  const { key } = useWorkspaceRequest();
  return <ScopedOperationsView key={key} />;
}
function ScopedOperationsView() {
  const { request } = useWorkspaceRequest();
  const { state } = useWorkspace(),
    admin = ['owner', 'admin'].includes(state.identity?.role ?? '');
  const [data, setData] = useState<OperationsStatus | null>(null),
    [policy, setPolicy] = useState<OperationalPolicy | null>(null),
    [preview, setPreview] = useState<RetentionPreview | null>(null),
    [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  async function load() {
    try {
      setError('');
      const body = await request<OperationsStatus>('/api/operations');
      setData(body);
      setPolicy(body.policy);
    } catch (e) {
      if (e instanceof WorkspaceRequestError && [401, 403].includes(e.status)) {
        setData(null);
        setPolicy(null);
        setPreview(null);
      }
      setError(e instanceof Error ? e.message : 'Could not load operations');
    }
  }
  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController();
    void request<OperationsStatus>('/api/operations', {
      signal: controller.signal,
    })
      .then((body) => {
        setData(body);
        setPolicy(body.policy);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Could not load operations',
          );
      });
    return () => controller.abort();
  }, [admin, request]);
  async function act(body: object) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<RetentionPreview | { purged?: number }>(
        '/api/operations',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if ('digest' in result) setPreview(result);
      else {
        setPreview(null);
        setConfirmation('');
        setNotice(
          'purged' in result
            ? result.purged + ' unreferenced originals purged.'
            : 'Operational policy saved.',
        );
        await load();
      }
    } catch (e) {
      if (e instanceof WorkspaceRequestError && [401, 403].includes(e.status)) {
        setData(null);
        setPolicy(null);
        setPreview(null);
        setConfirmation('');
      }
      setError(e instanceof Error ? e.message : 'The action failed');
    } finally {
      setBusy(false);
    }
  }
  if (!admin)
    return (
      <div className={styles.page}>
        <h1>Operations</h1>
        <p>Your administrator manages deployment health and retention.</p>
      </div>
    );
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>OFFICE OPERATIONS</span>
          <h1>Keep the office running.</h1>
          <p>Service health, recovery evidence and controlled retention.</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={busy}>
          <RefreshCw />
          Refresh
        </Button>
      </header>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {notice ? <output className={styles.notice}>{notice}</output> : null}
      {data && policy ? (
        <>
          <div className={styles.metrics}>
            {[
              {
                name: 'Documents',
                value: data.storage.documents,
                sub:
                  (data.storage.bytes / 1048576).toFixed(1) +
                  ' MB encrypted at rest',
                icon: Database,
              },
              {
                name: 'In processing',
                value: data.queue.queued,
                sub: data.queue.review + ' ready for review',
                icon: Activity,
              },
              {
                name: 'Failed jobs',
                value: data.queue.failed,
                sub: 'Review the Documents pipeline',
                icon: ShieldCheck,
              },
            ].map((card) => (
              <section key={card.name}>
                <card.icon />
                <p>{card.name}</p>
                <strong>{card.value}</strong>
                <small>{card.sub}</small>
              </section>
            ))}
          </div>
          <div className={styles.columns}>
            <section className={styles.card}>
              <h2>Service status</h2>
              <dl>
                {Object.entries({
                  Processor: data.services.processor,
                  'Document worker': data.services.documentWorker,
                  'Production backup': data.services.backup,
                  'Password reset delivery': data.deliveryConfigured
                    ? 'Enabled'
                    : 'Disabled',
                  'Active encryption key': data.activeEncryptionKeyId,
                }).map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className={styles.note}>
                Health checks show current reachability. They do not certify
                network isolation or a recoverable production installation.
              </p>
              {data.alerts.map((a) => (
                <p key={a.code} className={styles.alert}>
                  {a.message}
                </p>
              ))}
            </section>
            <section className={styles.card}>
              <h2>Alert thresholds</h2>
              {[
                {
                  key: 'backupMaxAgeHours',
                  label: 'Maximum backup age (hours)',
                  min: 1,
                  max: 168,
                },
                {
                  key: 'jobFailureAlertThreshold',
                  label: 'Failed jobs requiring attention',
                  min: 1,
                  max: 1000,
                },
                {
                  key: 'mailboxStaleHours',
                  label: 'Mailbox stale after (hours)',
                  min: 1,
                  max: 168,
                },
              ].map((f) => (
                <label
                  className={styles.field}
                  key={f.key}
                  htmlFor={'operations-' + f.key}
                >
                  {f.label}
                  <Input
                    id={'operations-' + f.key}
                    type="number"
                    min={f.min}
                    max={f.max}
                    value={policy[f.key as keyof OperationalPolicy] as number}
                    onChange={(e) =>
                      setPolicy({ ...policy, [f.key]: Number(e.target.value) })
                    }
                  />
                </label>
              ))}
              <Button
                disabled={busy}
                onClick={() =>
                  void act({
                    action: 'policy',
                    policy,
                    expectedRevision: data.revision,
                  })
                }
              >
                Save policy
              </Button>
            </section>
          </div>
          <section className={styles.card}>
            <h2>Retention with a review step</h2>
            <p className={styles.note}>
              Only old, unreferenced originals whose jobs are failed, cancelled
              or rejected are eligible. Accepted evidence, review history,
              active work, client-released originals and workspace references
              are preserved.
            </p>
            <label className={styles.field} htmlFor="retention-days">
              Minimum age in days
              <Input
                id="retention-days"
                type="number"
                min={30}
                max={3650}
                value={policy.unreviewedRetentionDays}
                onChange={(e) => {
                  setPreview(null);
                  setPolicy({
                    ...policy,
                    unreviewedRetentionDays: Number(e.target.value),
                  });
                }}
              />
            </label>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={policy.retentionEnabled}
                onChange={(e) => {
                  setPreview(null);
                  setPolicy({ ...policy, retentionEnabled: e.target.checked });
                }}
              />
              Enable reviewed retention purges
            </label>
            <div className={styles.actions}>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act({
                    action: 'policy',
                    policy,
                    expectedRevision: data.revision,
                  })
                }
              >
                Save retention policy
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act({ action: 'preview' })}
              >
                Preview eligible originals
              </Button>
            </div>
            {preview ? (
              <div className={styles.preview}>
                <strong>
                  {preview.documentCount} eligible originals ·{' '}
                  {(preview.bytes / 1048576).toFixed(1)} MB
                </strong>
                <p>
                  {preview.limited
                    ? 'The preview is limited to 500 originals; repeat after reviewing this batch.'
                    : 'This preview uses the saved policy.'}
                </p>
                <details>
                  <summary>Document IDs</summary>
                  <ul>
                    {preview.documentIds.map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                </details>
                {preview.documentCount > 0 && data.policy.retentionEnabled ? (
                  <>
                    <p>
                      Purging permanently removes these unreferenced originals
                      and their unreviewed job payloads. This cannot be undone
                      in Aster.
                    </p>
                    <Input
                      aria-label="Retention confirmation"
                      placeholder="PURGE UNREFERENCED DOCUMENTS"
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                    />
                    <Button
                      variant="destructive"
                      disabled={
                        busy || confirmation !== 'PURGE UNREFERENCED DOCUMENTS'
                      }
                      onClick={() =>
                        void act({
                          action: 'purge',
                          digest: preview.digest,
                          confirmation,
                        })
                      }
                    >
                      Permanently purge reviewed list
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
          </section>
        </>
      ) : (
        <p>Loading operations…</p>
      )}
    </div>
  );
}
