'use client';

import { useState } from 'react';
import {
  ArrowUpRight,
  CalendarClock,
  FileText,
  Link2,
  ShieldCheck,
  Unlink,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ReportObligationsResponse } from '@/lib/report-obligations-api';
import type { ReportOccurrence } from '@/lib/report-obligations-contract';
import { summarizeReportOccurrence } from '@/lib/report-obligations';
import { MatchReceiptDialog, ReasonDialog } from './obligations-forms';
import {
  DeliveryBadge,
  humanLabel,
  instantLabel,
  OperationHistory,
  OwnerLabel,
  reportTypeLabel,
  scopeLabel,
  type ObligationsMutation,
  type ObligationsNavigation,
} from './obligations-shared';
import { dateLabel } from './primitives';
import styles from './obligations.module.css';

export function ObligationDetail({
  occurrence,
  response,
  busy,
  mutate,
  error,
  onClose,
  onSource,
  onReview,
  onHolding,
}: ObligationsNavigation & {
  occurrence: ReportOccurrence;
  response: ReportObligationsResponse;
  busy: boolean;
  mutate: ObligationsMutation;
  error: string | null;
  onClose: () => void;
}) {
  const summary = summarizeReportOccurrence(occurrence, response.asOf);
  const [matching, setMatching] = useState(false);
  const [reasonAction, setReasonAction] = useState<{
    title: string;
    description: string;
    action: Record<string, unknown>;
  } | null>(null);
  const related = response.state.exceptions.filter(
    (issue) => issue.occurrenceId === occurrence.id,
  );
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <SheetContent className={styles.sheet}>
        <SheetHeader className={styles.sheetHeader}>
          <div className={styles.statusLine}>
            <DeliveryBadge status={summary.deliveryStatus} />
            <Badge variant="outline">
              {reportTypeLabel(occurrence.reportType)}
            </Badge>
          </div>
          <SheetTitle className={styles.sheetTitle}>
            {occurrence.name}
          </SheetTitle>
          <SheetDescription>
            {scopeLabel(occurrence.holdingIds, response)}
          </SheetDescription>
        </SheetHeader>
        <div className={styles.sheetBody}>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <dl className={styles.details}>
            <div className={styles.wide}>
              <dt>Reporting period</dt>
              <dd>
                {dateLabel(occurrence.periodStart)} –{' '}
                {dateLabel(occurrence.periodEnd)}
              </dd>
            </div>
            <div>
              <dt>Due date</dt>
              <dd>
                {instantLabel(occurrence.dueAt, occurrence.timezone)}
                <br />
                <span className={styles.note}>{occurrence.timezone}</span>
              </dd>
            </div>
            <div>
              <dt>Grace ends</dt>
              <dd>
                {instantLabel(occurrence.graceEndsAt, occurrence.timezone)}
                <br />
                <span className={styles.note}>{occurrence.timezone}</span>
              </dd>
            </div>
            <div>
              <dt>Reporting owner</dt>
              <dd>
                <OwnerLabel
                  userId={occurrence.ownerUserId}
                  response={response}
                />
              </dd>
            </div>
            <div>
              <dt>Disclosure policy</dt>
              <dd>
                {occurrence.staleAfterDays
                  ? `Stale after ${occurrence.staleAfterDays} days`
                  : 'No age policy configured'}
              </dd>
            </div>
            <div>
              <dt>First arrival</dt>
              <dd>
                {summary.firstReceivedAt
                  ? `${instantLabel(summary.firstReceivedAt)} UTC`
                  : 'Not received'}
              </dd>
            </div>
            <div>
              <dt>Arrival history</dt>
              <dd>
                {summary.lateByHours > 0
                  ? `${Math.ceil(summary.lateByHours)} hours after deadline`
                  : summary.firstReceivedAt
                    ? 'Received by the deadline'
                    : 'Awaiting a matching report'}
              </dd>
            </div>
          </dl>
          <Alert>
            <ShieldCheck />
            <AlertDescription>
              Delivery and financial review are separate. A received or waived
              report does not accept facts, replace a valuation or confirm a
              payment.
            </AlertDescription>
          </Alert>
          {response.canWrite ? (
            <div className={styles.actions}>
              <Button
                size="sm"
                onClick={() => setMatching(true)}
                disabled={busy || Boolean(occurrence.disposition)}
              >
                <Link2 data-icon="inline-start" />
                Link received report
              </Button>
              {occurrence.disposition ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setReasonAction({
                      title: 'Reopen obligation',
                      description:
                        'Remove the disposition while preserving its history. The reporting expectation is evaluated again.',
                      action: {
                        action: 'disposition',
                        occurrenceId: occurrence.id,
                        status: 'reopen',
                      },
                    })
                  }
                >
                  Reopen obligation
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      setReasonAction({
                        title: 'Waive obligation',
                        description:
                          'Record why this specific reporting period is waived. Financial review and stale disclosures remain separate.',
                        action: {
                          action: 'disposition',
                          occurrenceId: occurrence.id,
                          status: 'waived',
                        },
                      })
                    }
                  >
                    Waive
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      setReasonAction({
                        title: 'Cancel obligation',
                        description:
                          'Cancel this reporting period with a recorded reason. Other periods and prior activity remain intact.',
                        action: {
                          action: 'disposition',
                          occurrenceId: occurrence.id,
                          status: 'cancelled',
                        },
                      })
                    }
                  >
                    Cancel period
                  </Button>
                </>
              )}
            </div>
          ) : null}
          {occurrence.disposition ? (
            <section className={styles.source}>
              <h3 className={styles.sectionTitle}>
                {humanLabel(occurrence.disposition.status)}
              </h3>
              <p className={styles.muted}>{occurrence.disposition.reason}</p>
              <p className={styles.note}>
                {instantLabel(occurrence.disposition.at)} UTC
              </p>
            </section>
          ) : null}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>
              <FileText />
              Receipts and revisions{' '}
              <Badge variant="secondary">{occurrence.receipts.length}</Badge>
            </h3>
            {occurrence.receipts.length ? (
              [...occurrence.receipts].reverse().map((receipt) => {
                const source = response.options.documents.find(
                  (document) => document.id === receipt.documentId,
                );
                const superseded = summary.supersededReceiptIds.includes(
                  receipt.id,
                );
                const jobId = source?.jobId;
                return (
                  <article className={styles.source} key={receipt.id}>
                    <div className={styles.sourceTitle}>
                      <FileText />
                      <span>{source?.filename ?? 'Source document'}</span>
                    </div>
                    <div className={styles.statusLine}>
                      <Badge
                        variant={
                          receipt.processingStatus === 'failed' ||
                          receipt.processingStatus === 'blocked'
                            ? 'destructive'
                            : 'outline'
                        }
                      >
                        {humanLabel(receipt.processingStatus)}
                      </Badge>
                      <Badge variant="secondary">
                        {humanLabel(receipt.reviewStatus)} review
                      </Badge>
                      {receipt.matchStatus === 'revoked' ? (
                        <Badge variant="outline">Match revoked</Badge>
                      ) : superseded ? (
                        <Badge variant="outline">Superseded</Badge>
                      ) : (
                        <Badge variant="outline">Current receipt</Badge>
                      )}
                    </div>
                    <p className={styles.note}>
                      Arrived {instantLabel(receipt.receivedAt)} UTC
                      <br />
                      Disclosure as of{' '}
                      {receipt.asOfDate
                        ? dateLabel(receipt.asOfDate)
                        : 'unknown'}
                    </p>
                    <p className={styles.muted}>{receipt.matchReason}</p>
                    <div className={styles.actions}>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onSource(receipt.documentId)}
                      >
                        Open original
                        <ArrowUpRight data-icon="inline-end" />
                      </Button>
                      {jobId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onReview(jobId)}
                        >
                          Review facts
                          <ArrowUpRight data-icon="inline-end" />
                        </Button>
                      ) : null}
                      {response.canWrite &&
                      receipt.matchStatus === 'matched' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            setReasonAction({
                              title: 'Revoke report match',
                              description:
                                'Use this when a document was linked to the wrong period or holding. The original and prior match remain in history.',
                              action: {
                                action: 'revokeReceipt',
                                occurrenceId: occurrence.id,
                                receiptId: receipt.id,
                              },
                            })
                          }
                        >
                          <Unlink data-icon="inline-start" />
                          Revoke match
                        </Button>
                      ) : response.canWrite &&
                        receipt.matchStatus === 'revoked' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            setReasonAction({
                              title: 'Reinstate report match',
                              description:
                                'Restore this previously revoked match after checking its original period and holding coverage. Its prior revocation remains in history.',
                              action: {
                                action: 'reinstateReceipt',
                                occurrenceId: occurrence.id,
                                receiptId: receipt.id,
                              },
                            })
                          }
                        >
                          <Link2 data-icon="inline-start" />
                          Reinstate match
                        </Button>
                      ) : null}
                    </div>
                  </article>
                );
              })
            ) : (
              <p className={styles.muted}>
                No report has been linked to this period. Imported documents
                remain unmatched until their period and holding coverage are
                confirmed.
              </p>
            )}
          </section>
          {related.length ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>
                <CalendarClock />
                Related exceptions
              </h3>
              {related.map((issue) => (
                <div className={styles.between} key={issue.id}>
                  <span className={styles.muted}>{issue.title}</span>
                  <Badge
                    variant={
                      issue.status === 'open' ? 'destructive' : 'outline'
                    }
                  >
                    {humanLabel(issue.status)}
                  </Badge>
                </div>
              ))}
            </section>
          ) : null}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Covered holdings</h3>
            <div className={styles.actions}>
              {occurrence.holdingIds.map((id) => (
                <Button
                  key={id}
                  variant="outline"
                  size="sm"
                  onClick={() => onHolding(id)}
                >
                  {response.options.holdings.find(
                    (holding) => holding.id === id,
                  )?.name ?? 'Holding'}
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              ))}
            </div>
          </section>
          <OperationHistory history={occurrence.history} response={response} />
        </div>
        {matching ? (
          <MatchReceiptDialog
            response={response}
            busy={busy}
            mutationError={error}
            mutate={mutate}
            onClose={() => setMatching(false)}
            occurrence={occurrence}
            onSource={onSource}
          />
        ) : null}
        {reasonAction ? (
          <ReasonDialog
            {...reasonAction}
            response={response}
            busy={busy}
            mutationError={error}
            mutate={mutate}
            onClose={() => setReasonAction(null)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
