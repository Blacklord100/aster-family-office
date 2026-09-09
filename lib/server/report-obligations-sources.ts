import 'server-only';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Holding } from '@/data/types';
import { deriveWorkspace, type WorkspaceState } from '../workspace';
import { ExtractionSchema, type Extraction } from '../processing-contract';
import {
  reviewedFact,
  ReviewDecisionSchema,
  type ReviewState,
} from '../review-contract';
import { ledgerMoney } from '../ledger-contract';
import { moneyMinor } from '../ledger';
import type {
  ReportExceptionSignal,
  ReportObligationsState,
  ReportReceiptInput,
} from '../report-obligations-contract';
import { activeReportReceipts, reportLocalDate } from '../report-obligations';
import { readReview } from './review-store';
import { decrypt, sha256 } from './crypto';
import { AccessError } from './access';

export type ObligationSource = {
  id: string;
  filename: string;
  content_hash: string;
  created_at: Date;
  job_id: string | null;
  status: string | null;
  error_code: string | null;
  result: Buffer | null;
  review_state: Buffer | null;
  review_revision: number;
  job_updated_at: Date | null;
  extraction: Extraction | null;
  review: ReviewState | null;
  corrupt: boolean;
};
export type ObligationSources = {
  documents: ObligationSource[];
  total: number;
  truncated: boolean;
};
const SOURCE_LIMIT = 2000;
const SOURCE_BYTE_LIMIT = 64 * 1024 * 1024;
const sourceReviewFactSchema = z
  .object({
    ...ReviewDecisionSchema.shape,
    status: z.enum(['pending', 'accepted', 'deferred', 'rejected', 'legacy']),
    version: z.number().int().min(0),
    reviewedAt: z.string().nullable(),
    reviewedBy: z.string().nullable(),
    sourceId: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === 'accepted' &&
      (!value.holdingId || !value.evidenceVerified)
    )
      context.addIssue({
        code: 'custom',
        message: 'Accepted source reviews require a verified holding.',
      });
  });
