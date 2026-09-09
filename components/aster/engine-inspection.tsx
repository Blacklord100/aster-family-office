import type { EngineInspection } from '@/lib/engine-inspection';
import styles from './engines.module.css';

const imageStatus: Record<EngineInspection['vision']['effective'], string> = {
  enabled: 'Available for eligible pages',
  model_unsupported: 'Text only · model does not advertise image support',
  metadata_unknown: 'Text only · image capability could not be verified',
  deployment_disabled: 'Images disabled by deployment settings',
  provider_disabled: 'Images disabled in this cloud adapter',
};
const count = (value: number) => value.toLocaleString('en-GB');
const bytes = (value: number, exact = false) => {
  const readable =
    value >= 1048576
      ? `${count(Math.round((value / 1048576) * 10) / 10)} MiB`
      : value >= 1024
        ? `${count(Math.round((value / 1024) * 10) / 10)} KiB`
        : `${count(value)} bytes`;
  return exact && value >= 1024
    ? `${readable} (${count(value)} bytes)`
    : readable;
};

export function EngineInspectionDetails({
  inspection,
}: {
  inspection: EngineInspection;
}) {
  const { limits, vision } = inspection;
  const values = [
    [
      'Input',
      `${bytes(limits.maxFileBytes)} · ${count(limits.maxPages)} pages · ${count(limits.maxTextCharacters)} text characters`,
    ],
    [
      'Email tree',
      `Depth ${limits.maxNestedEmailDepth} · ${limits.maxEmailParts} parts · ${limits.maxEmailAttachments} attachments total`,
    ],
    [
      'OCR',
      limits.ocrEnabled
        ? `Enabled · up to ${limits.maxOcrPages} pages`
        : 'Disabled',
    ],
    [
      'Source image rendering',
      `${limits.visualPagesEnabled && limits.maxVisualPages > 0 && limits.maxVisualBytes > 0 ? 'Enabled' : 'Disabled'} · up to ${limits.maxVisualPages} pages / ${bytes(limits.maxVisualBytes)}`,
    ],
    ['Model calls', `Up to ${limits.maxModelCalls} per document`],
    ['Agent actions', `Up to ${limits.maxAgentSteps} planner steps`],
    ['Extraction attempts', `Up to ${limits.maxPageExtractions} per page`],
    [
      'Time',
      `${limits.decodeTimeoutSeconds}s decoding · ${limits.documentTimeoutSeconds}s total processing`,
    ],
    [
      'Context',
      limits.contextTokens === null
        ? 'Provider context limit not inspected'
        : `${count(limits.contextTokens)} tokens requested`,
    ],
    [
      'Output',
      limits.outputTokens === null
        ? 'Limit not inspected'
        : `Up to ${count(limits.outputTokens)} tokens requested per call`,
    ],
    [
      'Prompt',
      limits.maxPromptBytes === null
        ? 'Provider prompt limit not inspected'
        : `Up to ${bytes(limits.maxPromptBytes, true)} for system, source and schema`,
    ],
  ];
  return (
    <div className={styles.inspectionDetails}>
      <div>
        <h3>{imageStatus[vision.effective]}</h3>
        <p>
          {vision.basis === 'local_metadata'
            ? `Local runtime metadata reports image support as ${vision.advertised}.`
            : 'Provider capabilities were not queried. This adapter currently accepts text only.'}{' '}
          No image or generation request was made. Image extraction quality has
          not been tested by this check.
        </p>
      </div>
      <p>
        Inspected{' '}
        <time dateTime={inspection.checkedAt}>
          {new Date(inspection.checkedAt).toLocaleString('en-GB')}
        </time>
        . Inspect again after a model or deployment update. No model was
        downloaded.
      </p>
      <details className={styles.inspectionAdvanced}>
        <summary>
          Processor limits
          {inspection.execution === 'local' ? ' & observed model identity' : ''}
        </summary>
        <dl className={styles.inspectionLimits}>
          {values.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <p>
          These are processor ceilings. Shared budgets, eligible page selection
          and adapter limits can reduce coverage. Both execution styles use the
          same document tools and evidence checks.
        </p>
        {inspection.execution === 'local' && (
          <div>
            <h3>Observed model digest</h3>
            <p className={styles.digest}>
              {inspection.observedDigest ??
                'Unknown · no unique, valid digest was returned for this exact alias.'}
            </p>
            <p>
              Observed at inspection; not pinned to jobs. Replacing weights
              behind this alias can change later results.
            </p>
          </div>
        )}
      </details>
    </div>
  );
}
