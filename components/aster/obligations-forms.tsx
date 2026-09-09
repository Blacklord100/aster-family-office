'use client';

import { useId, useState, type SubmitEvent } from 'react';
import { ArrowUpRight, CalendarClock, FileCheck2, Save } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import type { ReportObligationsResponse } from '@/lib/report-obligations-api';
import {
  REPORT_CADENCES,
  REPORT_EXCEPTION_PRIORITIES,
  REPORT_TYPES,
  reportScheduleInputSchema,
  type ReportException,
  type ReportExceptionAction,
  type ReportOccurrence,
  type ReportSchedule,
} from '@/lib/report-obligations-contract';
import { activeReportReceipts } from '@/lib/report-obligations';
import { cn } from '@/lib/utils';
import {
  humanLabel,
  instantLabel,
  reportTypeLabel,
  type ObligationsMutation,
} from './obligations-shared';
import { dateLabel } from './primitives';
import styles from './obligations.module.css';

type FormBase = {
  response: ReportObligationsResponse;
  busy: boolean;
  mutate: ObligationsMutation;
  onClose: () => void;
  mutationError?: string | null;
};
const utcToday = () => new Date().toISOString().slice(0, 10);
function nextPeriodStart(cadence: string, after: string) {
  const date = new Date(`${after}T12:00:00Z`);
  if (cadence === 'one_off') date.setUTCDate(date.getUTCDate() + 1);
  else {
    date.setUTCDate(1);
    if (cadence === 'annual')
      date.setUTCFullYear(date.getUTCFullYear() + 1, 0, 1);
    else if (cadence === 'quarterly')
      date.setUTCMonth(Math.floor(date.getUTCMonth() / 3) * 3 + 3);
    else date.setUTCMonth(date.getUTCMonth() + 1);
  }
  return date.toISOString().slice(0, 10);
}