const sourceReviewSchema = z
  .object({
    revision: z.number().int().min(0),
    extractionHash: z.string().regex(/^[a-f0-9]{64}$/),
    facts: z.array(sourceReviewFactSchema).max(100),
    history: z
      .array(
        z
          .object({
            revision: z.number().int().min(0),
            at: z.string(),
            actorId: z.string(),
            decisions: z.array(sourceReviewFactSchema).max(100),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();

/** A bounded current-source scan plus every retained receipt/exception reference.
 * Omitted sources never mean that an issue is resolved. No model is called here. */
export async function readObligationSources(
  client: PoolClient,
  organizationId: string,
  state: ReportObligationsState,
): Promise<ObligationSources> {
  const retained = new Set<string>();
  const retainReferences = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) retainReferences(item);
      return;
    }
    const row = value as Record<string, unknown>;
    const id =
      typeof row.documentId === 'string'
        ? row.documentId
        : row.kind === 'document'
          ? row.id
          : undefined;
    if (id !== undefined) {
      if (!z.uuid().safeParse(id).success)
        throw new AccessError(
          409,
          'REPORT_SOURCE_REFERENCE_INVALID',
          'A retained source reference is invalid. Review the reporting record; no history has been discarded.',
        );
      retained.add(id as string);
    }
    for (const item of Object.values(row)) retainReferences(item);
  };
  retainReferences(state);
  if (retained.size > 5000)
    throw new AccessError(
      409,
      'REPORT_SOURCE_LIMIT',
      'More than 5,000 retained sources need a partitioned reporting store. No history has been discarded.',
    );
  const result = await client.query<
    Omit<ObligationSource, 'extraction' | 'review' | 'corrupt'> & {
      total: string;
      payload_bytes: string;
    }
  >(
    `
    WITH recent AS (
      SELECT id FROM app_documents WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2
    ), selected AS (
      SELECT d.id,d.filename,d.content_hash,d.created_at FROM app_documents d WHERE d.organization_id=$1 AND (d.id IN (SELECT id FROM recent) OR d.id=ANY($3::uuid[]))
    ), current_sources AS (
      SELECT d.id,d.filename,d.content_hash,d.created_at,j.id AS job_id,j.status,j.error_code,j.result,j.review_state,
      COALESCE(j.review_revision,0) AS review_revision,j.updated_at AS job_updated_at,
      (SELECT count(*) FROM app_documents WHERE organization_id=$1) AS total
      FROM selected d LEFT JOIN LATERAL (
        SELECT id,status,error_code,result,review_state,review_revision,updated_at
        FROM app_jobs WHERE organization_id=$1 AND document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1
      ) j ON true
    ), sized AS (
      SELECT *,SUM(COALESCE(octet_length(result),0)::bigint + COALESCE(octet_length(review_state),0)::bigint) OVER () AS payload_bytes
      FROM current_sources
    )
    SELECT id,filename,content_hash,created_at,job_id,status,error_code,
      CASE WHEN payload_bytes <= $4::bigint THEN result ELSE NULL END AS result,
      CASE WHEN payload_bytes <= $4::bigint THEN review_state ELSE NULL END AS review_state,
      review_revision,job_updated_at,total,payload_bytes
    FROM sized ORDER BY created_at DESC,id DESC`,
    [organizationId, SOURCE_LIMIT, [...retained], SOURCE_BYTE_LIMIT],
  );
  // The same statement selected, sized and guarded the rows: a concurrent job
  // update cannot slip larger payloads between an earlier size check and load.
  if (
    result.rows.some(
      (row) =>
        !/^\d+$/.test(row.payload_bytes) ||
        Number(row.payload_bytes) > SOURCE_BYTE_LIMIT,
    )
  )
    throw new AccessError(
      409,
      'REPORT_SOURCE_BYTES_LIMIT',
      'The selected source batch exceeds the 64 MiB result and review limit. Partition the reporting store before monitoring resumes; no obligations or history have been changed.',
    );
  const documents = result.rows.map((row): ObligationSource => {
    let extraction: Extraction | null = null,
      review: ReviewState | null = null,
      corrupt = false;
    if (row.result && row.job_id) {
      try {
        extraction = ExtractionSchema.parse(
          JSON.parse(
            decrypt(
              row.result,
              `result:${organizationId}:${row.job_id}`,
            ).toString(),
          ),
        );
        if (extraction.documentId !== row.id)
          throw new Error('Source mismatch');
        review = sourceReviewSchema.parse(
          readReview(
            {
              id: row.job_id,
              status: row.status!,
              review_state: row.review_state,
              review_revision: row.review_revision,
            },
            organizationId,
            extraction,
          ),
        );
        if (review.facts.some((fact, index) => fact.factIndex !== index))
          throw new Error('Review fact order mismatch');
      } catch {
        extraction = null;
        review = null;
        corrupt = true;
      }
    }
    return { ...row, extraction, review, corrupt };
  });
  const total = Number(result.rows[0]?.total ?? 0);
  return { documents, total, truncated: total > documents.length };
}

export function sourceReceiptStatus(
  source: ObligationSource,
): Pick<ReportReceiptInput, 'processingStatus' | 'reviewStatus'> {
  const processingStatus =
    source.corrupt || ['failed', 'cancelled'].includes(source.status ?? '')
      ? 'failed'
      : !source.job_id
        ? 'blocked'
        : source.status === 'queued'
          ? 'queued'
          : source.status === 'processing'
            ? 'processing'
            : source.extraction
              ? 'completed'
              : 'blocked';
  if (processingStatus !== 'completed' || !source.extraction || !source.review)
    return { processingStatus, reviewStatus: 'pending' };
  const facts = source.review.facts;
  const reviewStatus = facts.some((row) =>
    ['pending', 'deferred'].includes(row.status),
  )
    ? 'pending'
    : facts.some((row) => ['accepted', 'legacy'].includes(row.status))
      ? 'accepted'
      : facts.length || source.status === 'rejected'
        ? 'rejected'
        : source.status === 'accepted'
          ? 'accepted'
          : 'pending';
  return { processingStatus, reviewStatus };
}

const normalize = (value: string) =>
  value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');
function identifiedHolding(
  fact: Extraction['facts'][number],
  review: ReviewState['facts'][number] | undefined,
  holdings: Holding[],
) {
  if (review?.holdingId)
    return holdings.find((holding) => holding.id === review.holdingId);
  const matches = holdings.filter(
    (holding) => normalize(holding.name) === normalize(fact.investmentName),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
function decimal(value: string): string {
  const negative = value.startsWith('-'),
    unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  const whole = integer.replace(/^0+(?=\d)/, ''),
    decimals = fraction.replace(/0+$/, '');
  return `${negative && (whole !== '0' || decimals) ? '-' : ''}${whole}${decimals ? `.${decimals}` : ''}`;
}
/** Use the register's exact cent arithmetic for supported ledger money. Source
 * sub-cent amounts retain their eight-digit precision instead of throwing on
 * JavaScript's exponent representation (for example 1e-8). */
function valuationAmountsDiffer(
  amount: string,
  originalValue: number,
): boolean {
  if (!Number.isFinite(originalValue) || Math.abs(originalValue) > 1e12)
    return true;
  const sourceMoney = ledgerMoney.safeParse(amount),
    registeredMoney = ledgerMoney.safeParse(originalValue.toFixed(2));
  if (sourceMoney.success && registeredMoney.success)
    return moneyMinor(sourceMoney.data) !== moneyMinor(registeredMoney.data);
  return decimal(amount) !== decimal(originalValue.toFixed(8));
}

/** Stable identity is document/category, independent of model and ingestion mode.
 * Fingerprints include economic content and dispositions, not traces or job IDs. */
export function sourceExceptionSignals(
  workspace: WorkspaceState,
  sources: ObligationSources,
  now: string,
): ReportExceptionSignal[] {
  const { holdings } = deriveWorkspace(workspace),
    signals: ReportExceptionSignal[] = [];
  for (const source of sources.documents) {
    const facts = (source.extraction?.facts ?? []).map((original, index) => {
      const review = source.review?.facts[index],
        fact = reviewedFact(original, review);
      return {
        fact,
        review,
        holding: identifiedHolding(fact, review, holdings),
      };
    });
    // Unresolved or mixed coverage is office-only until a reviewer establishes scope.
    const holdingIds = facts.every((row) => row.holding)
      ? [
          ...new Set(
            facts.flatMap((row) => (row.holding ? [row.holding.id] : [])),
          ),
        ].sort()
      : [];
    const familyIds = [
      ...new Set(
        holdings
          .filter((row) => holdingIds.includes(row.id))
          .map((row) => row.familyId),
      ),
    ].sort();
    const evidence: ReportExceptionSignal['evidence'] = [
      { kind: 'document', id: source.id, label: source.filename.slice(0, 240) },
      ...(source.job_id
        ? [
            {
              kind: 'review' as const,
              id: source.job_id,
              label: 'Source review',
            },
          ]
        : []),
    ];
    const canonicalFact = ({
      fact,
      review,
      holding,
    }: (typeof facts)[number]) => ({
      kind: fact.kind,
      investment: normalize(fact.investmentName),
      date: fact.effectiveDate,
      amount: fact.amount === null ? null : decimal(fact.amount),
      currency: fact.currency,
      due: fact.dueDate,
      status: review?.status ?? 'pending',
      holding: holding?.id ?? null,
    });
    const canonical = facts
      .map(canonicalFact)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const add = (
      category: ReportExceptionSignal['category'],
      title: string,
      description: string,
      active: boolean,
      fingerprint: unknown,
      priority: ReportExceptionSignal['priority'] = 'normal',
    ) =>
      signals.push({
        key: `source:${source.id}:${category}`,
        category,
        title,
        description,
        holdingIds,
        familyIds,
        evidence,
        priority,
        sourceActive: active,
        evidenceFingerprint: sha256(
          JSON.stringify([source.content_hash, fingerprint]),
        ),
        origin: 'external',
      });
    const status = sourceReceiptStatus(source);
    const stalled =
      ['queued', 'processing'].includes(source.status ?? '') &&
      !!source.job_updated_at &&
      Date.parse(now) - source.job_updated_at.getTime() > 30 * 60_000;
    add(
      'processing_failed',
      'Source needs processing attention',
      source.corrupt
        ? 'The stored extraction or review could not be verified. Reprocess the original source.'
        : stalled
          ? 'Processing has made no recorded progress for 30 minutes. Inspect the existing job.'
          : 'The document arrived, but processing is absent, blocked or failed. This does not establish report coverage.',
      ['failed', 'blocked'].includes(status.processingStatus) || stalled,
      [status.processingStatus, stalled, source.corrupt, source.error_code],
      'high',
    );
    // While reprocessing is underway retain any previous pending/conflict signal.
    if (
      status.processingStatus !== 'completed' ||
      !source.extraction ||
      !source.review
    )
      continue;
    const pending = facts.filter((row) =>
      ['pending', 'deferred'].includes(row.review?.status ?? 'pending'),
    );
    add(
      'review_pending',
      'Source awaits financial review',
      'Review the original and its proposed facts. A calendar receipt does not approve figures or settlement.',
      pending.length > 0 ||
        (!!source.extraction.relevant &&
          !facts.length &&
          source.status !== 'accepted' &&
          source.status !== 'rejected'),
      canonical,
    );
    add(
      'identity_unresolved',
      'Investment identity needs review',
      'At least one undecided fact has no unique investment match. Establish identity in source review.',
      pending.some((row) => !row.holding),
      canonical.filter((row) => !row.holding),
      'high',
    );
    const conflicts = pending.filter(
      ({ fact, holding }) =>
        holding &&
        fact.kind === 'valuation' &&
        fact.effectiveDate === holding.valuationDate &&
        fact.currency === holding.currency &&
        fact.amount !== null &&
        valuationAmountsDiffer(fact.amount, holding.originalValue),
    );
    add(
      'conflicting_fact',
      'Valuation differs for the same date',
      'A proposed valuation differs from the registered value for the same holding, currency and date. Use the existing correction review.',
      conflicts.length > 0,
      conflicts
        .map(({ fact, holding }) => [
          fact.effectiveDate,
          decimal(fact.amount!),
          fact.currency,
          holding!.id,
          holding!.originalValue,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      'high',
    );
  }
  for (const proposal of workspace.intelligence?.proposals ?? []) {
    const holding = holdings.find((row) => row.id === proposal.holdingId);
    signals.push({
      key: `constituent:${proposal.id}`,
      category: 'identity_unresolved',
      title: 'Underlying holding awaits review',
      description:
        'Review the proposed constituent and its source in Intelligence before treating it as owned exposure.',
      holdingIds: holding ? [holding.id] : [],
      familyIds: holding ? [holding.familyId] : [],
      priority: 'normal',
      sourceActive: proposal.status === 'pending',
      evidenceFingerprint: sha256(
        JSON.stringify([
          proposal.issuerName,
          proposal.issuerId,
          proposal.weight,
          proposal.asOfDate,
          proposal.status,
          proposal.citation,
        ]),
      ),
      evidence: [
        {
          kind: 'document',
          id: proposal.citation.documentId,
          label: proposal.citation.source.slice(0, 240),
        },
        {
          kind: 'note',
          id: proposal.id,
          label: 'Constituent review in Intelligence',
        },
      ],
    });
  }
  return signals;
}

export function staleReportSignals(
  workspace: WorkspaceState,
  state: ReportObligationsState,
  now: string,
): ReportExceptionSignal[] {
  const { holdings } = deriveWorkspace(workspace),
    signals: ReportExceptionSignal[] = [];
  const evaluatedPolicyKeys = new Set<string>();
  for (const schedule of state.schedules) {
    const version = schedule.versions
      .filter(
        (row) =>
          row.effectiveFrom <= reportLocalDate(now, row.definition.timezone),
      )
      .at(-1);
    if (!version) continue;
    const definition = version.definition;
    for (const holdingId of definition.holdingIds) {
      const key = `stale:${schedule.id}:${holdingId}`;
      const holding = holdings.find((row) => row.id === holdingId);
      if (!holding) continue;
      evaluatedPolicyKeys.add(key);
      const occurrences = state.occurrences.filter(
        (row) =>
          row.scheduleId === schedule.id &&
          row.reportType === definition.reportType &&
          row.holdingIds.includes(holdingId),
      );
      const accepted = occurrences
        .flatMap(activeReportReceipts)
        .filter(
          (row) =>
            row.processingStatus === 'completed' &&
            row.reviewStatus === 'accepted' &&
            row.asOfDate,
        )
        .sort((a, b) => b.asOfDate!.localeCompare(a.asOfDate!));
      const asOfDate =
        definition.reportType === 'nav_statement'
          ? holding.valuationDate
          : (accepted[0]?.asOfDate ?? null);
      const age = asOfDate
        ? (Date.parse(reportLocalDate(now, definition.timezone)) -
            Date.parse(asOfDate)) /
          86_400_000
        : null;
      const active =
        version.status === 'active' &&
        definition.staleAfterDays !== null &&
        (age !== null
          ? age > definition.staleAfterDays
          : occurrences.some(
              (row) =>
                !row.disposition &&
                Date.parse(row.graceEndsAt) < Date.parse(now),
            ));
      signals.push({
        key,
        category: 'stale_disclosure',
        title: `Stale disclosure · ${holding.name}`.slice(0, 240),
        description: asOfDate
          ? `Latest verified as-of date: ${asOfDate}. The configured age limit is ${definition.staleAfterDays ?? 'disabled'} days. Arrival of an unrelated report does not refresh this date.`
          : 'No accepted receipt has an explicit disclosure-as-of date. Review coverage against the configured age policy.',
        familyIds: [holding.familyId],
        holdingIds: [holdingId],
        managerId: definition.managerId,
        assigneeUserId: definition.ownerUserId,
        priority: 'high',
        sourceActive: active,
        evidenceFingerprint: sha256(
          JSON.stringify([
            definition.reportType,
            asOfDate,
            definition.staleAfterDays,
            version.status,
          ]),
        ),
        evidence: [
          { kind: 'holding', id: holdingId, label: holding.name },
          ...(definition.reportType !== 'nav_statement' && accepted[0]
            ? [
                {
                  kind: 'document' as const,
                  id: accepted[0].documentId,
                  label: 'Latest accepted disclosure',
                },
              ]
            : []),
        ],
      });
    }
  }
  // A complete policy scan can explicitly retire an old holding/type policy;
  // source scans remain partial and never use absence as a resolution signal.
  for (const previous of state.exceptions) {
    if (
      previous.category !== 'stale_disclosure' ||
      !previous.key.startsWith('stale:') ||
      evaluatedPolicyKeys.has(previous.key)
    )
      continue;
    signals.push({
      ...previous,
      description:
        'This holding no longer has an applicable current reporting-age policy. The previous issue and its disposition remain in history.',
      sourceActive: false,
      evidenceFingerprint: sha256(
        JSON.stringify([previous.key, 'policy_not_applicable']),
      ),
    });
  }
  for (const occurrence of state.occurrences) {
    const receipts = activeReportReceipts(occurrence);
    signals.push({
      key: `receipt-review:${occurrence.id}`,
      category: 'review_rejected',
      title: 'Received report has rejected review',
      description:
        'Delivery was recorded, but its current source review is rejected. Review a corrected report or record an explicit disposition.',
      familyIds: occurrence.familyIds,
      holdingIds: occurrence.holdingIds,
      managerId: occurrence.managerId,
      occurrenceId: occurrence.id,
      assigneeUserId: occurrence.ownerUserId,
      priority: 'high',
      sourceActive: receipts.some((row) => row.reviewStatus === 'rejected'),
      evidenceFingerprint: sha256(
        JSON.stringify(
          receipts.map((row) => [row.documentHash, row.reviewStatus]),
        ),
      ),
      evidence: receipts
        .slice(0, 100)
        .map((row) => ({ kind: 'document' as const, id: row.documentId })),
    });
  }
  return signals;
}
