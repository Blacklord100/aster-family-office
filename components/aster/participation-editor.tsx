'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { EvidenceSource, Holding } from '@/data';
import {
  participationRequestSchema,
  type InvestmentIdentity,
  type ParticipationRecord,
  type ParticipationRequest,
  type ParticipationResponse,
} from '@/lib/participation-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@/components/ui/field';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { useWorkspace } from './workspace-context';
import { Picker, dateLabel } from './primitives';
import { PdfPreview } from './pdf-preview';
import { EmailPreview } from './email-preview';
import styles from './participation.module.css';

export function ParticipationEditor({
  open,
  onOpenChange,
  holding,
  response,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  holding: Holding;
  response: ParticipationResponse;
  onSaved: () => void;
}) {
  const { state } = useWorkspace();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[880px] max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review deal participation</DialogTitle>
          <DialogDescription>
            Connect {holding.name} to its documented vehicle, share class and
            round. Each family keeps its own legal position and financial
            history.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <ParticipationForm
            key={JSON.stringify([
              state.identity?.organizationId,
              state.identity?.dataScope,
              holding.id,
            ])}
            holding={holding}
            response={response}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ParticipationForm({
  holding,
  response,
  onSaved,
}: {
  holding: Holding;
  response: ParticipationResponse;
  onSaved: () => void;
}) {
  const { state, data, reload } = useWorkspace();
  const prefix = useId();
  const sources = (data.evidence as EvidenceSource[]).filter(
    (source) =>
      source.holdingId === holding.id &&
      source.familyId === holding.familyId &&
      source.status === 'Accepted' &&
      !source.synthetic &&
      source.documentId,
  );
  const records = response.records
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
  const active = response.investments.find((investment) =>
    investment.positions.some((position) => position.holdingId === holding.id),
  );
  const [baseRevision, setBaseRevision] = useState(response.revision);
  const [kind, setKind] = useState<'link' | 'unlink' | 'ownership'>('link');
  const [investmentId, setInvestmentId] = useState(active?.id ?? 'new');
  const [identity, setIdentity] = useState<InvestmentIdentity>({
    name: holding.name,
    manager: holding.manager === 'Not reported' ? '' : holding.manager,
    vehicle: '',
    shareClass: '',
    round: '',
  });
  const [effectiveDate, setEffectiveDate] = useState('');
  const [percent, setPercent] = useState('');
  const [ownershipBasis, setOwnershipBasis] = useState('');
  const [correctionOf, setCorrectionOf] = useState('');
  const [sourceId, setSourceId] = useState('');
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
    request: ParticipationRequest;
  } | null>(null);
  const source = sources.find((item) => item.id === sourceId);
  const selected = response.catalog.find((item) => item.id === investmentId);
  const stale = response.revision !== baseRevision;
  function changed() {
    setVerified(false);
    setSaved('');
    pending.current = null;
    setRetryable(false);
  }
  function correct(record?: ParticipationRecord) {
    changed();
    setCorrectionOf(record?.id ?? '');
    setKind(record?.kind ?? 'link');
    setEffectiveDate(record?.effectiveDate ?? '');
    setInvestmentId(record?.investmentId ?? active?.id ?? 'new');
    setPercent(record?.percent ?? '');
    setOwnershipBasis(record?.ownershipBasis ?? '');
    setSourceId('');
    setOpenedSource('');
    setPreview(false);
    setQuote('');
    setReason('');
  }
  async function save() {
    if (busy || !response.canWrite || !state.identity) return;
    setError('');
    setSaved('');
    const command = {
      holdingId: holding.id,
      kind,
      effectiveDate,
      sourceId,
      page: Number(page),
      quote,
      reason,
      evidenceVerified: verified && openedSource === sourceId,
      ...(correctionOf ? { correctionOf } : {}),
      ...(kind === 'link'
        ? investmentId === 'new'
          ? {
              newInvestment: {
                ...identity,
                ...(identity.identifier?.trim()
                  ? {}
                  : { identifier: undefined }),
              },
            }
          : { investmentId }
        : {}),
      ...(kind === 'ownership' ? { percent, ownershipBasis } : {}),
    };
    const serialized = JSON.stringify(command);
    const parsed = participationRequestSchema.safeParse(
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
      const result = await fetch('/api/participation', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'x-aster-organization': state.identity.organizationId,
        },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await result.json().catch(() => null);
      if (!result.ok)
        throw new Error(
          payload?.message ?? 'Participation could not be saved.',
        );
      if (!payload?.resultId || !Number.isInteger(payload.revision))
        throw new Error(
          'The save response was incomplete. Retry the same submission safely.',
        );
      setBaseRevision(payload.revision);
      setVerified(false);
      pending.current = null;
      setRetryable(false);
      setSaved(
        payload.duplicate
          ? 'This exact record was already saved. No duplicate was created.'
          : 'Participation saved with its source. Earlier records remain available.',
      );
      reload();
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Participation could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.editor}>
      <div className={styles.positionContext}>
        <strong>
          {data.families.find((family) => family.id === holding.familyId)?.name}
        </strong>
        <span>
          {data.entities.find((entity) => entity.id === holding.entityId)?.name}
        </span>
        <span>
          {
            data.accounts.find((account) => account.id === holding.accountId)
              ?.name
          }
        </span>
      </div>
      {records.length ? (
        <details>
          <summary className={styles.recordSummary}>
            Retained participation records ({records.length})
          </summary>
          <div className={styles.records}>
            {records.map((record) => (
              <div key={record.id}>
                <strong>
                  {record.kind} · {dateLabel(record.effectiveDate)}
                  {superseded.has(record.id) ? ' · Superseded' : ''}
                </strong>
                <p>{record.reason}</p>
                <p>{record.quote}</p>
                {!superseded.has(record.id) && response.canWrite ? (
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
      ) : null}
      {!response.canWrite ? (
        <Alert>
          <AlertTitle>Review access required</AlertTitle>
          <AlertDescription>
            An unrestricted workspace editor can record participation and actual
            ownership.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {stale ? (
            <Alert>
              <AlertTitle>Workspace data changed</AlertTitle>
              <AlertDescription>
                Your draft is preserved. Review the latest participation before
                saving.
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setBaseRevision(response.revision);
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
              <AlertTitle>Participation needs attention</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {saved ? (
            <Alert>
              <AlertTitle>Participation updated</AlertTitle>
              <AlertDescription>{saved}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup className={styles.fields}>
            <Field>
              <FieldLabel htmlFor={prefix + '-kind'}>Record type</FieldLabel>
              <Picker
                id={prefix + '-kind'}
                label="Participation record type"
                value={kind}
                onChange={(value) => {
                  changed();
                  setKind(value as typeof kind);
                }}
                options={[
                  { value: 'link', label: 'Link position to a deal' },
                  { value: 'ownership', label: 'Record actual ownership' },
                  { value: 'unlink', label: 'End a participation link' },
                ].filter(
                  (option) =>
                    !correctionOf ||
                    option.value ===
                      records.find((record) => record.id === correctionOf)
                        ?.kind,
                )}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={prefix + '-date'}>Effective date</FieldLabel>
              <Input
                id={prefix + '-date'}
                type="date"
                value={effectiveDate}
                onChange={(event) => {
                  changed();
                  setEffectiveDate(event.target.value);
                }}
              />
              <FieldDescription>
                Use the date stated by the source.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={prefix + '-version'}>Version</FieldLabel>
              <Picker
                id={prefix + '-version'}
                label="Participation record version"
                value={correctionOf || 'new'}
                onChange={(value) =>
                  correct(records.find((record) => record.id === value))
                }
                options={[
                  { value: 'new', label: 'New participation record' },
                  ...records
                    .filter((record) => !superseded.has(record.id))
                    .map((record) => ({
                      value: record.id,
                      label: `${record.kind} · ${record.effectiveDate}`,
                    })),
                ]}
              />
            </Field>
          </FieldGroup>
          {kind === 'link' ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={prefix + '-investment'}>
                  Shared investment identity
                </FieldLabel>
                <Picker
                  id={prefix + '-investment'}
                  label="Shared investment identity"
                  value={investmentId}
                  onChange={(value) => {
                    changed();
                    setInvestmentId(value);
                  }}
                  options={[
                    { value: 'new', label: 'Register a new shared deal' },
                    ...response.catalog.map((item) => ({
                      value: item.id,
                      label: `${item.identity.name} · ${item.identity.vehicle} · ${item.identity.shareClass} · ${item.identity.round}`,
                    })),
                  ]}
                />
                <FieldDescription>
                  Confirm the legal vehicle, share class and round. A similar
                  fund or company name does not establish the same investment.
                </FieldDescription>
              </Field>
              {investmentId === 'new' ? (
                <FieldGroup className={styles.identityFields}>
                  {(
                    [
                      {
                        key: 'name',
                        label: 'Deal name',
                        placeholder: 'Investment as named in the source',
                      },
                      {
                        key: 'manager',
                        label: 'Manager',
                        placeholder: 'Documented manager or issuer',
                      },
                      {
                        key: 'vehicle',
                        label: 'Legal vehicle',
                        placeholder: 'Exact fund, company or SPV',
                      },
                      {
                        key: 'shareClass',
                        label: 'Share class',
                        placeholder:
                          'Class A, common shares, or documented N/A',
                      },
                      {
                        key: 'round',
                        label: 'Round / series',
                        placeholder:
                          'Series B, fund vintage, or documented N/A',
                      },
                      {
                        key: 'identifier',
                        label: 'Identifier (optional)',
                        placeholder: 'ISIN or another documented identifier',
                      },
                    ] as const
                  ).map((field) => (
                    <Field key={field.key}>
                      <FieldLabel htmlFor={prefix + '-' + field.key}>
                        {field.label}
                      </FieldLabel>
                      <Input
                        id={prefix + '-' + field.key}
                        value={identity[field.key] ?? ''}
                        maxLength={240}
                        placeholder={field.placeholder}
                        onChange={(event) => {
                          changed();
                          setIdentity((old) => ({
                            ...old,
                            [field.key]: event.target.value,
                          }));
                        }}
                      />
                    </Field>
                  ))}
                </FieldGroup>
              ) : selected ? (
                <div className={styles.identityReview}>
                  <strong>{selected.identity.name}</strong>
                  <p>
                    {selected.identity.manager} · {selected.identity.vehicle}
                  </p>
                  <p>
                    {selected.identity.shareClass} · {selected.identity.round}
                    {selected.identity.identifier
                      ? ' · ' + selected.identity.identifier
                      : ''}
                  </p>
                </div>
              ) : null}
            </FieldGroup>
          ) : kind === 'ownership' ? (
            <FieldGroup className={styles.identityFields}>
              <Field>
                <FieldLabel htmlFor={prefix + '-percent'}>
                  Actual ownership (%)
                </FieldLabel>
                <Input
                  id={prefix + '-percent'}
                  inputMode="decimal"
                  value={percent}
                  placeholder="2.5"
                  onChange={(event) => {
                    changed();
                    setPercent(event.target.value);
                  }}
                />
                <FieldDescription>
                  A sourced percentage from 0 to 100. Never inferred from the
                  families visible in Aster.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={prefix + '-basis'}>
                  Ownership denominator
                </FieldLabel>
                <Input
                  id={prefix + '-basis'}
                  value={ownershipBasis}
                  placeholder="e.g. All issued Class A units"
                  maxLength={240}
                  onChange={(event) => {
                    changed();
                    setOwnershipBasis(event.target.value);
                  }}
                />
              </Field>
            </FieldGroup>
          ) : (
            <Alert>
              <AlertTitle>End the identity link</AlertTitle>
              <AlertDescription>
                This records when the position stopped belonging to this shared
                deal. It does not sell the asset, record an exit, or change its
                NAV.
              </AlertDescription>
            </Alert>
          )}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={prefix + '-source'}>
                Accepted retained source
              </FieldLabel>
              <Picker
                id={prefix + '-source'}
                label="Participation source"
                value={sourceId || 'none'}
                onChange={(value) => {
                  const next = sources.find((item) => item.id === value);
                  changed();
                  setSourceId(next?.id ?? '');
                  setPage(String(next?.page ?? 1));
                  setQuote(next?.excerpt ?? '');
                  setPreview(false);
                  setOpenedSource('');
                }}
                options={[
                  { value: 'none', label: 'Choose a source for this position' },
                  ...sources.map((item) => ({
                    value: item.id,
                    label: `${item.filename} · ${item.effectiveDate} · ${item.id.slice(-6)}`,
                  })),
                ]}
              />
              <FieldDescription>
                {sources.length
                  ? 'Open the retained original and confirm the identity and date.'
                  : 'An accepted source with a retained original is required. Add and review the source in Documents first.'}
              </FieldDescription>
            </Field>
            {source?.documentId ? (
              <div className={styles.preview}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPreview((value) => !value)}
                >
                  {preview
                    ? 'Close original preview'
                    : 'Open retained original'}
                </Button>
                {preview ? (
                  /\.pdf$/i.test(source.filename) ? (
                    <PdfPreview
                      key={source.id}
                      documentId={source.documentId}
                      initialPage={Number(page)}
                      onOpened={() => setOpenedSource(source.id)}
                    />
                  ) : /\.eml$/i.test(source.filename) ? (
                    <EmailPreview
                      key={source.id}
                      documentId={source.documentId}
                      onOpened={() => setOpenedSource(source.id)}
                    />
                  ) : (
                    <ParticipationTextPreview
                      key={source.id}
                      documentId={source.documentId}
                      onOpened={() => setOpenedSource(source.id)}
                    />
                  )
                ) : null}
              </div>
            ) : null}
            <Field>
              <FieldLabel htmlFor={prefix + '-page'}>Source page</FieldLabel>
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
            </Field>
            <Field>
              <FieldLabel htmlFor={prefix + '-quote'}>
                Evidence quote
              </FieldLabel>
              <Textarea
                id={prefix + '-quote'}
                rows={3}
                maxLength={6000}
                value={quote}
                onChange={(event) => {
                  changed();
                  setQuote(event.target.value);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={prefix + '-reason'}>
                Reason and what you verified
              </FieldLabel>
              <Textarea
                id={prefix + '-reason'}
                rows={2}
                maxLength={2000}
                value={reason}
                onChange={(event) => {
                  changed();
                  setReason(event.target.value);
                }}
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id={prefix + '-verified'}
                checked={verified}
                disabled={!sourceId || sourceId !== openedSource || busy}
                onCheckedChange={(value) => setVerified(value === true)}
              />
              <FieldLabel htmlFor={prefix + '-verified'}>
                I checked this position, investment identity, effective date and
                evidence against the retained original.
              </FieldLabel>
            </Field>
          </FieldGroup>
          <div className={styles.actionsEnd}>
            <Button
              onClick={() => void save()}
              disabled={busy || !verified || (stale && !retryable)}
            >
              {busy
                ? 'Saving…'
                : retryable
                  ? 'Retry the same submission'
                  : correctionOf
                    ? 'Save participation correction'
                    : 'Save reviewed participation'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function ParticipationTextPreview({
  documentId,
  onOpened,
}: {
  documentId: string;
  onOpened: () => void;
}) {
  const { state } = useWorkspace();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function load() {
    if (!state.identity || busy) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        '/api/documents/' + encodeURIComponent(documentId) + '/preview',
        {
          headers: { 'x-aster-organization': state.identity.organizationId },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([
            current.signal,
            AbortSignal.timeout(20_000),
          ]),
        },
      );
      if (!response.ok) throw new Error('The original could not be opened.');
      if (Number(response.headers.get('content-length')) > 1_000_000)
        throw new Error('This original exceeds the text preview limit.');
      const value = await response.text();
      if (value.length > 1_000_000)
        throw new Error('This original exceeds the text preview limit.');
      current.signal.throwIfAborted();
      setText(value);
      onOpened();
    } catch (cause) {
      if (!current.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'The original could not be opened.',
        );
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className={styles.textPreview}>
      {text ? (
        <pre>{text}</pre>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={busy}
        >
          {busy ? 'Loading…' : 'Load original text'}
        </Button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
