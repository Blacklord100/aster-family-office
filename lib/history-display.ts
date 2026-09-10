import type { PortfolioHistoryResponse } from './portfolio-history-contract';

/** Preserve all reported digits in tables and exports; compact headlines are display-only. */
export function historyAmount(
  value: string | null | undefined,
  currency = 'EUR',
  compact = false,
): string {
  if (value == null || !/^-?\d+(?:\.\d+)?$/.test(value)) return 'Unavailable';
  const number = Number(value);
  if (compact && Math.abs(number) >= 1e6 && Number.isFinite(number))
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 2,
    })
      .format(number)
      .replace('m', 'M');
  const negative = value.startsWith('-'),
    [whole, fractional = ''] = value.replace(/^-/, '').split('.');
  const symbol =
    ({ EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ' } as Record<string, string>)[
      currency
    ] ?? currency + ' ';
  return (
    (negative ? '−' : '') +
    symbol +
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
    '.' +
    fractional.padEnd(2, '0')
  );
}
export function csvCell(value: string | number | null | undefined): string {
  const text = String(value ?? '');
  return (
    '"' +
    (/^[=+@\t\r-]/.test(text) ? "'" + text : text).replaceAll('"', '""') +
    '"'
  );
}
export function portfolioHistoryCSV(data: PortfolioHistoryResponse): string {
  const rows: (string | number | null | undefined)[][] = [
    ['Aster portfolio history', data.projectionVersion],
    [
      'As of',
      data.asOf,
      'Currency',
      data.query.currency,
      'Workspace revision',
      data.revision,
    ],
    ['Historical basis', data.basis],
    [
      'Knowledge',
      data.query.knowledge,
      'Cutoff',
      data.query.knownAt ?? 'Latest accepted knowledge',
    ],
    [],
    [
      'Investment',
      'Family ID',
      'Entity ID',
      'As of',
      'Reported value',
      'Currency',
      'Valuation date',
      'Previous reported value',
      'Previous valuation date',
      'Value change',
      'Source ID',
      'Source file',
      'Observation ID',
    ],
    ...data.positions.map((p) => [
      p.investmentName,
      p.familyId,
      p.entityId,
      data.asOf,
      p.latest?.amount,
      data.query.currency,
      p.latest?.effectiveDate,
      p.previousComparable?.amount,
      p.previousComparable?.effectiveDate,
      p.changeAmount,
      p.latest?.sourceId,
      p.latest?.filename,
      p.latest?.id,
    ]),
    [],
    [
      'Historical date',
      'Full value',
      'Known subtotal',
      'Currency',
      'Holdings valued',
      'Holdings in scope',
      'Carried forward',
      'Observation IDs',
    ],
    ...data.points.map((p) => [
      p.date,
      p.amount,
      p.knownAmount,
      p.currency,
      p.coverage.knownCount,
      p.coverage.totalCount,
      p.coverage.carriedCount,
      p.observationIds.join('; '),
    ]),
  ];
  return '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
export function downloadHistoryCSV(data: PortfolioHistoryResponse) {
  const url = URL.createObjectURL(
    new Blob([portfolioHistoryCSV(data)], { type: 'text/csv;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `aster-portfolio-${data.asOf}-${data.query.currency}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
