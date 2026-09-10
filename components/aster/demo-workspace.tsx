'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FolderOpen, LogOut, Play, Sparkles } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Picker } from './primitives';
import { useWorkspaceRequest } from './use-workspace-request';
import styles from './connections.module.css';

import type {
  DemoDataset,
  DemoResponse,
  DemoWorkspaceState,
} from '@/lib/demo-contract';

type DemoAction =
  | { action: 'start'; dataset?: DemoDataset }
  | { action: 'leave' }
  | { action: 'select'; organizationId: string };
function useDemoAction() {
  const { request } = useWorkspaceRequest();
  return async (body: DemoAction) => {
    await request(
      '/api/demo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'json',
      120_000,
    );
    window.location.assign(
      '/?view=' + (body.action === 'leave' ? 'overview' : 'connections'),
    );
  };
}

export function DemoWorkspaceBanner({ demo }: { demo: DemoWorkspaceState }) {
  const demoAction = useDemoAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function leave() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await demoAction({ action: 'leave' });
    } catch (issue) {
      setBusy(false);
      setError(
        issue instanceof Error ? issue.message : 'Could not leave the demo.',
      );
    }
  }
  return (
    <div className={styles.demoBanner}>
      <div>
        <Badge variant="secondary">
          <Sparkles data-icon="inline-start" />
          Live demo
        </Badge>
        <span>
          Fictional families ·{' '}
          {demo.dataset === 'history-v1' ? '12-quarter history · ' : ''}
          {demo.sourceFiles} source files · demo FX assumptions
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void leave()}
        disabled={busy}
      >
        <LogOut data-icon="inline-start" />
        {busy ? 'Leaving…' : 'Leave demo'}
      </Button>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function DemoLauncher() {
  const { key } = useWorkspaceRequest();
  return <ScopedDemoLauncher key={key} />;
}
function ScopedDemoLauncher() {
  const { request } = useWorkspaceRequest();
  const demoAction = useDemoAction();
  const [snapshot, setSnapshot] = useState<DemoResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [selected, setSelected] = useState('');
  const [dataset, setDataset] = useState<DemoDataset>('mailroom-v1');
  const lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const result = await request<DemoResponse>('/api/demo', {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setSnapshot(result);
      } catch (issue) {
        if (!controller.signal.aborted)
          setError(
            issue instanceof Error
              ? issue.message
              : 'Could not load the demo workspace.',
          );
      }
    }
    void load();
    return () => controller.abort();
  }, [request]);
  async function run(
    body:
      | { action: 'start'; dataset?: DemoDataset }
      | { action: 'leave' }
      | { action: 'select'; organizationId: string },
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await demoAction(body);
    } catch (issue) {
      lock.current = false;
      setBusy(false);
      setError(
        issue instanceof Error ? issue.message : 'Could not start the demo.',
      );
    }
  }
  if (!snapshot?.enabled && !error) return null;
  return (
    <>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Demo unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {snapshot?.enabled ? (
        <details className={styles.demoControls} open={!snapshot.current}>
          <summary hidden={!snapshot.current}>
            Demo run controls{' '}
            <span>Start again or return to a previous run</span>
          </summary>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <Badge variant="outline">
                  <FolderOpen data-icon="inline-start" />
                  Demo mails
                </Badge>
                <span className={styles.eyebrow}>
                  REAL PROCESSING · FICTIONAL DATA
                </span>
              </div>
              <CardTitle>
                {snapshot.current
                  ? 'Your demo is running from its sources.'
                  : 'Watch a family office come together.'}
              </CardTitle>
              <CardDescription>
                {snapshot.current
                  ? 'Reports and emails are collected from your Demo mails folder. Accepted information updates the families, investments and timeline as processing completes.'
                  : 'Start with an empty workspace for three fictional families. Connect Demo mails and watch the local engine turn emails, PDFs and updates into a source-linked portfolio.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Picker
                label="Demonstration dataset"
                value={dataset}
                onChange={(value) => {
                  if (value === 'mailroom-v1' || value === 'history-v1')
                    setDataset(value);
                }}
                options={[
                  {
                    value: 'mailroom-v1',
                    label: 'Mailroom · varied reports, PDFs and updates',
                  },
                  {
                    value: 'history-v1',
                    label:
                      'Portfolio history · 12 quarters, cash notices and corrections',
                  },
                ]}
              />
              <p className={styles.disclosure}>
                Supported source facts publish automatically inside the demo
                sandbox. Ambiguous, conflicting and unreadable documents remain
                visible for review. Your existing workspaces and previous demo
                runs stay available.
              </p>
              {snapshot.runs.length ? (
                <div className={styles.demoRuns}>
                  <Picker
                    value={selected}
                    onChange={setSelected}
                    label="Previous demo run"
                    options={[
                      { value: '', label: 'Choose a previous demo' },
                      ...snapshot.runs.map((item) => ({
                        value: item.organizationId,
                        label:
                          item.name +
                          ' · ' +
                          new Date(item.startedAt).toLocaleString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          }),
                      })),
                    ]}
                  />
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      !selected ||
                      selected === snapshot.current?.organizationId
                    }
                    onClick={() =>
                      void run({ action: 'select', organizationId: selected })
                    }
                  >
                    Open run
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                </div>
              ) : null}
            </CardContent>
            <CardFooter className="flex-wrap gap-3">
              <Button
                disabled={!snapshot.canCreate || busy}
                onClick={() =>
                  snapshot.current
                    ? setConfirm(true)
                    : void run({ action: 'start', dataset })
                }
              >
                <Play data-icon="inline-start" />
                {busy
                  ? 'Preparing sources…'
                  : snapshot.current
                    ? 'Start a new demo run'
                    : 'Connect Demo mails'}
              </Button>
              {snapshot.current ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run({ action: 'leave' })}
                >
                  Leave demo
                </Button>
              ) : null}
              <span className={styles.disclosure}>
                Local source folder · no real email account required
              </span>
            </CardFooter>
          </Card>
        </details>
      ) : null}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start another demo run?</DialogTitle>
            <DialogDescription>
              A new empty demo workspace will process the source folder again.
              This run and its history remain available under previous demos.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Keep this run
            </Button>
            <Button
              disabled={busy}
              onClick={() => void run({ action: 'start', dataset })}
            >
              {busy ? 'Preparing…' : 'Create new run'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
