export type DemoIntent =
  | 'allocation'
  | 'liquidity'
  | 'unfunded_commitments'
  | 'latest_updates'
  | 'unsupported';

interface Cited {
  evidenceCitationIds: string[];
}
export interface QueryHolding extends Cited {
  id: string;
  name: string;
  assetClass: string;
  valueMinor: number;
  valuationDate: string;
}
export interface QueryCash extends Cited {
  id: string;
  name: string;
  amountMinor: number;
  asOfDate: string;
}
export interface QueryCommitment extends Cited {
  id: string;
  fundName: string;
  unfundedMinor: number;
}
export interface QueryObligation extends Cited {
  id: string;
  name: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  status: 'expected' | 'settled' | 'cancelled';
}
export interface QueryUpdate extends Cited {
  id: string;
  title: string;
  summary: string;
  date: string;
  effectiveDate?: string;
}
export interface DemoQueryData {
  asOfDate: string;
  reportingCurrency: string;
  holdings: QueryHolding[];
  cash: QueryCash[];
  commitments: QueryCommitment[];
  obligations: QueryObligation[];
  updates: QueryUpdate[];
}
export interface DemoAnswer {
  mode: 'grounded_demo';
  intent: DemoIntent;
  answer: string;
  evidenceCitationIds: string[];
  facts: Array<{ label: string; value: string; evidenceCitationIds: string[] }>;
  notice: string;
}

export const DEMO_QUERY_NOTICE =
  'Answered from synthetic workspace records using fixed query rules. No LLM or live data connection.';
const citations = (rows: Cited[]): string[] =>
  [...new Set(rows.flatMap((row) => row.evidenceCitationIds))].sort();
const dedup = <T extends { id: string }>(rows: T[]): T[] => [
  ...new Map(rows.map((row) => [row.id, row])).values(),
];
const money = (minor: number, currency: string): string =>
  new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(minor / 100);
const checkedSum = (numbers: number[]): number => {
  if (numbers.some((value) => !Number.isSafeInteger(value)))
    throw new Error('Grounded money inputs must be integer minor units.');
  const result = numbers.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result))
    throw new Error('Money total exceeds safe integer range.');
  return result;
};

export function resolveDemoIntent(question: string): DemoIntent {
  const text = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    /\b(returns?|performance|irr|twr|buy|sell|recommend|forecast|predict|outperform)\b/.test(
      text,
    )
  )
    return 'unsupported';
  if (
    /\b(liquid(?:ity)?|cash|cover|pay|funding|runway|capital calls?)\b/.test(
      text,
    )
  )
    return 'liquidity';
  if (/\b(unfunded|commitments?)\b/.test(text)) return 'unfunded_commitments';
  if (
    /\b(latest|recent|updates?|news|happened|developments?|changed)\b/.test(
      text,
    )
  )
    return 'latest_updates';
  if (
    /\b(allocation|allocated|asset mix|portfolio|holdings?|exposure|invested|assets?)\b/.test(
      text,
    )
  )
    return 'allocation';
  return 'unsupported';
}

