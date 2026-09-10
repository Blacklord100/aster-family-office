import type { HistoryObservation } from './portfolio-history-contract';

/** Keep authoritative decimal digits; Number conversion belongs only in chart geometry. */
export function historyMoney(
  amount: string | null | undefined,
  currency = 'EUR',
) {
  if (amount == null || !/^-?\d+(?:\.\d+)?$/.test(amount))
    return 'Not available';
  const negative = amount.startsWith('-');
  const [whole, decimals = ''] = amount.replace(/^-/, '').split('.');
  const grouped = new Intl.NumberFormat('en-GB').format(BigInt(whole));
  return `${negative ? '−' : ''}${currency} ${grouped}.${decimals.padEnd(2, '0')}`;
}

export function historyDateTime(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

export function historyCsv(rows: readonly HistoryObservation[]) {
  const cell = (value: string | number | null | undefined) => {
    const text = String(value ?? '');
    return (
      '"' +
      (/^[=+@\t\r-]/.test(text) ? "'" + text : text).replaceAll('"', '""') +
      '"'
    );
  };
  return (
    '\ufeff' +
    [
      [
        'Observation ID',
        'Investment',
        'Effective date',
        'Original amount',
        'Original currency',
        'Reporting amount',
        'Reporting currency',
        'Value change',
        'Valuation basis',
        'FX rate to EUR',
        'FX date',
        'FX source',
        'Imported at',
        'Recorded at',
        'Status',
        'Version',
        'Source',
        'Source ID',
        'Correction of',
        'Correction reason',
      ],
      ...rows.map((row) => [
        row.id,
        row.investmentName,
        row.effectiveDate,
        row.nativeAmount,
        row.currency,
        row.amount,
        row.displayCurrency,
        row.changeAmount,
        row.valuationBasis,
        row.fx?.rateToEUR,
        row.fx?.date,
        row.fx?.source,
        row.importedAt,
        row.recordedAt,
        row.status,
        row.version,
        row.filename,
        row.sourceId,
        row.correctionOf,
        row.correctionReason,
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n')
  );
}
