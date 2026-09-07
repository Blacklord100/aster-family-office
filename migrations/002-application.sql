CREATE TABLE app_organizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100),
 processing_mode text NOT NULL DEFAULT 'workflow' CHECK(processing_mode IN ('workflow','agentic')),
 policy_revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_memberships (
 organization_id uuid NOT NULL REFERENCES app_organizations(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('owner','admin','analyst','viewer')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,user_id)
);
CREATE INDEX app_memberships_user_idx ON app_memberships(user_id,organization_id);
CREATE TABLE app_workspace (
 organization_id uuid PRIMARY KEY REFERENCES app_organizations(id) ON DELETE CASCADE,
 payload bytea NOT NULL, revision integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES app_organizations(id),
 created_by text NOT NULL REFERENCES auth_user(id), filename text NOT NULL, mime_type text NOT NULL,
 content_hash text NOT NULL, byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
 payload bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,content_hash)
);
CREATE INDEX app_documents_org_created_idx ON app_documents(organization_id,created_at DESC);
CREATE TABLE app_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES app_organizations(id),
 document_id uuid NOT NULL REFERENCES app_documents(id), created_by text NOT NULL REFERENCES auth_user(id),
 mode text NOT NULL CHECK(mode IN ('workflow','agentic')), policy_revision integer NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','awaiting_review','accepted','failed','cancelled','rejected')),
 result bytea, error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 reviewed_by text REFERENCES auth_user(id), reviewed_at timestamptz
);
CREATE INDEX app_jobs_org_created_idx ON app_jobs(organization_id,created_at DESC);
CREATE TABLE app_job_queue (
 id uuid PRIMARY KEY REFERENCES app_jobs(id) ON DELETE CASCADE,
 organization_id uuid NOT NULL REFERENCES app_organizations(id), available_at timestamptz NOT NULL DEFAULT now(),
 lease_owner text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX app_job_queue_ready_idx ON app_job_queue(available_at,lease_until);
CREATE TABLE app_audit (
 sequence bigserial UNIQUE,
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES app_organizations(id),
 actor_id text NOT NULL, action text NOT NULL, resource_id text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}', previous_hash text NOT NULL, entry_hash text NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX app_audit_org_created_idx ON app_audit(organization_id,created_at DESC,id);
CREATE TABLE app_request_limits (
 key text PRIMARY KEY, count integer NOT NULL DEFAULT 0, resets_at timestamptz NOT NULL
);
CREATE TABLE app_accepted_facts (
 fingerprint text NOT NULL, organization_id uuid NOT NULL REFERENCES app_organizations(id),
 job_id uuid NOT NULL REFERENCES app_jobs(id), source_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,fingerprint)
);
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['app_workspace','app_documents','app_jobs','app_audit','app_accepted_facts']
 LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY organization_boundary ON %I USING (organization_id::text = current_setting(''app.organization_id'',true)) WITH CHECK (organization_id::text = current_setting(''app.organization_id'',true))',t);
 END LOOP;
END $$;