export function ScheduleDialog({
  response,
  busy,
  mutate,
  onClose,
  mutationError,
  schedule,
  family,
}: FormBase & { schedule: ReportSchedule | null; family: string }) {
  const latest = schedule?.versions.at(-1);
  const defaults = latest?.definition;
  const versionAfter =
    latest && latest.effectiveFrom > utcToday()
      ? latest.effectiveFrom
      : utcToday();
  const [revision] = useState(response.revision);
  const [name, setName] = useState(defaults?.name ?? '');
  const [holdingIds, setHoldingIds] = useState<string[]>(
    defaults?.holdingIds ?? [],
  );
  const [owner, setOwner] = useState(
    defaults?.ownerUserId ??
      response.options.members.find((member) => member.role !== 'viewer')
        ?.userId ??
      '',
  );
  const [reportType, setReportType] = useState(
    defaults?.reportType ?? 'nav_statement',
  );
  const [cadence, setCadence] = useState(defaults?.cadence ?? 'quarterly');
  const [firstPeriod, setFirstPeriod] = useState(
    schedule
      ? nextPeriodStart(defaults?.cadence ?? 'quarterly', versionAfter)
      : (defaults?.firstPeriodStart ??
          `${utcToday().slice(0, 4)}-${String(Math.floor((Number(utcToday().slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`),
  );
  const [endPeriod, setEndPeriod] = useState(defaults?.oneOffPeriodEnd ?? '');
  const [timezone, setTimezone] = useState(
    defaults?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [dueDays, setDueDays] = useState(
    String(defaults?.dueDaysAfterPeriodEnd ?? 45),
  );
  const [dueTime, setDueTime] = useState(defaults?.dueLocalTime ?? '17:00');
  const [grace, setGrace] = useState(String(defaults?.graceHours ?? 0));
  const [staleDays, setStaleDays] = useState(
    defaults?.staleAfterDays ? String(defaults.staleAfterDays) : '',
  );
  const effective = firstPeriod;
  const [status, setStatus] = useState(latest?.status ?? 'active');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const prefix = useId();
  const holdings = response.options.holdings.filter(
    (holding) =>
      family === 'all' ||
      holding.familyId === family ||
      holdingIds.includes(holding.id),
  );
  const fieldProps = (key: string) => ({
    id: `${prefix}-${key}`,
    'aria-invalid': Boolean(errors[key]),
    'aria-describedby': errors[key] ? `${prefix}-${key}-error` : undefined,
  });
  const fieldError = (key: string) =>
    errors[key] ? (
      <p id={`${prefix}-${key}-error`} className={styles.note}>
        {errors[key]}
      </p>
    ) : null;
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = reportScheduleInputSchema.safeParse({
      name,
      holdingIds,
      familyIds: [
        ...new Set(
          holdingIds
            .map(
              (id) =>
                response.options.holdings.find((holding) => holding.id === id)
                  ?.familyId,
            )
            .filter(Boolean),
        ),
      ],
      managerId: defaults?.managerId ?? null,
      ownerUserId: owner,
      reportType,
      cadence,
      firstPeriodStart: firstPeriod,
      oneOffPeriodEnd: cadence === 'one_off' ? endPeriod || null : null,
      timezone,
      dueDaysAfterPeriodEnd: Number(dueDays),
      dueLocalTime: dueTime,
      graceHours: Number(grace),
      staleAfterDays: staleDays ? Number(staleDays) : null,
    });
    const issues: Record<string, string> = {};
    if (!candidate.success)
      for (const issue of candidate.error.issues)
        issues[String(issue.path[0])] = issue.message;
    if (reason.trim().length < 5)
      issues.reason = 'Describe the reason in at least 5 characters.';
    if (schedule && !effective)
      issues.effective = 'Choose when the new version applies.';
    setErrors(issues);
    if (!candidate.success || Object.keys(issues).length) return;
    const saved = await mutate(
      schedule
        ? {
            action: 'reviseSchedule',
            expectedRevision: revision,
            scheduleId: schedule.id,
            input: candidate.data,
            effectiveFrom: effective,
            status,
            reason,
          }
        : {
            action: 'createSchedule',
            expectedRevision: revision,
            input: candidate.data,
            reason,
          },
    );
    if (saved) onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>
            {schedule ? 'Edit reporting schedule' : 'Create reporting schedule'}
          </DialogTitle>
          <DialogDescription>
            {schedule
              ? 'Save a new version. Existing reporting periods and their history stay attached to the original obligation.'
              : 'Define what should arrive, who owns the follow-up, and when it is due.'}
          </DialogDescription>
        </DialogHeader>
        {mutationError ? (
          <Alert variant="destructive">
            <AlertDescription>{mutationError}</AlertDescription>
          </Alert>
        ) : null}
        <form
          onSubmit={(event) => void submit(event)}
          className={styles.dialogForm}
        >
          <FieldGroup className={styles.formColumns}>
            <Field className={styles.wide} data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor={`${prefix}-name`}>Schedule name</FieldLabel>
              <Input
                {...fieldProps('name')}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Quarterly NAV and capital account"
                required
                maxLength={240}
              />
              {fieldError('name')}
            </Field>
            <FieldSet className={styles.wide}>
              <FieldLegend variant="label">Holdings covered</FieldLegend>
              <div className={styles.checkboxes}>
                {holdings.length ? (
                  holdings.map((holding) => (
                    <Field key={holding.id} orientation="horizontal">
                      <Checkbox
                        id={`${prefix}-holding-${holding.id}`}
                        checked={holdingIds.includes(holding.id)}
                        onCheckedChange={(checked) =>
                          setHoldingIds((current) =>
                            checked
                              ? [...current, holding.id]
                              : current.filter((id) => id !== holding.id),
                          )
                        }
                      />
                      <FieldLabel htmlFor={`${prefix}-holding-${holding.id}`}>
                        {holding.name} · {holding.manager}
                      </FieldLabel>
                    </Field>
                  ))
                ) : (
                  <p className={styles.note}>
                    Register a holding before adding a reporting expectation.
                  </p>
                )}
              </div>
              {fieldError('holdingIds')}
              <FieldDescription>
                Matching a consolidated report requires confirmed coverage for
                every selected holding.
              </FieldDescription>
            </FieldSet>
            <Field data-invalid={Boolean(errors.ownerUserId)}>
              <FieldLabel htmlFor={`${prefix}-ownerUserId`}>
                Reporting owner
              </FieldLabel>
              <NativeSelect
                {...fieldProps('ownerUserId')}
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                required
              >
                <NativeSelectOption value="">
                  Select a member
                </NativeSelectOption>
                {response.options.members
                  .filter((member) => member.role !== 'viewer')
                  .map((member) => (
                    <NativeSelectOption
                      key={member.userId}
                      value={member.userId}
                    >
                      {member.name}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
              {fieldError('ownerUserId')}
            </Field>
            <Field data-invalid={Boolean(errors.reportType)}>
              <FieldLabel htmlFor={`${prefix}-reportType`}>
                Report type
              </FieldLabel>
              <Input
                {...fieldProps('reportType')}
                list={`${prefix}-types`}
                value={reportType}
                onChange={(event) => setReportType(event.target.value)}
                required
                maxLength={240}
              />
              <datalist id={`${prefix}-types`}>
                {REPORT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {reportTypeLabel(type)}
                  </option>
                ))}
              </datalist>
              {fieldError('reportType')}
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-cadence`}>Cadence</FieldLabel>
              <NativeSelect
                id={`${prefix}-cadence`}
                value={cadence}
                onChange={(event) => {
                  setCadence(event.target.value as typeof cadence);
                  if (schedule)
                    setFirstPeriod(
                      nextPeriodStart(event.target.value, versionAfter),
                    );
                }}
              >
                {REPORT_CADENCES.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {humanLabel(value)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field data-invalid={Boolean(errors.firstPeriodStart)}>
              <FieldLabel htmlFor={`${prefix}-firstPeriodStart`}>
                First reporting period starts
              </FieldLabel>
              <Input
                {...fieldProps('firstPeriodStart')}
                type="date"
                value={firstPeriod}
                onChange={(event) => setFirstPeriod(event.target.value)}
                required
              />
              {fieldError('firstPeriodStart')}
            </Field>
            {cadence === 'one_off' ? (
              <Field data-invalid={Boolean(errors.oneOffPeriodEnd)}>
                <FieldLabel htmlFor={`${prefix}-oneOffPeriodEnd`}>
                  Reporting period ends
                </FieldLabel>
                <Input
                  {...fieldProps('oneOffPeriodEnd')}
                  type="date"
                  min={firstPeriod}
                  value={endPeriod}
                  onChange={(event) => setEndPeriod(event.target.value)}
                  required
                />
                {fieldError('oneOffPeriodEnd')}
              </Field>
            ) : null}
            <Field data-invalid={Boolean(errors.dueDaysAfterPeriodEnd)}>
              <FieldLabel htmlFor={`${prefix}-dueDaysAfterPeriodEnd`}>
                Days after period end
              </FieldLabel>
              <Input
                {...fieldProps('dueDaysAfterPeriodEnd')}
                type="number"
                min={0}
                max={366}
                value={dueDays}
                onChange={(event) => setDueDays(event.target.value)}
                required
              />
              {fieldError('dueDaysAfterPeriodEnd')}
            </Field>
            <Field data-invalid={Boolean(errors.dueLocalTime)}>
              <FieldLabel htmlFor={`${prefix}-dueLocalTime`}>
                Due time
              </FieldLabel>
              <Input
                {...fieldProps('dueLocalTime')}
                type="time"
                value={dueTime}
                onChange={(event) => setDueTime(event.target.value)}
                required
              />
              {fieldError('dueLocalTime')}
            </Field>
            <Field data-invalid={Boolean(errors.timezone)}>
              <FieldLabel htmlFor={`${prefix}-timezone`}>Timezone</FieldLabel>
              <Input
                {...fieldProps('timezone')}
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="Europe/Helsinki"
                required
              />
              {fieldError('timezone')}
            </Field>
            <Field data-invalid={Boolean(errors.graceHours)}>
              <FieldLabel htmlFor={`${prefix}-graceHours`}>
                Grace period in hours
              </FieldLabel>
              <Input
                {...fieldProps('graceHours')}
                type="number"
                min={0}
                max={2160}
                value={grace}
                onChange={(event) => setGrace(event.target.value)}
                required
              />
              {fieldError('graceHours')}
            </Field>
            <Field
              className={styles.wide}
              data-invalid={Boolean(errors.staleAfterDays)}
            >
              <FieldLabel htmlFor={`${prefix}-staleAfterDays`}>
                Disclosure becomes stale after · optional
              </FieldLabel>
              <Input
                {...fieldProps('staleAfterDays')}
                type="number"
                min={1}
                max={3650}
                value={staleDays}
                onChange={(event) => setStaleDays(event.target.value)}
                placeholder="Days from the report’s disclosure-as-of date"
              />
              {fieldError('staleAfterDays')}
              <FieldDescription>
                Arrival time does not refresh an old valuation or disclosure.
              </FieldDescription>
            </Field>
            {schedule ? (
              <>
                <Field data-invalid={Boolean(errors.effective)}>
                  <FieldLabel htmlFor={`${prefix}-effective`}>
                    New version effective from
                  </FieldLabel>
                  <Input
                    {...fieldProps('effective')}
                    type="date"
                    min={utcToday()}
                    value={effective}
                    onChange={(event) => setFirstPeriod(event.target.value)}
                    required
                  />
                  {fieldError('effective')}
                  <FieldDescription>
                    The new version begins with this reporting period.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${prefix}-status`}>
                    Future schedule status
                  </FieldLabel>
                  <NativeSelect
                    id={`${prefix}-status`}
                    value={status}
                    onChange={(event) =>
                      setStatus(event.target.value as typeof status)
                    }
                  >
                    <NativeSelectOption value="active">
                      Active
                    </NativeSelectOption>
                    <NativeSelectOption value="paused">
                      Paused
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
              </>
            ) : null}
            <Field
              className={styles.wide}
              data-invalid={Boolean(errors.reason)}
            >
              <FieldLabel htmlFor={`${prefix}-reason`}>
                {schedule
                  ? 'Reason for this change'
                  : 'Basis for this expectation'}
              </FieldLabel>
              <Textarea
                {...fieldProps('reason')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Reporting agreement, manager correspondence or reviewed policy…"
                minLength={5}
                maxLength={3000}
                required
              />
              {fieldError('reason')}
            </Field>
          </FieldGroup>
          {Object.keys(errors).length ? (
            <Alert variant="destructive">
              <AlertDescription>
                Check the highlighted fields before saving.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className={styles.dialogFooter}>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !holdings.length}>
              <Save data-icon="inline-start" />
              {busy
                ? 'Saving…'
                : schedule
                  ? 'Save new version'
                  : 'Create schedule'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MatchReceiptDialog({
  response,
  busy,
  mutate,
  onClose,
  mutationError,
  occurrence,
  onSource,
}: FormBase & {
  occurrence: ReportOccurrence;
  onSource: (id: string) => void;
}) {
  const [revision] = useState(response.revision);
  const [documentId, setDocumentId] = useState('');
  const [opened, setOpened] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [periodStart, setPeriodStart] = useState(occurrence.periodStart);
  const [periodEnd, setPeriodEnd] = useState(occurrence.periodEnd);
  const [asOfDate, setAsOfDate] = useState('');
  const [reason, setReason] = useState('');
  const [supersedes, setSupersedes] = useState('');
  const [error, setError] = useState('');
  const prefix = useId();
  const selected = response.options.documents.find(
    (document) => document.id === documentId,
  );
  const activeReceipts = activeReportReceipts(occurrence);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!documentId || !confirmed || opened !== documentId) {
      setError(
        'Open the original and confirm its period and holding coverage before linking it.',
      );
      return;
    }
    if (
      periodStart !== occurrence.periodStart ||
      periodEnd !== occurrence.periodEnd
    ) {
      setError(
        'This report belongs to a different period. Select the matching calendar occurrence instead.',
      );
      return;
    }
    if (
      await mutate({
        action: 'matchReceipt',
        expectedRevision: revision,
        occurrenceId: occurrence.id,
        documentId,
        periodStart,
        periodEnd,
        asOfDate: asOfDate || null,
        reportType: occurrence.reportType,
        holdingIds: occurrence.holdingIds,
        reason,
        supersedesReceiptId: supersedes || null,
      })
    )
      onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>Link a received report</DialogTitle>
          <DialogDescription>
            {occurrence.name} · {dateLabel(occurrence.periodStart)} –{' '}
            {dateLabel(occurrence.periodEnd)}. Linking records delivery;
            extracted facts still need their own review.
          </DialogDescription>
        </DialogHeader>
        {mutationError ? (
          <Alert variant="destructive">
            <AlertDescription>{mutationError}</AlertDescription>
          </Alert>
        ) : null}
        <form
          onSubmit={(event) => void submit(event)}
          className={styles.dialogForm}
        >
          <FieldGroup className={styles.formColumns}>
            <Field className={styles.wide}>
              <FieldLabel htmlFor={`${prefix}-document`}>
                Original document
              </FieldLabel>
              <NativeSelect
                id={`${prefix}-document`}
                value={documentId}
                onChange={(event) => {
                  setDocumentId(event.target.value);
                  setConfirmed(false);
                  setError('');
                }}
                required
              >
                <NativeSelectOption value="">
                  Select an imported original
                </NativeSelectOption>
                {response.options.documents.map((document) => (
                  <NativeSelectOption key={document.id} value={document.id}>
                    {document.filename} · {instantLabel(document.receivedAt)}{' '}
                    UTC
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {selected ? (
                <div className={styles.actions}>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onSource(documentId);
                      setOpened(documentId);
                    }}
                  >
                    Open original
                    <ArrowUpRight data-icon="inline-end" />
                  </Button>
                  <span className={styles.note}>
                    {humanLabel(selected.status)} ·{' '}
                    {humanLabel(selected.reviewStatus)} review
                  </span>
                </div>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-start`}>
                Report period starts
              </FieldLabel>
              <Input
                id={`${prefix}-start`}
                type="date"
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-end`}>
                Report period ends
              </FieldLabel>
              <Input
                id={`${prefix}-end`}
                type="date"
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
                required
              />
            </Field>
            <Field className={styles.wide}>
              <FieldLabel htmlFor={`${prefix}-asof`}>
                Disclosure-as-of date · optional
              </FieldLabel>
              <Input
                id={`${prefix}-asof`}
                type="date"
                value={asOfDate}
                onChange={(event) => setAsOfDate(event.target.value)}
              />
              <FieldDescription>
                Use the date stated by the document. Leave unknown dates blank.
              </FieldDescription>
            </Field>
            {activeReceipts.length ? (
              <Field className={styles.wide}>
                <FieldLabel htmlFor={`${prefix}-supersedes`}>
                  Revision or additional report
                </FieldLabel>
                <NativeSelect
                  id={`${prefix}-supersedes`}
                  value={supersedes}
                  onChange={(event) => setSupersedes(event.target.value)}
                >
                  <NativeSelectOption value="">
                    Additional supporting report
                  </NativeSelectOption>
                  {activeReceipts.map((receipt) => (
                    <NativeSelectOption key={receipt.id} value={receipt.id}>
                      Replaces{' '}
                      {response.options.documents.find(
                        (document) => document.id === receipt.documentId,
                      )?.filename ?? 'previous report'}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  A replacement retains the earlier receipt and lateness
                  history.
                </FieldDescription>
              </Field>
            ) : null}
            <Field className={styles.wide}>
              <FieldLabel htmlFor={`${prefix}-reason`}>
                Matching evidence and reason
              </FieldLabel>
              <Textarea
                id={`${prefix}-reason`}
                required
                minLength={5}
                maxLength={3000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Identify the page or statement confirming report type, period and every holding covered…"
              />
            </Field>
            <Field
              className={styles.wide}
              orientation="horizontal"
              data-disabled={opened !== documentId || !documentId}
            >
              <Checkbox
                id={`${prefix}-confirm`}
                checked={confirmed}
                disabled={opened !== documentId || !documentId}
                onCheckedChange={(checked) => setConfirmed(Boolean(checked))}
              />
              <FieldLabel htmlFor={`${prefix}-confirm`}>
                I checked the original and confirmed this report type, period
                and all selected holdings.
              </FieldLabel>
            </Field>
          </FieldGroup>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className={styles.dialogFooter}>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !confirmed}>
              <FileCheck2 data-icon="inline-start" />
              {busy ? 'Linking…' : 'Confirm report receipt'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReasonDialog({
  response,
  busy,
  mutate,
  onClose,
  mutationError,
  title,
  description,
  action,
}: FormBase & {
  title: string;
  description: string;
  action: Record<string, unknown>;
}) {
  const [revision] = useState(response.revision);
  const [reason, setReason] = useState('');
  const prefix = useId();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {mutationError ? (
          <Alert variant="destructive">
            <AlertDescription>{mutationError}</AlertDescription>
          </Alert>
        ) : null}
        <form
          className={styles.dialogForm}
          onSubmit={(event) => {
            event.preventDefault();
            void mutate({ ...action, expectedRevision: revision, reason }).then(
              (saved) => {
                if (saved) onClose();
              },
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${prefix}-reason`}>
                Reason recorded in history
              </FieldLabel>
              <Textarea
                id={`${prefix}-reason`}
                required
                minLength={5}
                maxLength={3000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <div className={styles.dialogFooter}>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : title}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ExceptionActionDialog({
  response,
  busy,
  mutate,
  onClose,
  mutationError,
  issue,
  action,
}: FormBase & {
  issue: ReportException;
  action: ReportExceptionAction['action'];
}) {
  const [revision] = useState(response.revision);
  const [reason, setReason] = useState('');
  const [assignee, setAssignee] = useState(issue.assigneeUserId ?? '');
  const [priority, setPriority] = useState(issue.priority);
  const [until, setUntil] = useState('');
  const [evidenceDocument, setEvidenceDocument] = useState('');
  const [error, setError] = useState('');
  const prefix = useId();
  const needsEvidence = action === 'resolve' || action === 'waive';
  const title =
    action === 'assign'
      ? 'Assign exception'
      : action === 'priority'
        ? 'Change priority'
        : `${humanLabel(action)} exception`;
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    let operation: ReportExceptionAction;
    if (action === 'assign')
      operation = { action, assigneeUserId: assignee || null, reason };
    else if (action === 'priority') operation = { action, priority, reason };
    else if (action === 'snooze') {
      if (!until || !Number.isFinite(Date.parse(`${until}Z`))) {
        setError('Choose a valid wake date and time in UTC.');
        return;
      }
      operation = {
        action,
        until: new Date(`${until}Z`).toISOString(),
        reason,
      };
    } else if (action === 'resolve' || action === 'waive') {
      const evidence = evidenceDocument
        ? [
            {
              kind: 'document' as const,
              id: evidenceDocument,
              label: response.options.documents.find(
                (document) => document.id === evidenceDocument,
              )?.filename,
            },
          ]
        : issue.evidence;
      if (!evidence.length) {
        setError('Choose a source document supporting this disposition.');
        return;
      }
      operation = { action, reason, evidence };
    } else operation = { action, reason };
    if (
      await mutate({
        action: 'exception',
        expectedRevision: revision,
        exceptionId: issue.id,
        operation,
      })
    )
      onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className={cn(styles.dialog)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {issue.title}.{' '}
            {action === 'snooze'
              ? 'The underlying gap remains visible and returns to the open queue at the wake time.'
              : action === 'waive'
                ? 'Record an explicit exception to policy. This does not accept a report or complete financial review.'
                : action === 'resolve'
                  ? 'Record why this issue can be closed. Changed evidence can reopen the same issue.'
                  : 'The change and your reason will remain in the activity history.'}
          </DialogDescription>
        </DialogHeader>
        {mutationError ? (
          <Alert variant="destructive">
            <AlertDescription>{mutationError}</AlertDescription>
          </Alert>
        ) : null}
        <form
          onSubmit={(event) => void submit(event)}
          className={styles.dialogForm}
        >
          <FieldGroup>
            {action === 'assign' ? (
              <Field>
                <FieldLabel htmlFor={`${prefix}-assignee`}>Assignee</FieldLabel>
                <NativeSelect
                  id={`${prefix}-assignee`}
                  value={assignee}
                  onChange={(event) => setAssignee(event.target.value)}
                >
                  <NativeSelectOption value="">Unassigned</NativeSelectOption>
                  {response.options.members
                    .filter((member) => member.role !== 'viewer')
                    .map((member) => (
                      <NativeSelectOption
                        key={member.userId}
                        value={member.userId}
                      >
                        {member.name}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Field>
            ) : null}
            {action === 'priority' ? (
              <Field>
                <FieldLabel htmlFor={`${prefix}-priority`}>Priority</FieldLabel>
                <NativeSelect
                  id={`${prefix}-priority`}
                  value={priority}
                  onChange={(event) =>
                    setPriority(event.target.value as typeof priority)
                  }
                >
                  {REPORT_EXCEPTION_PRIORITIES.map((value) => (
                    <NativeSelectOption key={value} value={value}>
                      {humanLabel(value)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            {action === 'snooze' ? (
              <Field>
                <FieldLabel htmlFor={`${prefix}-until`}>
                  Wake date and time · UTC
                </FieldLabel>
                <Input
                  id={`${prefix}-until`}
                  type="datetime-local"
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                  min={new Date().toISOString().slice(0, 16)}
                  required
                />
                <FieldDescription>
                  The exception remains assigned while snoozed.
                </FieldDescription>
              </Field>
            ) : null}
            {needsEvidence ? (
              <Field>
                <FieldLabel htmlFor={`${prefix}-evidence`}>
                  Supporting evidence
                </FieldLabel>
                <NativeSelect
                  id={`${prefix}-evidence`}
                  value={evidenceDocument}
                  onChange={(event) => setEvidenceDocument(event.target.value)}
                  required={!issue.evidence.length}
                >
                  <NativeSelectOption value="">
                    {issue.evidence.length
                      ? `Use the ${issue.evidence.length} existing source references`
                      : 'Choose a supporting original'}
                  </NativeSelectOption>
                  {response.options.documents.map((document) => (
                    <NativeSelectOption key={document.id} value={document.id}>
                      {document.filename}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${prefix}-reason`}>
                Reason and disposition
              </FieldLabel>
              <Textarea
                id={`${prefix}-reason`}
                required
                minLength={5}
                maxLength={3000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Explain the decision and any evidence or follow-up…"
              />
            </Field>
          </FieldGroup>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className={styles.dialogFooter}>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              <CalendarClock data-icon="inline-start" />
              {busy ? 'Saving…' : title}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
