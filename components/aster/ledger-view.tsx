'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SubmitEvent,
} from 'react';
import {
  BookOpen,
  CheckCircle2,
  FileText,
  Plus,
  RefreshCw,
  RotateCcw,
  Wallet,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import {
  LEDGER_CURRENCIES,
  LEDGER_ENTITY_TYPES,
  LEDGER_KINDS,
  ledgerCommandSchema,
  type FinanceState,
  type LedgerCommand,
  type LedgerResponse,
} from '@/lib/ledger-contract';
import { cashflowCoverageCurrent, transactionStatus } from '@/lib/ledger';
import type { PortfolioRecords } from '@/lib/workspace';
import {
  FamilyPicker,
  Metric,
  PageHeading,
  Panel,
  Picker,
  dateLabel,
  money,
} from './primitives';
import { useWorkspace } from './workspace-context';
import styles from './ledger.module.css';

const today = () => new Date().toISOString().slice(0, 10);
const labelKind = (kind: string) =>
  kind.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
const nativeMoney = (amount: string | number, currency: string) =>
  new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amount));
const titles: Record<LedgerCommand['type'], string> = {
  createFamily: 'Add a family',
  createEntity: 'Register a legal entity',
  createAccount: 'Register an account',
  reviewAccount: 'Review an existing account',
  createHolding: 'Add an opening holding',
  recordTransaction: 'Review a transaction',
  settleTransaction: 'Record confirmed settlement',
  reverseTransaction: 'Reverse a settlement',
  voidTransaction: 'Void an unsettled transaction',
  recordValuation: 'Record a sourced valuation',
  reconcilePeriod: 'Reconcile a cash-flow period',
};
const classes = [
  'Public equities',
  'Private equity',
  'Venture capital',
  'Real estate',
  'Fixed income',
  'Cash',
];
const liquidities = ['Daily', 'Within 30 days', '1–3 years', '3+ years'];
async function requestLedger(
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<LedgerResponse> {
  const response = await fetch('/api/ledger', {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
    ...(body
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      payload.message ?? 'The ledger request could not be completed.',
    );
  return payload;
}
function Blank({ children }: { children: React.ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No records yet</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
function LedgerForm({
  mode,
  portfolio,
  finance,
  transactionId,
  holdingId,
  onClose,
  onSubmit,
}: {
  mode: LedgerCommand['type'];
  portfolio: PortfolioRecords;
  finance: FinanceState;
  transactionId?: string;
  holdingId?: string;
  onClose: () => void;
  onSubmit: (command: LedgerCommand) => Promise<void>;
}) {
  const [fields, setFields] = useState<Record<string, string>>(() => ({
    familyId: portfolio.families[0]?.id ?? '',
    entityId: portfolio.entities[0]?.id ?? '',
    accountId: portfolio.accounts[0]?.id ?? '',
    holdingId:
      holdingId ??
      portfolio.holdings.find((h) => h.assetClass !== 'Cash')?.id ??
      '',
    cashHoldingId:
      portfolio.holdings.find((h) => h.assetClass === 'Cash')?.id ?? '',
    destinationCashHoldingId: '',
    currency: holdingId
      ? (portfolio.holdings.find((h) => h.id === holdingId)?.currency ?? 'EUR')
      : 'EUR',
    entityType: 'Holding company',
    accountType: 'Custody',
    assetClass: 'Private equity',
    liquidityBucket: '3+ years',
    kind: 'capital_call',
    investmentEffect: 'none',
    commitmentEffect: 'none',
    costBasisEUR: '0',
    unfundedCommitmentEUR: '0',
    commitmentAmountEUR: '0',
    investmentCostBasisEUR: '0',
    ownershipPercent: '100',
    date: today(),
    valuationDate: today(),
    effectiveDate: today(),
    dueDate: today(),
    sourceDate: today(),
    fxDate: today(),
    from: today(),
    to: today(),
  }));
  const [verified, setVerified] = useState(false),
    [restricted, setRestricted] = useState(false),
    [correction, setCorrection] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const set = (name: string, value: string) => {
    setFields((current) => ({ ...current, [name]: value }));
    setError('');
  };
  const tx = finance.transactions.find((item) => item.id === transactionId);
  const currentHolding = portfolio.holdings.find(
    (h) => h.id === fields.holdingId,
  );
  const cash = portfolio.holdings.find((h) => h.id === fields.cashHoldingId);
  const currency =
    mode === 'recordTransaction'
      ? (cash?.currency ?? fields.currency)
      : fields.currency;
  const investmentKind = [
    'capital_call',
    'distribution',
    'purchase',
    'sale',
  ].includes(fields.kind);
  const increase = ['capital_call', 'purchase'].includes(fields.kind);
  const investmentEffect = increase
    ? 'increase'
    : fields.kind === 'sale'
      ? 'reduce'
      : fields.kind === 'distribution'
        ? fields.investmentEffect
        : 'none';
  const needsSource = !['createFamily', 'createAccount'].includes(mode);
  const needsFX =
    ['createHolding', 'recordTransaction', 'recordValuation'].includes(mode) &&
    currency !== 'EUR';
  const cashInEntity = portfolio.holdings.filter(
    (h) => h.assetClass === 'Cash' && h.entityId === fields.entityId,
  );
  const input = (
    name: string,
    label: string,
    type = 'text',
    description?: string,
    required = true,
  ) => (
    <Field key={name}>
      <FieldLabel htmlFor={'ledger-' + name}>{label}</FieldLabel>
      <Input
        id={'ledger-' + name}
        type={type}
        value={fields[name] ?? ''}
        onChange={(event) => set(name, event.target.value)}
        required={required}
        maxLength={type === 'text' ? 1000 : undefined}
        step={type === 'number' ? 'any' : undefined}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
  const pick = (
    name: string,
    label: string,
    options: { value: string; label: string }[],
  ) => (
    <Field key={name}>
      <FieldLabel htmlFor={'ledger-' + name}>{label}</FieldLabel>
      <Picker
        id={'ledger-' + name}
        label={label}
        value={fields[name] ?? ''}
        onChange={(value) => set(name, value)}
        options={[{ value: '', label: 'Choose…' }, ...options]}
      />
    </Field>
  );
  const choices = (values: string[]) =>
    values.map((value) => ({ value, label: labelKind(value) }));
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (
      mode === 'reviewAccount' &&
      !['restricted', 'unrestricted'].includes(fields.restrictionState)
    ) {
      setError('Explicitly choose whether this account is restricted.');
      return;
    }
    const f = fields,
      source = {
        reference: f.sourceReference ?? '',
        date: f.sourceDate,
        ...(f.sourceId ? { sourceId: f.sourceId } : {}),
      };
    const fx =
      currency === 'EUR'
        ? undefined
        : {
            rateToEUR: f.fxRate ?? '',
            date: f.fxDate,
            source: f.fxSource ?? '',
          };
    let command: unknown;
    const proof = { source, evidenceVerified: verified };
    switch (mode) {
      case 'reviewAccount':
        command = {
          type: mode,
          accountId: f.accountId,
          currency: f.currency,
          restricted: f.restrictionState === 'restricted',
          restrictionNote: f.restrictionNote ?? '',
          ...proof,
        };
        break;
      case 'createFamily':
        command = {
          type: mode,
          name: f.name,
          principal: f.principal ?? '',
          location: f.location ?? '',
        };
        break;
      case 'createEntity':
        command = {
          type: mode,
          familyId: f.familyId,
          name: f.name,
          entityType: f.entityType,
          jurisdiction: f.jurisdiction,
          ownershipPercent: Number(f.ownershipPercent),
          ...proof,
        };
        break;
      case 'createAccount':
        command = {
          type: mode,
          entityId: f.entityId,
          name: f.name,
          institution: f.institution,
          accountType: f.accountType,
          currency: f.currency,
          restricted,
          restrictionNote: f.restrictionNote ?? '',
        };
        break;
      case 'createHolding':
        command = {
          type: mode,
          accountId: f.accountId,
          name: f.name,
          assetClass: f.assetClass,
          amount: f.amount,
          currency,
          fx,
          costBasisEUR: f.costBasisEUR,
          unfundedCommitmentEUR: f.unfundedCommitmentEUR,
          valuationDate: f.valuationDate,
          liquidityBucket: f.liquidityBucket,
          manager: f.manager,
          geography: f.geography,
          ...(f.managerId ? { managerId: f.managerId } : {}),
          ...(f.instrumentId ? { instrumentId: f.instrumentId } : {}),
          ...(f.shareClassId ? { shareClassId: f.shareClassId } : {}),
          ...proof,
        };
        break;
      case 'recordTransaction':
        command = {
          type: mode,
          kind: f.kind,
          ...(investmentKind ? { holdingId: f.holdingId } : {}),
          cashHoldingId: f.cashHoldingId,
          ...(f.kind === 'transfer'
            ? { destinationCashHoldingId: f.destinationCashHoldingId }
            : {}),
          amount: f.amount,
          currency,
          fx,
          dueDate: f.dueDate,
          investmentEffect,
          ...(investmentEffect !== 'none'
            ? { investmentAmount: increase ? f.amount : f.investmentAmount }
            : {}),
          investmentCostBasisEUR:
            investmentEffect === 'none' ? '0' : f.investmentCostBasisEUR,
          commitmentEffect: ['capital_call', 'distribution'].includes(f.kind)
            ? f.commitmentEffect
            : 'none',
          commitmentAmountEUR:
            !['capital_call', 'distribution'].includes(f.kind) ||
            f.commitmentEffect === 'none'
              ? '0'
              : f.commitmentAmountEUR,
          memo: f.memo ?? '',
          ...proof,
        };
        break;
      case 'settleTransaction':
        command = { type: mode, transactionId, date: f.date, ...proof };
        break;
      case 'reverseTransaction':
        command = {
          type: mode,
          transactionId,
          date: f.date,
          reason: f.reason,
          ...proof,
        };
        break;
      case 'voidTransaction':
        command = { type: mode, transactionId, reason: f.reason, ...proof };
        break;
      case 'recordValuation':
        command = {
          type: mode,
          holdingId: f.holdingId,
          amount: f.amount,
          currency,
          fx,
          effectiveDate: f.effectiveDate,
          ...(correction
            ? {
                correction: {
                  expectedValueEUR: Number(f.expectedValueEUR),
                  reason: f.reason,
                },
              }
            : {}),
          ...proof,
        };
        break;
      case 'reconcilePeriod':
        command = {
          type: mode,
          entityId: f.entityId,
          from: f.from,
          to: f.to,
          cashHoldingIds: cashInEntity.map((h) => h.id),
          closingBalances: cashInEntity.map((h) => ({
            holdingId: h.id,
            amount: f['native-' + h.id] ?? '',
            valueEUR: f['eur-' + h.id] ?? '',
          })),
          ...proof,
        };
        break;
    }
    const parsed = ledgerCommandSchema.safeParse(command);
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join(' '),
      );
      return;
    }
    setBusy(true);
    try {
      await onSubmit(parsed.data);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The change could not be saved.',
      );
    } finally {
      setBusy(false);
    }
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
          <DialogTitle>{titles[mode]}</DialogTitle>
          <DialogDescription>
            {mode === 'settleTransaction'
              ? 'Record a payment already confirmed by your bank. This does not send money.'
              : mode === 'reverseTransaction'
                ? 'Append opposite postings with a correction reason. The original transaction remains visible.'
                : mode === 'reconcilePeriod'
                  ? 'Attest that every cash balance and external flow in this entity has been checked against statements. Comparable investment marks are still required for returns.'
                  : 'Use reviewed source amounts and explicit classifications. No conversion rate is fetched or inferred.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)}>
          <FieldGroup className={styles.formGrid}>
            {mode === 'createFamily' ? (
              <>
                {input('name', 'Family name')}
                {input('principal', 'Principal', 'text', undefined, false)}
                {input('location', 'Location', 'text', undefined, false)}
              </>
            ) : null}
            {mode === 'createEntity' ? (
              <>
                {pick(
                  'familyId',
                  'Family',
                  portfolio.families.map((row) => ({
                    value: row.id,
                    label: row.name,
                  })),
                )}
                {input('name', 'Legal entity name')}
                {pick(
                  'entityType',
                  'Entity type',
                  choices([...LEDGER_ENTITY_TYPES]),
                )}
                {input('jurisdiction', 'Jurisdiction')}
                {input(
                  'ownershipPercent',
                  'Family ownership (%)',
                  'number',
                  'Holding values must already represent the investor’s economic share; the percentage is not applied twice.',
                )}
              </>
            ) : null}
            {mode === 'reviewAccount' ? (
              <>
                {pick(
                  'accountId',
                  'Existing account',
                  portfolio.accounts.map((row) => ({
                    value: row.id,
                    label: row.name + ' · ' + row.institution,
                  })),
                )}
                {pick(
                  'currency',
                  'Confirmed account currency',
                  choices([...LEDGER_CURRENCIES]),
                )}
                {pick('restrictionState', 'Reviewed cash restriction', [
                  {
                    value: 'restricted',
                    label: 'Restricted · block settlement',
                  },
                  {
                    value: 'unrestricted',
                    label: 'Unrestricted · no restriction recorded',
                  },
                ])}
                {input(
                  'restrictionNote',
                  'Restriction / review note',
                  'text',
                  undefined,
                  false,
                )}
                <p className={styles.note}>
                  The source reference and reviewer are retained in the
                  account’s review history. Changing restrictions does not
                  transfer money.
                </p>
              </>
            ) : null}
            {mode === 'createAccount' ? (
              <>
                {pick(
                  'entityId',
                  'Legal entity',
                  portfolio.entities.map((row) => ({
                    value: row.id,
                    label: row.name,
                  })),
                )}
                {input('name', 'Account name')}
                {input('institution', 'Institution')}
                {pick(
                  'accountType',
                  'Account type',
                  choices(['Custody', 'Private investments', 'Property']),
                )}
                {pick(
                  'currency',
                  'Account currency',
                  choices([...LEDGER_CURRENCIES]),
                )}
                <Field orientation="horizontal">
                  <Checkbox
                    id="ledger-restricted"
                    checked={restricted}
                    onCheckedChange={(value) => setRestricted(value === true)}
                  />
                  <FieldLabel htmlFor="ledger-restricted">
                    Restricted cash account
                  </FieldLabel>
                </Field>
                {restricted
                  ? input('restrictionNote', 'Restriction details')
                  : null}
              </>
            ) : null}
            {mode === 'createHolding' ? (
              <>
                {pick(
                  'accountId',
                  'Existing account',
                  portfolio.accounts.map((row) => ({
                    value: row.id,
                    label:
                      row.name +
                      ' · ' +
                      portfolio.entities.find((e) => e.id === row.entityId)
                        ?.name,
                  })),
                )}
                {input('name', 'Investment name')}
                {pick('assetClass', 'Asset class', choices(classes))}
                {pick(
                  'currency',
                  'Source valuation currency',
                  choices([...LEDGER_CURRENCIES]),
                )}
                {input(
                  'amount',
                  'Original-currency value',
                  'text',
                  'Nonnegative amount with at most two decimal places.',
                )}
                {input('costBasisEUR', 'Recorded cost basis (EUR)')}
                {input('unfundedCommitmentEUR', 'Unfunded commitments (EUR)')}
                {input('valuationDate', 'Valuation effective date', 'date')}
                {pick(
                  'liquidityBucket',
                  'Liquidity classification',
                  choices(liquidities),
                )}
                {input('manager', 'Reported manager / custodian')}
                {input('geography', 'Reported geography')}
                {input('managerId', 'Manager ID', 'text', undefined, false)}
                {input(
                  'instrumentId',
                  'Instrument ID',
                  'text',
                  'ISIN, LEI or an internal stable key.',
                  false,
                )}
                {input(
                  'shareClassId',
                  'Share-class ID',
                  'text',
                  undefined,
                  false,
                )}
              </>
            ) : null}
            {mode === 'recordTransaction' ? (
              <>
                {pick('kind', 'Transaction kind', choices([...LEDGER_KINDS]))}
                {pick(
                  'cashHoldingId',
                  'Funding / receiving cash balance',
                  portfolio.holdings
                    .filter((h) => h.assetClass === 'Cash')
                    .map((h) => ({
                      value: h.id,
                      label:
                        h.name +
                        ' · ' +
                        nativeMoney(h.originalValue, h.currency),
                    })),
                )}
                {investmentKind
                  ? pick(
                      'holdingId',
                      'Investment',
                      portfolio.holdings
                        .filter(
                          (h) =>
                            h.assetClass !== 'Cash' &&
                            (!cash || h.entityId === cash.entityId),
                        )
                        .map((h) => ({ value: h.id, label: h.name })),
                    )
                  : null}
                {fields.kind === 'transfer'
                  ? pick(
                      'destinationCashHoldingId',
                      'Destination cash balance',
                      portfolio.holdings
                        .filter(
                          (h) =>
                            h.assetClass === 'Cash' &&
                            h.id !== cash?.id &&
                            h.entityId === cash?.entityId,
                        )
                        .map((h) => ({ value: h.id, label: h.name })),
                    )
                  : null}
                {input(
                  'amount',
                  `Payment amount (${currency})`,
                  'text',
                  'Enter a positive magnitude. The transaction kind determines its sign.',
                )}
                {input('dueDate', 'Due / expected date', 'date')}
                {fields.kind === 'distribution'
                  ? pick('investmentEffect', 'Distribution treatment', [
                      {
                        value: 'none',
                        label: 'Income · preserve investment value',
                      },
                      {
                        value: 'reduce',
                        label: 'Return of capital · reduce carrying value',
                      },
                    ])
                  : null}
                {investmentEffect === 'reduce'
                  ? input(
                      'investmentAmount',
                      `Investment carrying value released (${currency})`,
                      'text',
                      'Use the reviewed book amount; it can differ from sale proceeds.',
                    )
                  : null}
                {investmentEffect !== 'none'
                  ? input(
                      'investmentCostBasisEUR',
                      increase
                        ? 'New investment book cost (EUR)'
                        : 'Investment book cost released (EUR)',
                      'text',
                      increase
                        ? 'Must equal the funded EUR amount. Record fees separately.'
                        : 'Use the evidenced cost released, not an assumed share of proceeds.',
                    )
                  : null}
                {['capital_call', 'distribution'].includes(fields.kind)
                  ? pick('commitmentEffect', 'Unfunded commitment effect', [
                      { value: 'none', label: 'No commitment movement' },
                      fields.kind === 'capital_call'
                        ? {
                            value: 'reduce',
                            label: 'Reduce unfunded commitment',
                          }
                        : {
                            value: 'increase',
                            label:
                              'Increase · explicitly recallable distribution',
                          },
                    ])
                  : null}
                {fields.commitmentEffect !== 'none' &&
                ['capital_call', 'distribution'].includes(fields.kind)
                  ? input('commitmentAmountEUR', 'Commitment movement (EUR)')
                  : null}
                {input('memo', 'Review note', 'text', undefined, false)}
                <p className={styles.note}>
                  A reviewed transaction is an obligation or instruction record.
                  It changes no balance until settlement is separately
                  confirmed. Cross-entity and cross-currency funding are not
                  supported.
                </p>
              </>
            ) : null}
            {[
              'settleTransaction',
              'reverseTransaction',
              'voidTransaction',
            ].includes(mode) ? (
              <>
                <Alert className={styles.wide}>
                  <Wallet />
                  <AlertTitle>
                    {labelKind(tx?.kind ?? '')} ·{' '}
                    {tx ? nativeMoney(tx.amount, tx.currency) : ''}
                  </AlertTitle>
                  <AlertDescription>
                    {tx ? money(tx.amountEUR) + ' EUR recorded amount. ' : ''}
                    Original review and source references will remain in the
                    ledger.
                  </AlertDescription>
                </Alert>
                {mode !== 'voidTransaction'
                  ? input('date', 'Bank settlement / reversal date', 'date')
                  : null}
                {mode !== 'settleTransaction'
                  ? input('reason', 'Correction / cancellation reason')
                  : null}
              </>
            ) : null}
            {mode === 'recordValuation' ? (
              <>
                {pick(
                  'holdingId',
                  'Holding',
                  portfolio.holdings.map((h) => ({
                    value: h.id,
                    label: h.name,
                  })),
                )}
                {input('amount', 'Reported original-currency amount')}
                {pick(
                  'currency',
                  'Source currency',
                  choices([...LEDGER_CURRENCIES]),
                )}
                {input('effectiveDate', 'Effective date', 'date')}
                <Field orientation="horizontal" className={styles.wide}>
                  <Checkbox
                    id="ledger-correction"
                    checked={correction}
                    onCheckedChange={(value) => setCorrection(value === true)}
                  />
                  <FieldLabel htmlFor="ledger-correction">
                    This corrects an existing value for the same date
                  </FieldLabel>
                </Field>
                {correction ? (
                  <>
                    {input(
                      'expectedValueEUR',
                      'Current value being corrected (EUR)',
                      'text',
                      currentHolding
                        ? 'Latest holding value: ' +
                            money(currentHolding.valueEUR) +
                            '. Confirm the mark for the correction date.'
                        : undefined,
                    )}
                    {input('reason', 'Correction reason')}
                  </>
                ) : null}
              </>
            ) : null}
            {mode === 'reconcilePeriod' ? (
              <>
                {pick(
                  'entityId',
                  'Legal entity',
                  portfolio.entities.map((row) => ({
                    value: row.id,
                    label: row.name,
                  })),
                )}
                {input('from', 'Coverage begins', 'date')}
                {input('to', 'Coverage ends', 'date')}
                {cashInEntity.map((h) => (
                  <FieldGroup className={styles.balanceFields} key={h.id}>
                    <strong>{h.name}</strong>
                    {input(
                      'native-' + h.id,
                      `Statement closing balance (${h.currency})`,
                      'text',
                      'Recorded: ' + nativeMoney(h.originalValue, h.currency),
                    )}
                    {input(
                      'eur-' + h.id,
                      'Statement / evidenced converted balance (EUR)',
                      'text',
                      'Recorded: ' + money(h.valueEUR),
                    )}
                  </FieldGroup>
                ))}
                {!cashInEntity.length ? (
                  <p className={styles.note}>
                    Register this entity’s cash holdings before reconciling.
                  </p>
                ) : null}
              </>
            ) : null}
            {needsFX ? (
              <FieldGroup className={styles.section}>
                <div className={styles.wide}>
                  <h3>Explicit EUR conversion</h3>
                  <p className={styles.note}>
                    EUR per 1 {currency}. This dated rate is an entered
                    assumption supported by the reference you supply.
                  </p>
                </div>
                {input('fxRate', 'Rate to EUR')}
                {input('fxDate', 'FX rate date', 'date')}
                {input('fxSource', 'FX source / citation')}
              </FieldGroup>
            ) : null}
            {needsSource ? (
              <FieldGroup className={styles.section}>
                {input('sourceReference', 'Source report / bank reference')}
                {input('sourceDate', 'Source as of', 'date')}
                {input(
                  'sourceId',
                  'Existing evidence ID (optional)',
                  'text',
                  undefined,
                  false,
                )}
                <Field orientation="horizontal" className={styles.wide}>
                  <Checkbox
                    id="ledger-verified"
                    checked={verified}
                    onCheckedChange={(value) => setVerified(value === true)}
                    required
                  />
                  <FieldLabel htmlFor="ledger-verified">
                    {mode === 'reconcilePeriod'
                      ? 'I reconciled all account statements and external cash flows for this period.'
                      : 'I reviewed the source and confirm these financial instructions.'}
                  </FieldLabel>
                </Field>
              </FieldGroup>
            ) : null}
          </FieldGroup>
          {error ? (
            <Alert variant="destructive" className="mt-5">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className={styles.formActions}>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (needsSource && !verified)}>
              {busy
                ? 'Saving…'
                : mode === 'settleTransaction'
                  ? 'Record confirmed settlement'
                  : mode === 'reverseTransaction'
                    ? 'Append reversal'
                    : mode === 'recordTransaction'
                      ? 'Save reviewed transaction'
                      : 'Save reviewed record'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LedgerView({
  family,
  onFamily,
}: {
  family: string;
  onFamily: (value: string) => void;
}) {
  const { reload: reloadWorkspace } = useWorkspace();
  const [response, setResponse] = useState<LedgerResponse | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<{
    mode: LedgerCommand['type'];
    transactionId?: string;
    holdingId?: string;
  } | null>(null);
  const requestKey = useRef<{ body: string; key: string } | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      setResponse(await requestLedger('GET', undefined, signal));
      setError('');
    } catch (cause) {
      if (!signal?.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'The ledger could not be loaded.',
        );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void requestLedger('GET', undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setResponse(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'The ledger could not be loaded.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  const portfolio = response?.portfolio,
    finance = response?.finance;
  const holdings = useMemo(
    () =>
      portfolio?.holdings.filter(
        (h) => family === 'all' || h.familyId === family,
      ) ?? [],
    [portfolio, family],
  );
  const holdingIds = new Set(holdings.map((h) => h.id));
  const entities =
    portfolio?.entities.filter(
      (e) => family === 'all' || e.familyId === family,
    ) ?? [];
  const accounts =
    portfolio?.accounts.filter(
      (a) => family === 'all' || a.familyId === family,
    ) ?? [];
  const transactions =
    finance?.transactions
      .filter((tx) => holdingIds.has(tx.cashHoldingId))
      .toReversed() ?? [];
  const reviewed = transactions.filter(
    (tx) => finance && transactionStatus(finance, tx.id) === 'reviewed',
  );
  const outflows = reviewed
    .filter((tx) =>
      ['withdrawal', 'capital_call', 'purchase', 'fee', 'transfer'].includes(
        tx.kind,
      ),
    )
    .reduce((sum, tx) => sum + tx.amountEUR, 0);
  function open(
    mode: LedgerCommand['type'],
    extra: { transactionId?: string; holdingId?: string } = {},
  ) {
    requestKey.current = null;
    setDialog({ mode, ...extra });
    setNotice('');
  }
  async function save(command: LedgerCommand) {
    if (!response) throw new Error('Reload the ledger before saving.');
    const body = JSON.stringify(command);
    if (requestKey.current?.body !== body)
      requestKey.current = { body, key: crypto.randomUUID() };
    const next = await requestLedger('POST', {
      expectedRevision: response.revision,
      idempotencyKey: requestKey.current.key,
      command,
    });
    setResponse(next);
    setNotice(
      next.duplicate
        ? 'The earlier request was already saved; no duplicate was posted.'
        : 'Reviewed record saved.',
    );
    reloadWorkspace();
  }
  return (
    <div className={styles.root}>
      <PageHeading
        title="Investment register & ledger"
        subtitle="Recorded ownership, original-currency values and reviewed cash movements"
      >
        <FamilyPicker value={family} onChange={onFamily} />
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw data-icon="inline-start" />
          Reload
        </Button>
        {response?.canWrite ? (
          <Button
            onClick={() => open('createHolding')}
            disabled={!accounts.length}
          >
            <Plus data-icon="inline-start" />
            Add holding
          </Button>
        ) : null}
      </PageHeading>
      <Alert className={styles.intro}>
        <BookOpen />
        <AlertTitle>Financial records with an explicit review trail</AlertTitle>
        <AlertDescription>
          Recording a notice changes no balance. Settlement records confirmed
          activity; it never initiates a payment. Source currencies, conversions
          and reversals remain visible.
        </AlertDescription>
      </Alert>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Ledger needs attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <CheckCircle2 />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {loading && !response ? (
        <p className={styles.note}>Loading financial records…</p>
      ) : null}
      {portfolio && finance ? (
        <>
          <div className="metrics-row">
            <Metric
              label="Recorded holdings"
              value={String(holdings.length)}
              note={`${entities.length} entities · ${accounts.length} accounts`}
            />
            <Metric
              label="Recorded cash"
              value={money(
                holdings
                  .filter((h) => h.assetClass === 'Cash')
                  .reduce((sum, h) => sum + h.valueEUR, 0),
              )}
              note="Account restrictions still apply"
            />
            <Metric
              label="Reviewed cash outflows"
              value={money(outflows)}
              note={`${reviewed.length} unsettled transactions · no payment initiated`}
            />
            <Metric
              label="Unfunded commitments"
              value={
                holdings.some((h) => h.unfundedStatus === 'unknown')
                  ? 'Incomplete'
                  : money(
                      holdings.reduce(
                        (sum, h) => sum + h.unfundedCommitmentEUR,
                        0,
                      ),
                    )
              }
              note="Updated only by explicit posted movements"
            />
          </div>
          <Tabs defaultValue="register" className={styles.stack}>
            <TabsList variant="line">
              <TabsTrigger value="register">Register</TabsTrigger>
              <TabsTrigger value="transactions">Transactions</TabsTrigger>
              <TabsTrigger value="valuations">Valuations</TabsTrigger>
              <TabsTrigger value="coverage">Reconciliation</TabsTrigger>
            </TabsList>
            <TabsContent value="register" className={styles.stack}>
              <div className={styles.grid}>
                <Panel
                  title="Ownership & accounts"
                  subtitle="Reusable legal entities and their actual accounts"
                  action={
                    response.canWrite ? (
                      <div className={styles.actions}>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => open('createFamily')}
                        >
                          Family
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!portfolio.families.length}
                          onClick={() => open('createEntity')}
                        >
                          Entity
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!entities.length}
                          onClick={() => open('createAccount')}
                        >
                          Account
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!accounts.length}
                          onClick={() => open('reviewAccount')}
                        >
                          Review account
                        </Button>
                      </div>
                    ) : undefined
                  }
                >
                  {entities.length ? (
                    entities.map((entity) => (
                      <div className={styles.entity} key={entity.id}>
                        <div>
                          <strong>{entity.name}</strong>
                          <Badge variant="outline">
                            {entity.ownershipPercent}% recorded ownership
                          </Badge>
                        </div>
                        <p>
                          {
                            portfolio.families.find(
                              (f) => f.id === entity.familyId,
                            )?.name
                          }{' '}
                          · {entity.jurisdiction}
                        </p>
                        {accounts
                          .filter((a) => a.entityId === entity.id)
                          .map((account) => (
                            <div className={styles.account} key={account.id}>
                              <Wallet />
                              <div>
                                {account.name}
                                <small>
                                  {account.institution} ·{' '}
                                  {finance.accounts[account.id]?.currency ??
                                    'Currency not registered'}
                                </small>
                                {finance.accounts[account.id]?.reviews?.map(
                                  (review, index) => (
                                    <small key={index}>
                                      {review.restricted
                                        ? 'Restricted'
                                        : 'Unrestricted'}{' '}
                                      · {review.source.reference} · reviewed{' '}
                                      {new Date(
                                        review.reviewedAt,
                                      ).toLocaleDateString()}{' '}
                                      by {review.reviewedBy}
                                    </small>
                                  ),
                                )}
                              </div>
                              {finance.accounts[account.id]?.restricted ? (
                                <Badge variant="destructive">Restricted</Badge>
                              ) : null}
                            </div>
                          ))}
                      </div>
                    ))
                  ) : (
                    <Blank>
                      Add the family, legal entity and account once, then reuse
                      them for holdings.
                    </Blank>
                  )}
                </Panel>
                <Panel
                  title="Bookkeeping boundaries"
                  subtitle="Current records and model assumptions"
                >
                  <ul className={styles.notes}>
                    <li>
                      Holding values are the investor’s economic share. Recorded
                      ownership is not multiplied into NAV again.
                    </li>
                    <li>
                      Capital funding bridges the last reported mark until a new
                      valuation is reviewed. It is not a new manager-reported
                      NAV.
                    </li>
                    <li>
                      Cash transfers and funding are restricted to the same
                      legal entity and currency. Account restrictions block
                      settlement.
                    </li>
                    <li>
                      Investment cost releases are explicit. Cash book cost uses
                      average cost; this ledger is not a tax-lot system.
                    </li>
                  </ul>
                </Panel>
              </div>
              <Panel
                title="Investment register"
                subtitle="Native source amount, EUR book value and stable identifiers"
              >
                {holdings.length ? (
                  <Table className={styles.table}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Holding / account</TableHead>
                        <TableHead>Original currency</TableHead>
                        <TableHead className={styles.number}>
                          Current EUR value
                        </TableHead>
                        <TableHead>Valuation basis</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {holdings.map((h) => (
                        <TableRow key={h.id}>
                          <TableCell>
                            <strong>{h.name}</strong>
                            <small>
                              {
                                portfolio.accounts.find(
                                  (a) => a.id === h.accountId,
                                )?.name
                              }{' '}
                              · {h.manager}
                            </small>
                            <small>
                              {[
                                finance.holdings[h.id]?.instrumentId,
                                finance.holdings[h.id]?.shareClassId,
                              ]
                                .filter(Boolean)
                                .join(' · ') ||
                                'Instrument / share-class IDs not recorded'}
                            </small>
                          </TableCell>
                          <TableCell>
                            {h.valuationStatus === 'unknown'
                              ? 'Not reported'
                              : nativeMoney(h.originalValue, h.currency)}
                            <small>
                              {finance.holdings[h.id]?.fx
                                ? `FX ${finance.holdings[h.id].fx!.rateToEUR} · ${dateLabel(finance.holdings[h.id].fx!.date)}`
                                : h.currency === 'EUR'
                                  ? 'EUR source value'
                                  : 'Conversion evidence not in ledger'}
                            </small>
                          </TableCell>
                          <TableCell className={styles.number}>
                            {h.valuationStatus === 'unknown'
                              ? 'Not reported'
                              : money(h.valueEUR)}
                          </TableCell>
                          <TableCell>
                            {h.valuationMethod}
                            <small>
                              {h.valuationStatus === 'unknown'
                                ? 'Valuation required'
                                : dateLabel(h.valuationDate)}
                              {finance.holdings[h.id]?.pendingCapitalEUR
                                ? ` · Capital bridge ${money(finance.holdings[h.id].pendingCapitalEUR)}`
                                : ''}
                            </small>
                          </TableCell>
                          <TableCell>
                            {response.canWrite ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  open('recordValuation', { holdingId: h.id })
                                }
                              >
                                Record mark
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <Blank>
                    Add a sourced opening position in an existing account.
                  </Blank>
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="transactions" className={styles.stack}>
              <Panel
                title="Reviewed transactions & obligations"
                subtitle="Notices, settlements and corrections remain separate"
                action={
                  response.canWrite ? (
                    <Button
                      size="sm"
                      disabled={!holdings.some((h) => h.assetClass === 'Cash')}
                      onClick={() => open('recordTransaction')}
                    >
                      <Plus data-icon="inline-start" />
                      Review transaction
                    </Button>
                  ) : undefined
                }
              >
                {transactions.length ? (
                  <Table className={styles.table}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Transaction</TableHead>
                        <TableHead>Cash / investment</TableHead>
                        <TableHead className={styles.number}>Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {transactions.map((tx) => {
                        const status = transactionStatus(finance, tx.id);
                        return (
                          <TableRow key={tx.id}>
                            <TableCell>
                              {labelKind(tx.kind)}
                              <small>
                                Due {dateLabel(tx.dueDate)} ·{' '}
                                {tx.source.reference}
                              </small>
                              <small>{tx.memo}</small>
                            </TableCell>
                            <TableCell>
                              {
                                portfolio.holdings.find(
                                  (h) => h.id === tx.cashHoldingId,
                                )?.name
                              }
                              <small>
                                {portfolio.holdings.find(
                                  (h) => h.id === tx.holdingId,
                                )?.name ??
                                  (tx.destinationCashHoldingId
                                    ? portfolio.holdings.find(
                                        (h) =>
                                          h.id === tx.destinationCashHoldingId,
                                      )?.name
                                    : 'Portfolio cash movement')}
                              </small>
                            </TableCell>
                            <TableCell className={styles.number}>
                              {nativeMoney(tx.amount, tx.currency)}
                              <small>{money(tx.amountEUR)}</small>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  status === 'settled' ? 'secondary' : 'outline'
                                }
                              >
                                {labelKind(status)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className={styles.actions}>
                                {response.canWrite && status === 'reviewed' ? (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        open('settleTransaction', {
                                          transactionId: tx.id,
                                        })
                                      }
                                    >
                                      <CheckCircle2 data-icon="inline-start" />
                                      Settle
                                    </Button>
                                    <Button
                                      size="icon-sm"
                                      variant="ghost"
                                      aria-label={'Void ' + tx.id}
                                      onClick={() =>
                                        open('voidTransaction', {
                                          transactionId: tx.id,
                                        })
                                      }
                                    >
                                      <X />
                                    </Button>
                                  </>
                                ) : null}
                                {response.canWrite && status === 'settled' ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      open('reverseTransaction', {
                                        transactionId: tx.id,
                                      })
                                    }
                                  >
                                    <RotateCcw data-icon="inline-start" />
                                    Reverse
                                  </Button>
                                ) : null}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : (
                  <Blank>
                    Review a deposit, withdrawal, capital call, distribution,
                    trade, fee or cash transfer. Settlement is a separate
                    action.
                  </Blank>
                )}
              </Panel>
              <Panel
                title="Append-only posting history"
                subtitle="Signed postings and source references"
              >
                {finance.events.filter(
                  (e) =>
                    e.postings.some((p) => holdingIds.has(p.holdingId)) ||
                    transactions.some((t) => t.id === e.transactionId),
                ).length ? (
                  <div className={styles.eventList}>
                    {finance.events
                      .filter(
                        (e) =>
                          e.postings.some((p) => holdingIds.has(p.holdingId)) ||
                          transactions.some((t) => t.id === e.transactionId),
                      )
                      .toReversed()
                      .map((event) => (
                        <div className={styles.event} key={event.id}>
                          <FileText />
                          <div>
                            <strong>
                              {labelKind(event.type)} · {dateLabel(event.date)}
                            </strong>
                            <p>{event.reason}</p>
                            <p>
                              {event.source.reference} · reviewed by{' '}
                              {event.actorId}
                            </p>
                            {event.postings.map((post) => (
                              <p key={post.holdingId}>
                                {
                                  portfolio.holdings.find(
                                    (h) => h.id === post.holdingId,
                                  )?.name
                                }
                                : {post.valueEURDelta >= 0 ? '+' : ''}
                                {money(post.valueEURDelta)}
                                {post.commitmentEURDelta
                                  ? ` · Unfunded ${post.commitmentEURDelta >= 0 ? '+' : ''}${money(post.commitmentEURDelta)}`
                                  : ''}
                              </p>
                            ))}
                          </div>
                          <Badge variant="outline">
                            {event.externalFlowEUR
                              ? `${money(event.externalFlowEUR)} external flow`
                              : 'Internal / no external flow'}
                          </Badge>
                        </div>
                      ))}
                  </div>
                ) : (
                  <Blank>No cash movement has been posted.</Blank>
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="valuations" className={styles.stack}>
              <Panel
                title="Reviewed valuation versions"
                subtitle="Original amount, source currency and explicit correction provenance"
                action={
                  response.canWrite ? (
                    <Button
                      size="sm"
                      disabled={!holdings.length}
                      onClick={() => open('recordValuation')}
                    >
                      <Plus data-icon="inline-start" />
                      Record valuation
                    </Button>
                  ) : undefined
                }
              >
                {finance.valuations.some((v) => holdingIds.has(v.holdingId)) ? (
                  <Table className={styles.table}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Holding / effective date</TableHead>
                        <TableHead>Source amount</TableHead>
                        <TableHead className={styles.number}>
                          EUR mark
                        </TableHead>
                        <TableHead>Provenance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {finance.valuations
                        .filter((v) => holdingIds.has(v.holdingId))
                        .toReversed()
                        .map((v) => (
                          <TableRow key={v.id}>
                            <TableCell>
                              {
                                portfolio.holdings.find(
                                  (h) => h.id === v.holdingId,
                                )?.name
                              }
                              <small>{dateLabel(v.effectiveDate)}</small>
                            </TableCell>
                            <TableCell>
                              {nativeMoney(v.amount, v.currency)}
                              <small>
                                {v.fx
                                  ? `${v.fx.rateToEUR} EUR per ${v.currency} · ${v.fx.source}`
                                  : 'No FX conversion'}
                              </small>
                            </TableCell>
                            <TableCell className={styles.number}>
                              {money(v.valueEUR)}
                            </TableCell>
                            <TableCell>
                              {v.correctionOf ? (
                                <Badge variant="outline">Correction</Badge>
                              ) : null}
                              <small>
                                {v.correctionReason ?? v.valuationMethod}
                              </small>
                              <small>Evidence {v.sourceId}</small>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                ) : (
                  <Blank>
                    Existing marks remain in Investments. Newly reviewed marks
                    and corrections will appear here.
                  </Blank>
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="coverage" className={styles.stack}>
              <Alert>
                <CheckCircle2 />
                <AlertTitle>
                  Reconciled cash-flow coverage is separate from return
                  availability
                </AlertTitle>
                <AlertDescription>
                  Reconcile complete entity cash statements, then independently
                  establish comparable investment marks. This feature does not
                  turn incomplete recorded marks into investment returns. Later
                  ledger changes invalidate the current coverage attestation.
                </AlertDescription>
              </Alert>
              <Panel
                title="Cash reconciliation periods"
                subtitle="Closing native and EUR balances must match the ledger"
                action={
                  response.canWrite ? (
                    <Button
                      size="sm"
                      disabled={!holdings.some((h) => h.assetClass === 'Cash')}
                      onClick={() => open('reconcilePeriod')}
                    >
                      <Plus data-icon="inline-start" />
                      Reconcile period
                    </Button>
                  ) : undefined
                }
              >
                {finance.coverage.filter(
                  (c) => family === 'all' || c.familyId === family,
                ).length ? (
                  <Table className={styles.table}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Legal entity</TableHead>
                        <TableHead>Period</TableHead>
                        <TableHead>Coverage</TableHead>
                        <TableHead>Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {finance.coverage
                        .filter(
                          (c) => family === 'all' || c.familyId === family,
                        )
                        .toReversed()
                        .map((c) => (
                          <TableRow key={c.id}>
                            <TableCell>
                              {
                                portfolio.entities.find(
                                  (e) => e.id === c.entityId,
                                )?.name
                              }
                            </TableCell>
                            <TableCell>
                              {dateLabel(c.from)} → {dateLabel(c.to)}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  cashflowCoverageCurrent(finance, portfolio, c)
                                    ? 'secondary'
                                    : 'outline'
                                }
                              >
                                {cashflowCoverageCurrent(finance, portfolio, c)
                                  ? 'Reconciled'
                                  : 'Review after ledger changes'}
                              </Badge>
                              <small>
                                {c.cashHoldingIds.length} cash balances
                              </small>
                            </TableCell>
                            <TableCell>
                              {c.source.reference}
                              <small>{c.reviewedBy}</small>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                ) : (
                  <Blank>
                    No period is asserted complete. Unknown external flows stay
                    unknown.
                  </Blank>
                )}
              </Panel>
            </TabsContent>
          </Tabs>
          <p className={styles.footnote}>
            Long-only recorded balances, four supported currencies and no
            overdrafts. Settlement and FX changes require source review; no
            banking, trading, market-data or tax-lot connection is implied.
          </p>
          {dialog ? (
            <LedgerForm
              key={dialog.mode + dialog.transactionId + dialog.holdingId}
              mode={dialog.mode}
              portfolio={portfolio}
              finance={finance}
              transactionId={dialog.transactionId}
              holdingId={dialog.holdingId}
              onClose={() => setDialog(null)}
              onSubmit={save}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