/** Answers only the named demo intents from supplied records; no generated facts. */
export function answerDemoQuestion(
  question: string,
  data: DemoQueryData,
): DemoAnswer {
  const intent = resolveDemoIntent(question);
  const result: DemoAnswer = {
    mode: 'grounded_demo',
    intent,
    answer: '',
    evidenceCitationIds: [],
    facts: [],
    notice: DEMO_QUERY_NOTICE,
  };
  if (intent === 'allocation') {
    const holdings = dedup(data.holdings);
    if (!holdings.length) {
      result.answer = 'No holdings are available in this demo selection.';
      return result;
    }
    const total = checkedSum(holdings.map((holding) => holding.valueMinor));
    const grouped = new Map<string, QueryHolding[]>();
    for (const holding of holdings)
      grouped.set(holding.assetClass, [
        ...(grouped.get(holding.assetClass) ?? []),
        holding,
      ]);
    result.facts = [...grouped.entries()]
      .map(([label, rows]) => {
        const value = checkedSum(rows.map((row) => row.valueMinor));
        return {
          label,
          value: `${money(value, data.reportingCurrency)}${total > 0 ? ` · ${((value / total) * 100).toFixed(1)}%` : ''}`,
          evidenceCitationIds: citations(rows),
          amount: value,
        };
      })
      .sort((a, b) => b.amount - a.amount)
      .map(({ amount: _amount, ...row }) => row);
    result.answer = `Latest accepted reported holdings total ${money(total, data.reportingCurrency)} across ${holdings.length} positions. ${result.facts.map((row) => `${row.label}: ${row.value}`).join('; ')}. Values may have different valuation dates; this is allocation, not investment return.`;
    result.evidenceCitationIds = citations(holdings);
  } else if (intent === 'liquidity') {
    const cash = dedup(data.cash);
    if (!cash.length) {
      result.answer =
        'No reported cash balances are available in this demo selection.';
      return result;
    }
    const asOf = Date.parse(`${data.asOfDate}T00:00:00Z`);
    if (!Number.isFinite(asOf))
      throw new Error('Query as-of date must be valid.');
    const horizon = new Date(asOf + 30 * 86_400_000).toISOString().slice(0, 10);
    const obligations = dedup(data.obligations).filter(
      (row) => row.status === 'expected' && row.dueDate <= horizon,
    );
    const comparable = obligations.filter(
      (row) => row.currency === data.reportingCurrency,
    );
    const otherCurrency = obligations.filter(
      (row) => row.currency !== data.reportingCurrency,
    );
    const balance = checkedSum(cash.map((row) => row.amountMinor));
    const calls = checkedSum(comparable.map((row) => row.amountMinor));
    result.facts = [
      {
        label: 'Reported cash',
        value: money(balance, data.reportingCurrency),
        evidenceCitationIds: citations(cash),
      },
      {
        label: `Expected calls through ${horizon}`,
        value: money(calls, data.reportingCurrency),
        evidenceCitationIds: citations(comparable),
      },
      {
        label: 'Illustrative cash after those calls',
        value: money(balance - calls, data.reportingCurrency),
        evidenceCitationIds: citations([...cash, ...comparable]),
      },
    ];
    result.answer = `Reported cash is ${money(balance, data.reportingCurrency)}. Expected calls due through ${horizon}, including any overdue calls, total ${money(calls, data.reportingCurrency)}; illustrative cash after those calls is ${money(balance - calls, data.reportingCurrency)}. This is a scenario: notices have not changed settled cash, expected distributions are excluded, and withdrawal availability is not established.${otherCurrency.length ? ` ${otherCurrency.length} obligation(s) in other currencies are excluded from this comparison.` : ''}`;
    result.evidenceCitationIds = citations([...cash, ...obligations]);
  } else if (intent === 'unfunded_commitments') {
    const commitments = dedup(data.commitments);
    if (!commitments.length) {
      result.answer =
        'No unfunded-commitment records are available in this demo selection.';
      return result;
    }
    const total = checkedSum(commitments.map((row) => row.unfundedMinor));
    result.facts = [...commitments]
      .sort((a, b) => b.unfundedMinor - a.unfundedMinor)
      .map((row) => ({
        label: row.fundName,
        value: money(row.unfundedMinor, data.reportingCurrency),
        evidenceCitationIds: row.evidenceCitationIds,
      }));
    result.answer = `Reported unfunded commitments total ${money(total, data.reportingCurrency)} across ${commitments.length} funds. ${result.facts.map((row) => `${row.label}: ${row.value}`).join('; ')}. They are separate from current NAV and reported cash. A received capital-call notice alone does not reduce this balance.`;
    result.evidenceCitationIds = citations(commitments);
  } else if (intent === 'latest_updates') {
    const updates = dedup(data.updates)
      .filter((row) => row.date <= data.asOfDate)
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
      .slice(0, 5);
    if (!updates.length) {
      result.answer = 'No dated updates are available in this demo selection.';
      return result;
    }
    result.facts = updates.map((row) => ({
      label: `${row.date}${row.effectiveDate && row.effectiveDate !== row.date ? ` (effective ${row.effectiveDate})` : ''} · ${row.title}`,
      value: row.summary,
      evidenceCitationIds: row.evidenceCitationIds,
    }));
    result.answer = result.facts
      .map((row) => `${row.label}: ${row.value}`)
      .join('\n\n');
    result.evidenceCitationIds = citations(updates);
  } else {
    result.answer =
      'This synthetic demo supports questions about portfolio allocation, reported cash and upcoming calls, unfunded commitments, and latest updates. It does not use an LLM or search live mail. Try “What is our asset allocation?” or “How much unfunded commitment remains?”';
  }
  return result;
}
