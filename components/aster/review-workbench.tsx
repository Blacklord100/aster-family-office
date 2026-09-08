'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, FileText, Loader2, Plus, Save } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Holding } from '@/data/types';
import type { ExtractedFact, ProcessingJob } from '@/lib/processing-contract';
import {
  ReviewDecisionSchema,
  reviewedFact,
  type FactReview,
  type ReviewDecision,
} from '@/lib/review-contract';
import {
  LEDGER_CURRENCIES,
  ledgerRequestSchema,
  type LedgerResponse,
} from '@/lib/ledger-contract';
import { factAcceptanceIssue, suggestHoldings } from '@/lib/fact-review';
import { useWorkspace } from './workspace-context';
import styles from './review-workbench.module.css';
import { PdfPreview } from './pdf-preview';

type Props = {
  job: ProcessingJob;
  holdings: Holding[];
  canWrite: boolean;
  busy: boolean;
  onReview: (
    decisions: ReviewDecision[],
    expectedRevision: number,
  ) => Promise<boolean>;
};
const labels = {
  pending: 'Pending',
  accepted: 'Accepted',
  deferred: 'Deferred',
  rejected: 'Rejected',
  legacy: 'Legacy decision unavailable',
};
const choices = ['pending', 'accepted', 'deferred', 'rejected'] as const;
const kinds = [
  { value: 'valuation', label: 'Valuation' },
  { value: 'capital_call', label: 'Capital call' },
  { value: 'distribution', label: 'Distribution' },
  { value: 'news', label: 'Manager update' },
];
function initialDecision(
  record: FactReview | undefined,
  factIndex: number,
): ReviewDecision {
  return {
    factIndex,
    status:
      record?.status === 'legacy' ? 'pending' : (record?.status ?? 'pending'),
    holdingId: record?.holdingId ?? null,
    amendedFact: record?.amendedFact,
    rationale: record?.rationale ?? '',
    evidenceVerified: false,
    fx: record?.fx,
  };
}
function SelectField({
  id,
  label,
  value,
  items,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string | null;
  items: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Field data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value}
        items={items}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

export function ReviewWorkbench({
  job,
  holdings,
  canWrite,
  busy,
  onReview,
}: Props) {
  const { data, reload } = useWorkspace();
  const [filter, setFilter] = useState('all');
  const [selectedIndex, setSelected] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, ReviewDecision>>({});
  const [editRevision, setEditRevision] = useState<number | null>(null);
  const [opened, setOpened] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const saveLock = useRef(false);
  const facts = job.result?.facts ?? [];
  const indices = facts
    .map((_, index) => index)
    .filter(
      (index) =>
        filter === 'all' ||
        (job.review?.facts[index]?.status ?? 'pending') === filter,
    );
  const selected = indices.includes(selectedIndex)
    ? selectedIndex
    : (indices[0] ?? selectedIndex);
  const revision = job.review?.revision ?? 0;
  const stale = editRevision !== null && editRevision !== revision;
  const record = job.review?.facts[selected];
  const original = facts[selected];
  const draft = drafts[selected] ?? initialDecision(record, selected);
  const fact = original ? reviewedFact(original, draft) : null;
  const holding = holdings.find((item) => item.id === draft.holdingId);
  const prior =
    fact?.kind === 'valuation' && holding && fact.effectiveDate
      ? (data.history.find(
          (row) =>
            row.holdingId === holding.id && row.date === fact.effectiveDate,
        )?.valueEUR ??
        (holding.valuationDate === fact.effectiveDate
          ? holding.valueEUR
          : undefined))
      : undefined;
  const disabled =
    !canWrite ||
    busy ||
    saving ||
    record?.status === 'legacy' ||
    (record?.status === 'accepted' && fact?.kind !== 'valuation');
  function update(patch: Partial<ReviewDecision>) {
    setEditRevision((current) => current ?? revision);
    setDrafts((current) => ({
      ...current,
      [selected]: {
        ...(current[selected] ?? initialDecision(record, selected)),
        ...patch,
      },
    }));
    setError(null);
  }
  function amend(patch: Partial<ExtractedFact>) {
    if (fact)
      update({
        amendedFact: { ...fact, ...patch },
        ...(patch.currency !== undefined ? { fx: undefined } : {}),
        evidenceVerified: false,
      });
  }
  async function save() {
    if (saveLock.current || disabled || stale || !fact) return;
    const validated = ReviewDecisionSchema.safeParse(draft);
    const issue =
      draft.status === 'accepted' ? factAcceptanceIssue(fact, draft.fx) : null;
    if (!validated.success || issue) {
      setError(
        issue ??
          validated.error?.issues[0]?.message ??
          'Check the review fields.',
      );
      return;
    }
    saveLock.current = true;
    setSaving(true);
    try {
      if (await onReview([validated.data], editRevision ?? revision)) {
        setDrafts((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([index]) => Number(index) !== selected,
            ),
          ),
        );
        setEditRevision(
          Object.keys(drafts).some((index) => Number(index) !== selected)
            ? revision + 1
            : null,
        );
        setError(null);
      }
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  return (
    <section
      className={styles.workbench}
      aria-label="Document review workbench"
    >
      <div className={styles.intro}>
        <div>
          <h4>Review workbench</h4>
          <p>
            Accept facts individually. Pending and deferred facts stay open;
            amendments preserve the original extraction.
          </p>
        </div>
        <Badge variant="outline">Review revision {revision}</Badge>
      </div>
      {stale ? (
        <Alert>
          <AlertTitle>Another reviewer updated this document</AlertTitle>
          <AlertDescription>
            Your unsaved values are still shown. Reload the latest decisions
            before making a new decision.
          </AlertDescription>
          <Button
            variant="outline"
            onClick={() => {
              setDrafts({});
              setEditRevision(null);
              setError(null);
            }}
          >
            Reload decisions
          </Button>
        </Alert>
      ) : null}
      {job.review?.facts.some((item) => item.status === 'legacy') ? (
        <Alert>
          <AlertTitle>Older review</AlertTitle>
          <AlertDescription>
            This review predates per-fact records. Its original extraction is
            retained, but accepted and unselected facts cannot be reconstructed.
            Submit a new source for corrections.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className={styles.layout}>
        <aside className={styles.source} aria-label="Original source">
          <div className={styles.sourceHeading}>
            <FileText aria-hidden="true" />
            <strong>Original source</strong>
          </div>
          <p className={styles.hint}>
            Compare the actual document with each quote. Extracted quotes have
            not been independently verified by Aster.
          </p>
          <div className={styles.actions}>
            <Button
              variant="outline"
              onClick={() => setPreview((current) => !current)}
            >
              {preview ? 'Close source preview' : 'Open source preview'}
            </Button>
            <a
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              href={'/api/documents/' + job.documentId}
              onClick={() => setOpened(true)}
            >
              Download original
            </a>
          </div>
          {preview && /\.pdf$/i.test(job.filename) ? (
            <PdfPreview
              key={job.documentId}
              documentId={job.documentId}
              onOpened={() => setOpened(true)}
            />
          ) : preview ? (
            <iframe
              title="Original document source"
              className={styles.frame}
              src={'/api/documents/' + job.documentId + '/preview'}
              sandbox="allow-same-origin"
              onLoad={() => setOpened(true)}
            />
          ) : (
            <div className={styles.previewEmpty}>
              <FileText aria-hidden="true" />
              <p>Open the original to begin source verification.</p>
            </div>
          )}
          <p className={styles.hint}>
            PDFs use a bounded visual reader. Email previews show raw source
            text, including MIME boundaries; download the original to inspect
            encoded bodies or attachments. No email HTML or external resources
            are executed.
          </p>
        </aside>
        <div className={styles.review}>
          <FieldGroup>
            <SelectField
              id={'review-filter-' + job.id}
              label="Decision filter"
              value={filter}
              items={[
                { value: 'all', label: 'All facts (' + facts.length + ')' },
                ...choices.map((status) => ({
                  value: status,
                  label:
                    labels[status] +
                    ' (' +
                    (job.review?.facts.filter((r) => r.status === status)
                      .length ?? (status === 'pending' ? facts.length : 0)) +
                    ')',
                })),
              ]}
              onChange={(value) => {
                setFilter(value);
                const first = facts.findIndex(
                  (_, i) =>
                    value === 'all' || job.review?.facts[i]?.status === value,
                );
                if (first >= 0) setSelected(first);
              }}
            />
            <SelectField
              id={'review-fact-' + job.id}
              label="Fact"
              value={indices.includes(selected) ? String(selected) : null}
              disabled={!indices.length}
              items={indices.map((index) => ({
                value: String(index),
                label:
                  index +
                  1 +
                  '. ' +
                  facts[index].investmentName +
                  ' · ' +
                  labels[job.review?.facts[index]?.status ?? 'pending'],
              }))}
              onChange={(value) => {
                setSelected(Number(value));
                setError(null);
                setCreating(false);
              }}
            />
          </FieldGroup>
          {!indices.length ? (
            <p className={styles.hint}>No facts in this decision category.</p>
          ) : fact && original ? (
            <article className={styles.fact}>
              <div className={styles.intro}>
                <h4>{fact.investmentName}</h4>
                <Badge variant="secondary">
                  {labels[record?.status ?? 'pending']}
                </Badge>
              </div>
              <p>{fact.summary}</p>
              <dl className={styles.facts}>
                <div>
                  <dt>Reported amount</dt>
                  <dd>
                    {fact.currency ?? 'Unknown currency'}{' '}
                    {fact.amount ?? 'Not reported'}
                  </dd>
                </div>
                <div>
                  <dt>Effective date</dt>
                  <dd>{fact.effectiveDate ?? 'Not reported'}</dd>
                </div>
              </dl>
              <div className={styles.quote}>
                <span>Candidate source quote · Page {fact.evidence.page}</span>
                <blockquote>{fact.evidence.quote}</blockquote>
              </div>
              {record?.reviewedAt ? (
                <p className={styles.hint}>
                  Decision version {record.version} ·{' '}
                  {new Date(record.reviewedAt).toLocaleString('en-GB')} ·
                  Reviewer {record.reviewedBy}
                  {record.rationale ? ' · ' + record.rationale : ''}
                </p>
              ) : null}
              <details className={styles.details}>
                <summary>Original model extraction · unchanged</summary>
                <pre>{JSON.stringify(original, null, 2)}</pre>
              </details>
              <FieldGroup>
                <SelectField
                  id={'review-holding-' + job.id + '-' + selected}
                  label="Link to investment"
                  value={draft.holdingId}
                  items={holdings.map((h) => ({
                    value: h.id,
                    label:
                      h.name +
                      ' · ' +
                      (data.families.find((family) => family.id === h.familyId)
                        ?.name ?? h.familyId) +
                      ' · ' +
                      (data.accounts.find((a) => a.id === h.accountId)?.name ??
                        h.accountId),
                  }))}
                  onChange={(holdingId) =>
                    update({
                      holdingId,
                      evidenceVerified: false,
                      correction: undefined,
                    })
                  }
                  disabled={disabled || record?.status === 'accepted'}
                />
                {!disabled && record?.status !== 'accepted' ? (
                  <>
                    <div className={styles.suggestions}>
                      {suggestHoldings(fact, holdings).map(
                        ({ holding: candidate, reason }) => (
                          <Button
                            key={candidate.id}
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              update({
                                holdingId: candidate.id,
                                evidenceVerified: false,
                              })
                            }
                          >
                            {reason}: {candidate.name}
                          </Button>
                        ),
                      )}
                    </div>
                    <p className={styles.hint}>
                      Name matches are suggestions. Confirm the family, account
                      and investment explicitly.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => setCreating((value) => !value)}
                    >
                      <Plus data-icon="inline-start" />
                      Create and link investment
                    </Button>
                  </>
                ) : null}
              </FieldGroup>
              {creating ? (
                <CreateLinkedHolding
                  job={job}
                  fact={fact}
                  fx={draft.fx}
                  opened={opened}
                  onCreated={(id) => {
                    update({ holdingId: id, evidenceVerified: false });
                    setCreating(false);
                    reload();
                  }}
                  onCancel={() => setCreating(false)}
                />
              ) : null}
              {!disabled ? (
                <>
                  <details className={styles.details}>
                    <summary>Amend reviewed values</summary>
                    <FieldSet>
                      <FieldLegend>Reviewer amendment</FieldLegend>
                      <FieldDescription>
                        The source extraction remains unchanged. Describe why
                        you changed these values below.
                      </FieldDescription>
                      <FieldGroup>
                        <SelectField
                          id={'fact-kind-' + selected}
                          label="Fact type"
                          value={fact.kind}
                          items={kinds}
                          disabled={record?.status === 'accepted'}
                          onChange={(kind) =>
                            amend({ kind: kind as ExtractedFact['kind'] })
                          }
                        />
                        <Field>
                          <FieldLabel htmlFor={'fact-name-' + selected}>
                            Investment name in source
                          </FieldLabel>
                          <Input
                            id={'fact-name-' + selected}
                            value={fact.investmentName}
                            maxLength={300}
                            onChange={(e) =>
                              amend({ investmentName: e.target.value })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={'fact-amount-' + selected}>
                            Reported amount
                          </FieldLabel>
                          <Input
                            id={'fact-amount-' + selected}
                            inputMode="decimal"
                            value={fact.amount ?? ''}
                            maxLength={28}
                            onChange={(e) =>
                              amend({ amount: e.target.value || null })
                            }
                          />
                          <FieldDescription>
                            Leave blank only when the source does not report an
                            amount.
                          </FieldDescription>
                        </Field>
                        <SelectField
                          id={'fact-currency-' + selected}
                          label="Source currency"
                          value={fact.currency}
                          items={LEDGER_CURRENCIES.map((value) => ({
                            value,
                            label: value,
                          }))}
                          onChange={(currency) => amend({ currency })}
                        />
                        <Field>
                          <FieldLabel htmlFor={'fact-date-' + selected}>
                            Effective date
                          </FieldLabel>
                          <Input
                            id={'fact-date-' + selected}
                            type="date"
                            value={fact.effectiveDate ?? ''}
                            disabled={record?.status === 'accepted'}
                            onChange={(e) =>
                              amend({ effectiveDate: e.target.value || null })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={'fact-due-' + selected}>
                            Due date
                          </FieldLabel>
                          <Input
                            id={'fact-due-' + selected}
                            type="date"
                            value={fact.dueDate ?? ''}
                            onChange={(e) =>
                              amend({ dueDate: e.target.value || null })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={'fact-summary-' + selected}>
                            Reviewed summary
                          </FieldLabel>
                          <Textarea
                            id={'fact-summary-' + selected}
                            value={fact.summary}
                            maxLength={3000}
                            onChange={(e) => amend({ summary: e.target.value })}
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={'fact-quote-' + selected}>
                            Verified source quote
                          </FieldLabel>
                          <Textarea
                            id={'fact-quote-' + selected}
                            value={fact.evidence.quote}
                            maxLength={6000}
                            onChange={(e) =>
                              amend({
                                evidence: {
                                  ...fact.evidence,
                                  quote: e.target.value,
                                },
                              })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={'fact-page-' + selected}>
                            Source page
                          </FieldLabel>
                          <Input
                            id={'fact-page-' + selected}
                            type="number"
                            min={1}
                            max={100}
                            value={fact.evidence.page}
                            onChange={(e) =>
                              amend({
                                evidence: {
                                  ...fact.evidence,
                                  page: Number(e.target.value),
                                },
                              })
                            }
                          />
                        </Field>
                      </FieldGroup>
                    </FieldSet>
                  </details>
                  {fact.kind === 'valuation' && fact.currency !== 'EUR' ? (
                    <FieldSet>
                      <FieldLegend>Reviewed FX conversion</FieldLegend>
                      <FieldDescription>
                        Preserve the reported currency. Enter the dated, sourced
                        EUR rate you checked.
                      </FieldDescription>
                      <FieldGroup>
                        {(
                          [
                            {
                              key: 'rateToEUR',
                              label: 'EUR per unit of source currency',
                              type: 'text',
                            },
                            {
                              key: 'date',
                              label: 'FX rate date',
                              type: 'date',
                            },
                            {
                              key: 'source',
                              label: 'FX source / reference',
                              type: 'text',
                            },
                          ] as const
                        ).map((field) => (
                          <Field key={field.key}>
                            <FieldLabel
                              htmlFor={'fx-' + field.key + '-' + selected}
                            >
                              {field.label}
                            </FieldLabel>
                            <Input
                              id={'fx-' + field.key + '-' + selected}
                              type={field.type}
                              maxLength={240}
                              value={draft.fx?.[field.key] ?? ''}
                              onChange={(e) =>
                                update({
                                  fx: {
                                    rateToEUR: '',
                                    date: '',
                                    source: '',
                                    ...draft.fx,
                                    [field.key]: e.target.value,
                                  },
                                  evidenceVerified: false,
                                })
                              }
                            />
                          </Field>
                        ))}
                      </FieldGroup>
                    </FieldSet>
                  ) : null}
                  {fact.kind === 'valuation' && prior !== undefined ? (
                    <FieldSet>
                      <FieldLegend>Existing mark for this date</FieldLegend>
                      <FieldDescription>
                        Current recorded value: EUR{' '}
                        {prior.toLocaleString('en-GB', {
                          maximumFractionDigits: 2,
                        })}
                        . A different value needs an explicit correction. Both
                        versions remain in history.
                      </FieldDescription>
                      <FieldGroup>
                        <Field orientation="horizontal">
                          <Checkbox
                            id={'correction-' + selected}
                            checked={!!draft.correction}
                            onCheckedChange={(checked) =>
                              update({
                                correction: checked
                                  ? { expectedValueEUR: prior, reason: '' }
                                  : undefined,
                              })
                            }
                          />
                          <FieldContent>
                            <FieldLabel htmlFor={'correction-' + selected}>
                              I intend to correct this recorded valuation
                            </FieldLabel>
                          </FieldContent>
                        </Field>
                        {draft.correction ? (
                          <Field>
                            <FieldLabel
                              htmlFor={'correction-reason-' + selected}
                            >
                              Correction reason
                            </FieldLabel>
                            <Textarea
                              id={'correction-reason-' + selected}
                              value={draft.correction.reason}
                              maxLength={2000}
                              onChange={(e) =>
                                update({
                                  correction: {
                                    expectedValueEUR:
                                      draft.correction!.expectedValueEUR,
                                    reason: e.target.value,
                                  },
                                })
                              }
                            />
                          </Field>
                        ) : null}
                      </FieldGroup>
                    </FieldSet>
                  ) : null}
                  <FieldGroup>
                    <SelectField
                      id={'decision-' + selected}
                      label="Review decision"
                      value={draft.status}
                      items={choices
                        .filter(
                          (value) =>
                            record?.status !== 'accepted' ||
                            value === 'accepted',
                        )
                        .map((value) => ({ value, label: labels[value] }))}
                      onChange={(status) =>
                        update({ status: status as ReviewDecision['status'] })
                      }
                    />
                    <Field>
                      <FieldLabel htmlFor={'rationale-' + selected}>
                        Review rationale
                      </FieldLabel>
                      <Textarea
                        id={'rationale-' + selected}
                        value={draft.rationale}
                        maxLength={2000}
                        onChange={(e) => update({ rationale: e.target.value })}
                      />
                      <FieldDescription>
                        Required for amendments, deferrals and rejections.
                        Record what you checked or what remains unresolved.
                      </FieldDescription>
                    </Field>
                    <Field orientation="horizontal" data-disabled={!opened}>
                      <Checkbox
                        id={'verified-' + selected}
                        disabled={!opened}
                        checked={draft.evidenceVerified}
                        onCheckedChange={(checked) =>
                          update({ evidenceVerified: checked })
                        }
                      />
                      <FieldContent>
                        <FieldLabel htmlFor={'verified-' + selected}>
                          I checked the values, page and quote against the
                          original source, and confirmed the investment link.
                        </FieldLabel>
                        <FieldDescription>
                          Open or download the source first. An extracted quote
                          alone is not verification.
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  </FieldGroup>
                  {error ? <FieldError role="alert">{error}</FieldError> : null}
                  <Button
                    disabled={
                      disabled ||
                      stale ||
                      (record?.status === 'accepted' && !draft.correction)
                    }
                    onClick={() => void save()}
                  >
                    {saving ? (
                      <Loader2
                        data-icon="inline-start"
                        className="animate-spin"
                      />
                    ) : draft.status === 'accepted' ? (
                      <Check data-icon="inline-start" />
                    ) : (
                      <Save data-icon="inline-start" />
                    )}
                    {record?.status === 'accepted'
                      ? 'Record valuation correction'
                      : draft.status === 'accepted'
                        ? 'Accept this fact'
                        : 'Save ' +
                          labels[draft.status].toLowerCase() +
                          ' decision'}
                  </Button>
                  <p className={styles.hint}>
                    Acceptance records a source-linked fact. Valuations update
                    reviewed marks; notices do not settle cash or execute
                    payments. Other facts remain unchanged.
                  </p>
                </>
              ) : null}
            </article>
          ) : null}
        </div>
      </div>
      {job.review?.history.length ? (
        <details className={styles.details}>
          <summary>
            Review history · latest {job.review.history.length} revisions
          </summary>
          {[...job.review.history].reverse().map((version) => (
            <article key={version.revision}>
              <strong>
                Revision {version.revision} ·{' '}
                {new Date(version.at).toLocaleString('en-GB')}
              </strong>
              <p className={styles.hint}>Reviewer {version.actorId}</p>
              {version.decisions.map((decision) => (
                <div key={decision.factIndex}>
                  <p>
                    Fact {decision.factIndex + 1}: {labels[decision.status]}
                    {decision.amendedFact ? ' · amended values retained' : ''}
                    {decision.correction
                      ? ' · correction: ' + decision.correction.reason
                      : ''}
                    {decision.rationale ? ' · ' + decision.rationale : ''}
                  </p>
                  <details className={styles.details}>
                    <summary>Reviewed values and evidence</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          fact: reviewedFact(
                            facts[decision.factIndex],
                            decision,
                          ),
                          holdingId: decision.holdingId,
                          fx: decision.fx,
                          sourceId: decision.sourceId,
                          evidenceVerified: decision.evidenceVerified,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </div>
              ))}
            </article>
          ))}
          <p className={styles.hint}>
            All revisions are retained; the latest 30 are displayed here.
          </p>
        </details>
      ) : null}
    </section>
  );
}

function CreateLinkedHolding({
  job,
  fact,
  fx,
  opened,
  onCreated,
  onCancel,
}: {
  job: ProcessingJob;
  fact: ExtractedFact;
  fx: ReviewDecision['fx'];
  opened: boolean;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [snapshot, setSnapshot] = useState<LedgerResponse | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [name, setName] = useState(fact.investmentName);
  const [assetClass, setAssetClass] = useState('Private equity');
  const [amount, setAmount] = useState(
    fact.kind === 'valuation' ? (fact.amount ?? '') : '',
  );
  const [currency, setCurrency] = useState(fact.currency ?? 'EUR');
  const [date, setDate] = useState(fact.effectiveDate ?? '');
  const [cost, setCost] = useState('');
  const [commitment, setCommitment] = useState('');
  const [manager, setManager] = useState('');
  const [geography, setGeography] = useState('');
  const [liquidity, setLiquidity] = useState('3+ years');
  const [verified, setVerified] = useState(false);
  const lock = useRef(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/ledger', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body.message ?? 'Could not load the investment register.',
          );
        setSnapshot(body);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : 'Could not load the investment register.',
          );
      });
    return () => controller.abort();
  }, [refreshKey]);
  async function create() {
    if (!snapshot || lock.current) return;
    const parsed = ledgerRequestSchema.safeParse({
      expectedRevision: snapshot.revision,
      idempotencyKey: key.current,
      command: {
        type: 'createHolding',
        accountId,
        name,
        assetClass,
        amount,
        currency,
        fx: currency === 'EUR' ? undefined : fx,
        costBasisEUR: cost,
        unfundedCommitmentEUR: commitment,
        valuationDate: date,
        liquidityBucket: liquidity,
        manager,
        geography,
        source: { reference: job.filename, date },
        evidenceVerified: verified,
      },
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? 'Complete the investment fields.',
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message ?? 'Could not create the investment.');
      if (typeof body.resultId !== 'string')
        throw new Error(
          'The investment response did not include its link. Refresh before retrying.',
        );
      onCreated(body.resultId);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not create the investment.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <FieldSet className={styles.create}>
      <FieldLegend>Create and link investment</FieldLegend>
      <FieldDescription>
        Choose a registered account. Its family and legal entity determine
        ownership. Creation records an opening position; it does not accept the
        document fact.
      </FieldDescription>
      {!snapshot && !error ? <p>Loading investment register…</p> : null}
      {snapshot && !snapshot.portfolio.accounts.length ? (
        <Alert>
          <AlertTitle>Register an account first</AlertTitle>
          <AlertDescription>
            Open the Investment register & ledger to create the family, entity
            and account, then return to this saved document review.
          </AlertDescription>
        </Alert>
      ) : null}
      <FieldGroup>
        <SelectField
          id="create-review-account"
          label="Registered account"
          value={accountId}
          items={(snapshot?.portfolio.accounts ?? []).map((account) => ({
            value: account.id,
            label:
              account.name +
              ' · ' +
              (snapshot?.portfolio.entities.find(
                (entity) => entity.id === account.entityId,
              )?.name ?? account.entityId),
          }))}
          onChange={(id) => {
            setAccountId(id);
            setVerified(false);
          }}
          disabled={busy}
        />
        {(
          [
            { label: 'Investment name', value: name, set: setName },
            { label: 'Opening reported value', value: amount, set: setAmount },
            { label: 'Cost basis EUR', value: cost, set: setCost },
            {
              label: 'Unfunded commitment EUR',
              value: commitment,
              set: setCommitment,
            },
            { label: 'Manager', value: manager, set: setManager },
            { label: 'Geography', value: geography, set: setGeography },
          ] as const
        ).map((field) => (
          <Field key={field.label}>
            <FieldLabel htmlFor={'create-' + field.label}>
              {field.label}
            </FieldLabel>
            <Input
              id={'create-' + field.label}
              value={field.value}
              maxLength={240}
              disabled={busy}
              onChange={(e) => {
                field.set(e.target.value);
                setVerified(false);
              }}
            />
          </Field>
        ))}
        <SelectField
          id="create-review-class"
          label="Asset class"
          value={assetClass}
          items={[
            'Public equities',
            'Private equity',
            'Venture capital',
            'Real estate',
            'Fixed income',
            'Cash',
          ].map((value) => ({ value, label: value }))}
          onChange={(value) => {
            setAssetClass(value);
            setVerified(false);
          }}
          disabled={busy}
        />
        <SelectField
          id="create-review-currency"
          label="Reported currency"
          value={currency}
          items={LEDGER_CURRENCIES.map((value) => ({ value, label: value }))}
          onChange={(value) => {
            setCurrency(value);
            setVerified(false);
          }}
          disabled={busy}
        />
        <SelectField
          id="create-review-liquidity"
          label="Liquidity"
          value={liquidity}
          items={['Daily', 'Within 30 days', '1–3 years', '3+ years'].map(
            (value) => ({ value, label: value }),
          )}
          onChange={(value) => {
            setLiquidity(value);
            setVerified(false);
          }}
          disabled={busy}
        />
        <Field>
          <FieldLabel htmlFor="create-review-date">
            Opening valuation date
          </FieldLabel>
          <Input
            id="create-review-date"
            type="date"
            value={date}
            disabled={busy}
            onChange={(e) => {
              setDate(e.target.value);
              setVerified(false);
            }}
          />
        </Field>
        {currency !== 'EUR' ? (
          <p className={styles.hint}>
            Uses the reviewed FX rate entered on this fact. Enter its date and
            source before creating the investment.
          </p>
        ) : null}
        <Field orientation="horizontal">
          <Checkbox
            id="create-review-verified"
            checked={verified}
            disabled={!opened || busy}
            onCheckedChange={setVerified}
          />
          <FieldContent>
            <FieldLabel htmlFor="create-review-verified">
              I verified this opening position and ownership against the
              original source.
            </FieldLabel>
          </FieldContent>
        </Field>
      </FieldGroup>
      {error ? (
        <>
          <FieldError role="alert">{error}</FieldError>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              setRefreshKey((value) => value + 1);
            }}
          >
            Reload register
          </Button>
        </>
      ) : null}
      <div className={styles.actions}>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel creation
        </Button>
        <Button
          disabled={!snapshot?.canWrite || !accountId || !verified || busy}
          onClick={() => void create()}
        >
          {busy ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <Plus data-icon="inline-start" />
          )}
          Create and link
        </Button>
      </div>
    </FieldSet>
  );
}
