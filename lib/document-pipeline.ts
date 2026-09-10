import type { ProcessingJob } from './processing-contract';

export const documentStages = [
  { value: 'all', label: 'All documents', statuses: [] },
  {
    value: 'awaiting_review',
    label: 'Needs review',
    statuses: ['awaiting_review'],
  },
  {
    value: 'working',
    label: 'In progress',
    statuses: ['queued', 'processing'],
  },
  { value: 'failed', label: 'Blocked', statuses: ['failed'] },
  { value: 'accepted', label: 'Completed', statuses: ['accepted'] },
  { value: 'closed', label: 'Closed', statuses: ['rejected', 'cancelled'] },
] as const;

export function documentStage(job: ProcessingJob) {
  if (job.activity?.stage === 'waiting_for_capacity')
    return 'Waiting for capacity';
  return (
    (
      {
        queued: 'Queued',
        processing: 'Extracting',
        awaiting_review: 'Needs review',
        accepted: 'Completed',
        failed: 'Blocked',
        cancelled: 'Cancelled',
        rejected: 'Closed',
      } as Record<string, string>
    )[job.status] ?? job.status
  );
}

export function documentTone(status: string) {
  if (status === 'accepted') return 'success';
  if (['awaiting_review', 'failed'].includes(status)) return 'warning';
  if (['processing', 'queued'].includes(status)) return 'violet';
  return 'neutral';
}

export function factCounts(job: ProcessingJob) {
  if (job.summary?.availability === 'available') return job.summary;
  if (!job.result || ['queued', 'processing'].includes(job.status)) return null;
  const counts = {
    extractedCount: job.result.facts.length,
    acceptedCount: 0,
    deferredCount: 0,
    rejectedCount: 0,
    pendingCount: 0,
    legacyCount: 0,
    remainingCount: 0,
  };
  for (let index = 0; index < job.result.facts.length; index++) {
    const status =
      job.review?.facts.find((fact) => fact.factIndex === index)?.status ??
      (job.status === 'accepted'
        ? 'legacy'
        : job.status === 'rejected'
          ? 'rejected'
          : 'pending');
    counts[`${status}Count`]++;
  }
  counts.remainingCount = counts.pendingCount + counts.deferredCount;
  return counts;
}

/** Durations come from worker measurements, never a document's last review time. */
export function durationLabel(milliseconds: number | null | undefined) {
  if (
    milliseconds == null ||
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  )
    return 'Not recorded';
  if (milliseconds < 1000) return '<1s';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function documentNextStep(job: ProcessingJob) {
  const counts = factCounts(job);
  if (job.status === 'failed')
    return {
      label: 'Resolve issue',
      detail: 'Check the source and retry extraction.',
    };
  if (job.status === 'cancelled')
    return { label: 'Retry extraction', detail: 'The original is retained.' };
  if (job.status === 'queued')
    return {
      label: 'View activity',
      detail:
        job.activity?.stage === 'waiting_for_capacity'
          ? 'Waiting for the selected engine.'
          : 'Waiting for an available worker.',
    };
  if (job.status === 'processing')
    return {
      label: 'View activity',
      detail: 'Reading and extracting information.',
    };
  if (job.status === 'awaiting_review') {
    const remaining = counts?.remainingCount;
    return {
      label: 'Review document',
      detail: remaining
        ? `${remaining} fact ${remaining === 1 ? 'decision remains' : 'decisions remain'}.`
        : 'Check the source and extraction notes.',
    };
  }
  if (counts?.legacyCount)
    return {
      label: 'View record',
      detail: 'Earlier fact decisions were not recorded.',
    };
  return {
    label: 'View record',
    detail:
      job.status === 'accepted'
        ? 'Review complete; decisions retained.'
        : 'No further extraction is scheduled.',
  };
}

export function factTypeLabel(kind: string) {
  return (
    (
      {
        valuation: 'Valuation',
        capital_call: 'Capital call',
        distribution: 'Distribution',
        news: 'Update',
      } as Record<string, string>
    )[kind] ?? kind.replaceAll('_', ' ')
  );
}

/** Keep every reported decimal digit; floating-point conversion can change large amounts. */
export function reportedAmountLabel(amount: string) {
  const [integer, fraction] = amount.split('.');
  return (
    integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
    (fraction === undefined ? '' : '.' + fraction)
  );
}

export function documentTimestamp(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  return new Date(value).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
