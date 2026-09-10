'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { EvidenceSource, Holding } from '@/data';
import { historyPositionDetails } from '@/lib/portfolio-history-lifecycle';
import {
  historyLifecycleRequestSchema,
  type HistoryLifecycleRecord,
  type HistoryLifecycleRequest,
  type HistoryPositionDetails,
} from '@/lib/portfolio-history-lifecycle-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { useWorkspace } from './workspace-context';
import { dateLabel, Picker, Status } from './primitives';
import { historyDateTime } from '@/lib/history-presentation';
import { PdfPreview } from './pdf-preview';
import { EmailPreview } from './email-preview';
import styles from './investment-history.module.css';

export function lifecycleSources(
  sources: readonly EvidenceSource[],
  holding: Holding,
) {
  return sources.filter(
    (source) =>
      source.holdingId === holding.id &&
      source.familyId === holding.familyId &&
      source.status === 'Accepted' &&
      !source.synthetic &&
      !!source.documentId,
  );
}

export function HistoryLifecycle({
  holding,
  onSaved,
}: {
  holding: Holding;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { state } = useWorkspace();
  const scopeKey = JSON.stringify([
    holding.id,
    state.identity?.organizationId,
    state.identity?.dataScope,
  ]);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Position history
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[880px] max-h-[92dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Position history</DialogTitle>
            <DialogDescription>
              Record an evidenced opening, exit or classification for{' '}
              {holding.name}. The first NAV report is not evidence of
              acquisition.
            </DialogDescription>
          </DialogHeader>
          {open ? (
            <HistoryLifecycleForm
              key={scopeKey}
              holding={holding}
              onSaved={onSaved}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function HistoryLifecycleForm({
  holding,
  onSaved,
}: {
  holding: Holding;
  onSaved: () => void;
}) {
  const { state, data, revision, reload } = useWorkspace();
  const prefix = useId();
  const canWrite =
    !!state.identity &&
    state.identity.role !== 'viewer' &&
    !state.identity.dataScope;
  const sources = lifecycleSources(data.evidence, holding);
  const records = (state.historyLifecycle?.records ?? [])
    .filter((record) => record.holdingId === holding.id)
    .toSorted(
      (a, b) =>
        b.effectiveDate.localeCompare(a.effectiveDate) ||
        b.recordedAt.localeCompare(a.recordedAt),
    );
  const superseded = new Set(
    records.flatMap((record) =>
      record.correctionOf ? [record.correctionOf] : [],
    ),
  );
  const [baseRevision, setBaseRevision] = useState(revision);
  const [kind, setKind] = useState<'opened' | 'closed' | 'classified'>(
    'opened',
  );
  const [effectiveDate, setEffectiveDate] = useState('');
  const [details, setDetails] = useState<HistoryPositionDetails>(() =>
    historyPositionDetails(holding),
  );
  const [sourceId, setSourceId] = useState('');
  const [correctionOf, setCorrectionOf] = useState('');
  const [page, setPage] = useState('1');
  const [quote, setQuote] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(false);
  const [openedSource, setOpenedSource] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [retryable, setRetryable] = useState(false);
  const pending = useRef<{
    command: string;
    request: HistoryLifecycleRequest;
  } | null>(null);
  const source = sources.find((item) => item.id === sourceId);
  const stale = revision !== baseRevision;
  function changed() {
    setVerified(false);
    setSaved('');
    pending.current = null;
    setRetryable(false);
  }
  function correct(record: HistoryLifecycleRecord | undefined) {
    changed();
    setCorrectionOf(record?.id ?? '');
    setKind(record?.kind ?? 'opened');
    setEffectiveDate(record?.effectiveDate ?? '');
    setDetails(record?.details ?? historyPositionDetails(holding));
    setSourceId('');
    setOpenedSource('');
    setPreview(false);
    setQuote('');
    setReason('');
  }
  async function save() {
    if (busy || !canWrite) return;
    setError('');
    setSaved('');
    const command = {
      holdingId: holding.id,
      kind,
      effectiveDate,
      ...(kind === 'closed' ? {} : { details }),
      sourceId,
      evidenceVerified: verified && openedSource === sourceId,
      page: Number(page),
      quote,
      reason,
      ...(correctionOf ? { correctionOf } : {}),
    };
    const serialized = JSON.stringify(command);
    const parsed = historyLifecycleRequestSchema.safeParse(
      pending.current?.command === serialized
        ? pending.current.request
        : {
            expectedRevision: baseRevision,
            idempotencyKey: crypto.randomUUID(),
            command,
          },
    );
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? 'Review all required fields.',
      );
      return;
    }
    pending.current = { command: serialized, request: parsed.data };
    setRetryable(true);
    setBusy(true);
    try {
      const response = await fetch('/api/portfolio-history/lifecycle', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'x-aster-organization': state.identity!.organizationId,
        },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(20_000),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          result?.message ?? 'The position record could not be saved.',
        );
      if (!result?.resultId || !Number.isInteger(result.revision))
        throw new Error(
          'The save response was incomplete. Retry the same submission safely.',
        );
      setBaseRevision(result.revision);
      setVerified(false);
      pending.current = null;
      setRetryable(false);
      setSaved(
        result.duplicate
          ? 'This exact record was already saved; no duplicate was created.'
          : 'Source-linked position record saved. Earlier versions remain in history.',
      );
      reload();
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The position record could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.section}>
      {records.length ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Retained position records ({records.length})
          </summary>
          <div className="mt-3 space-y-3">
            {records.map((record) => (
              <div key={record.id} className="rounded-lg border p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>
                    {record.kind === 'opened'
                      ? 'Opening'
                      : record.kind === 'closed'
                        ? 'Exit'
                        : 'Classification'}{' '}
                    · {dateLabel(record.effectiveDate)}
                  </strong>
                  <Status
                    tone={superseded.has(record.id) ? 'neutral' : 'success'}
                  >
                    {superseded.has(record.id) ? 'Superseded' : 'Recorded'}
                  </Status>
                </div>
                <p className="mt-2 text-muted-foreground">{record.reason}</p>
                <p className="mt-1 text-muted-foreground">
                  Recorded {historyDateTime(record.recordedAt)}
                </p>
                {canWrite && !superseded.has(record.id) ? (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => correct(record)}
                  >
                    Correct this record
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : (
        <p className={styles.note}>
          No sourced opening, exit or historical classification is recorded.
          Ownership before the first report remains unknown.
        </p>
      )}
      {!canWrite ? (
        <p className={styles.note}>
          A workspace editor with unrestricted access can record sourced
          position history.
        </p>
      ) : (
        <>
          {stale ? (
            <Alert>
              <AlertTitle>Workspace history changed</AlertTitle>
              <AlertDescription>
                Your draft is preserved. Review the current records before
                recording it.
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setBaseRevision(revision);
                    setVerified(false);
                    pending.current = null;
                    setRetryable(false);
                  }}
                >
                  Use current revision and recheck evidence
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Position record needs attention</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {saved ? (
            <Alert>
              <AlertTitle>Position history updated</AlertTitle>
              <AlertDescription>{saved}</AlertDescription>
            </Alert>
          ) : null}
          <div className={styles.fields + ' !p-0'}>
            <label className={styles.field} htmlFor={prefix + '-kind'}>
              Record type
              <Picker
                id={prefix + '-kind'}
                label="Position record type"
                value={kind}
                onChange={(value) => {
                  changed();
                  setKind(value as typeof kind);
                }}
                options={[
                  { value: 'opened', label: 'Opening / acquisition' },
                  { value: 'closed', label: 'Exit / closing' },
                  { value: 'classified', label: 'Historical classification' },
                ].filter(
                  (option) =>
                    !correctionOf ||
                    option.value ===
                      records.find((record) => record.id === correctionOf)
                        ?.kind,
                )}
              />
            </label>
            <label className={styles.field} htmlFor={prefix + '-date'}>
              Effective date
              <Input
                id={prefix + '-date'}
                type="date"
                value={effectiveDate}
                onChange={(event) => {
                  changed();
                  setEffectiveDate(event.target.value);
                }}
              />
            </label>
            <label className={styles.field} htmlFor={prefix + '-correction'}>
              Version
              <Picker
                id={prefix + '-correction'}
                label="Position correction version"
                value={correctionOf || 'new'}
                onChange={(value) =>
                  correct(records.find((record) => record.id === value))
                }
                options={[
                  { value: 'new', label: 'New position record' },
                  ...records
                    .filter((record) => !superseded.has(record.id))
                    .map((record) => ({
                      value: record.id,
                      label: `${record.kind} · ${record.effectiveDate}`,
                    })),
                ]}
              />
            </label>
          </div>
          {kind !== 'closed' ? (
            <fieldset className="rounded-lg border p-4">
              <legend className="px-2 text-sm font-medium">
                Position details on the effective date
              </legend>
              <p className={styles.note}>
                These fields start from the current register. Confirm them
                against the dated source. Legal ownership remains within this
                position’s registered family and entity.
              </p>
              <div className={styles.fields + ' !px-0 !pb-0'}>
                <label className={styles.field} htmlFor={prefix + '-name'}>
                  Investment name
                  <Input
                    id={prefix + '-name'}
                    value={details.name}
                    onChange={(event) => {
                      changed();
                      setDetails((old) => ({
                        ...old,
                        name: event.target.value,
                      }));
                    }}
                  />
                </label>
                <label className={styles.field} htmlFor={prefix + '-manager'}>
                  Manager
                  <Input
                    id={prefix + '-manager'}
                    value={details.manager}
                    onChange={(event) => {
                      changed();
                      setDetails((old) => ({
                        ...old,
                        manager: event.target.value,
                      }));
                    }}
                  />
                </label>
                <label className={styles.field} htmlFor={prefix + '-account'}>
                  Account
                  <Picker
                    id={prefix + '-account'}
                    label="Historical position account"
                    value={details.accountId}
                    onChange={(value) => {
                      changed();
                      setDetails((old) => ({ ...old, accountId: value }));
                    }}
                    options={data.accounts
                      .filter(
                        (account) =>
                          account.familyId === holding.familyId &&
                          account.entityId === holding.entityId,
                      )
                      .map((account) => ({
                        value: account.id,
                        label: account.name,
                      }))}
                  />
                </label>
                <label className={styles.field} htmlFor={prefix + '-class'}>
                  Asset class
                  <Picker
                    id={prefix + '-class'}
                    label="Historical asset class"
                    value={details.assetClass}
                    onChange={(value) => {
                      changed();
                      setDetails((old) => ({
                        ...old,
                        assetClass:
                          value as HistoryPositionDetails['assetClass'],
                      }));
                    }}
                    options={[
                      'Public equities',
                      'Private equity',
                      'Venture capital',
                      'Real estate',
                      'Fixed income',
                      'Cash',
                    ].map((value) => ({ value, label: value }))}
                  />
                </label>
                <label className={styles.field} htmlFor={prefix + '-currency'}>
                  Source currency
                  <Picker
                    id={prefix + '-currency'}
                    label="Historical position currency"
                    value={details.currency}
                    onChange={(value) => {
                      changed();
                      setDetails((old) => ({
                        ...old,
                        currency: value as HistoryPositionDetails['currency'],
                      }));
                    }}
                    options={['EUR', 'USD', 'GBP', 'CHF'].map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                </label>
              </div>
            </fieldset>
          ) : null}
          <label className={styles.field} htmlFor={prefix + '-source'}>
            Accepted retained source
            <Picker
              id={prefix + '-source'}
              label="Position history source"
              value={sourceId || 'none'}
              onChange={(value) => {
                const next = sources.find((item) => item.id === value);
                changed();
                setSourceId(next?.id ?? '');
                setPreview(false);
                setOpenedSource('');
                setPage(String(next?.page ?? 1));
                setQuote(next?.excerpt ?? '');
              }}
              options={[
                { value: 'none', label: 'Choose a source for this investment' },
                ...sources.map((item) => ({
                  value: item.id,
                  label: `${item.filename} · ${item.effectiveDate} · ${item.id.slice(-6)}`,
                })),
              ]}
            />
          </label>
          {!sources.length ? (
            <p className={styles.note}>
              An accepted source with its retained original is required. Sample
              citations and sources linked to another investment cannot
              establish lifecycle history.
            </p>
          ) : null}
          {source?.documentId ? (
            <div className="rounded-lg border p-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPreview((value) => !value)}
              >
                {preview ? 'Close original preview' : 'Open retained original'}
              </Button>
              {preview ? (
                /\.pdf$/i.test(source.filename) ? (
                  <PdfPreview
                    key={source.id}
                    documentId={source.documentId}
                    onOpened={() => setOpenedSource(source.id)}
                    initialPage={source.page}
                  />
                ) : /\.eml$/i.test(source.filename) ? (
                  <EmailPreview
                    key={source.id}
                    documentId={source.documentId}
                    onOpened={() => setOpenedSource(source.id)}
                  />
                ) : (
                  <RetainedText
                    key={source.id}
                    documentId={source.documentId}
                    onOpened={() => setOpenedSource(source.id)}
                  />
                )
              ) : null}
            </div>
          ) : null}
          <label className={styles.field} htmlFor={prefix + '-page'}>
            Source page
            <Input
              id={prefix + '-page'}
              type="number"
              min={1}
              max={10000}
              value={page}
              onChange={(event) => {
                changed();
                setPage(event.target.value);
              }}
            />
          </label>
          <label className={styles.field} htmlFor={prefix + '-quote'}>
            Evidence quote
            <Textarea
              id={prefix + '-quote'}
              rows={4}
              maxLength={6000}
              value={quote}
              onChange={(event) => {
                changed();
                setQuote(event.target.value);
              }}
            />
          </label>
          <label className={styles.field} htmlFor={prefix + '-reason'}>
            Reason and what you verified
            <Textarea
              id={prefix + '-reason'}
              rows={3}
              maxLength={2000}
              value={reason}
              onChange={(event) => {
                changed();
                setReason(event.target.value);
              }}
            />
          </label>
          <label
            htmlFor={prefix + '-verified'}
            className="flex items-start gap-3 text-sm leading-relaxed"
          >
            <Checkbox
              id={prefix + '-verified'}
              checked={verified}
              disabled={!sourceId || openedSource !== sourceId || busy}
              onCheckedChange={(value) => setVerified(value === true)}
            />
            I checked the effective date, position details, page and quote
            against this original source. This is my reviewed attestation.
          </label>
          <div className="flex justify-end">
            <Button
              onClick={() => void save()}
              disabled={
                busy ||
                !verified ||
                (stale && !retryable) ||
                !effectiveDate ||
                !sourceId
              }
            >
              {busy
                ? 'Recording…'
                : correctionOf
                  ? 'Record lifecycle correction'
                  : 'Record position history'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function RetainedText({
  documentId,
  onOpened,
}: {
  documentId: string;
  onOpened: () => void;
}) {
  const { state } = useWorkspace();
  const organizationId = state.identity?.organizationId;
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  async function load() {
    if (!organizationId) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    try {
      const response = await fetch(
        '/api/documents/' + encodeURIComponent(documentId) + '/preview',
        {
          headers: { 'x-aster-organization': organizationId },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20_000),
          ]),
        },
      );
      if (!response.ok) throw new Error('The original could not be opened.');
      const text = await response.text();
      if (text.length > 1_000_000)
        throw new Error(
          'This original is too large for the bounded text preview.',
        );
      controller.signal.throwIfAborted();
      setValue(text);
      onOpened();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof Error
          ? cause.message
          : 'The original could not be opened.',
      );
    }
  }
  return (
    <div className="mt-3">
      {value ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
          {value}
        </pre>
      ) : (
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Load original text
        </Button>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
