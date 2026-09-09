/** Complete application-envelope manifest. Auth's own secret format is managed by Better Auth. */
type Row = Record<string, unknown>;
type EncryptedTable = {
  table: string;
  key: string[];
  tenant: boolean;
  fields: { name: string; context: (row: Row) => string }[];
  trigger?: string;
};
export const encryptedTables: EncryptedTable[] = [
  {
    table: 'app_workspace',
    key: ['organization_id'],
    tenant: true,
    fields: [
      {
        name: 'payload',
        context: (r) => `workspace:${String(r.organization_id)}`,
      },
    ],
  },
  {
    table: 'app_documents',
    key: ['id'],
    tenant: true,
    fields: [
      {
        name: 'payload',
        context: (r) => `document:${String(r.organization_id)}:${String(r.id)}`,
      },
    ],
  },
  {
    table: 'app_jobs',
    key: ['id'],
    tenant: true,
    trigger: 'job_engine_immutable',
    fields: [
      {
        name: 'result',
        context: (r) => `result:${String(r.organization_id)}:${String(r.id)}`,
      },
      {
        name: 'engine_config',
        context: (r) =>
          `job-engine:${String(r.organization_id)}:${String(r.id)}`,
      },
      {
        name: 'review_state',
        context: (r) => `review:${String(r.organization_id)}:${String(r.id)}`,
      },
    ],
  },
  {
    table: 'app_engine_revisions',
    key: ['profile_id', 'revision'],
    tenant: true,
    trigger: 'engine_revision_immutable',
    fields: [
      {
        name: 'payload',
        context: (r) =>
          `engine:${String(r.organization_id)}:${String(r.profile_id)}:${String(r.revision)}`,
      },
    ],
  },
  {
    table: 'app_review_versions',
    key: ['job_id', 'revision'],
    tenant: true,
    trigger: 'app_review_versions_immutable',
    fields: [
      {
        name: 'payload',
        context: (r) =>
          `review-version:${String(r.organization_id)}:${String(r.job_id)}:${String(r.revision)}`,
      },
    ],
  },
  {
    table: 'app_mailboxes',
    key: ['id'],
    tenant: true,
    fields: [
      {
        name: 'credentials',
        context: (r) =>
          `mailbox-credentials:${String(r.organization_id)}:${String(r.id)}`,
      },
      {
        name: 'cursor',
        context: (r) =>
          `mailbox-cursor:${String(r.organization_id)}:${String(r.id)}`,
      },
    ],
  },
  {
    table: 'app_folder_connections',
    key: ['id'],
    tenant: true,
    fields: [
      {
        name: 'config',
        context: (r) =>
          `folder-config:${String(r.organization_id)}:${String(r.id)}`,
      },
    ],
  },
  {
    table: 'app_folder_receipts',
    key: ['connection_id', 'receipt_key'],
    tenant: true,
    fields: [
      {
        name: 'payload',
        context: (r) =>
          `folder-receipt:${String(r.organization_id)}:${String(r.connection_id)}:${String(r.receipt_key)}`,
      },
    ],
  },
  {
    table: 'app_mailbox_oauth_states',
    key: ['state_hash'],
    tenant: true,
    fields: [
      {
        name: 'payload',
        context: (r) =>
          `mailbox-state:${String(r.organization_id)}:${String(r.state_hash)}`,
      },
    ],
  },
  {
    table: 'app_operational_settings',
    key: ['organization_id'],
    tenant: true,
    fields: [
      {
        name: 'payload',
        context: (r) => `operations:${String(r.organization_id)}`,
      },
    ],
  },
  {
    table: 'app_intelligence_documents',
    key: ['document_id'],
    tenant: true,
    fields: [
      {
        name: 'payload',
        context: (r) =>
          `intelligence-index:${String(r.organization_id)}:${String(r.document_id)}`,
      },
    ],
  },
  {
    table: 'app_delivery_outbox',
    key: ['id'],
    tenant: false,
    fields: [{ name: 'payload', context: (r) => `delivery:${String(r.id)}` }],
  },
];
