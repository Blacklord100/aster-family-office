CREATE UNIQUE INDEX app_documents_tenant_identity ON app_documents(id,organization_id);
ALTER TABLE app_memberships ADD COLUMN data_scope jsonb;
ALTER TABLE app_memberships ADD CONSTRAINT scoped_members_are_viewers
 CHECK (data_scope IS NULL OR (role='viewer' AND jsonb_typeof(data_scope)='object'));
CREATE TABLE app_document_access (
 organization_id uuid NOT NULL REFERENCES app_organizations(id),
 document_id uuid NOT NULL,
 family_ids text[] NOT NULL CHECK(cardinality(family_ids)>0),
 entity_ids text[] NOT NULL DEFAULT '{}',
 reviewed_by text NOT NULL REFERENCES auth_user(id),
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,document_id),
 FOREIGN KEY(document_id,organization_id) REFERENCES app_documents(id,organization_id) ON DELETE CASCADE
);
CREATE TABLE app_operational_settings (
 organization_id uuid PRIMARY KEY REFERENCES app_organizations(id),
 payload bytea NOT NULL, revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_delivery_outbox (
 id uuid PRIMARY KEY, recipient_hash text NOT NULL, payload bytea NOT NULL,
 kind text NOT NULL CHECK(kind IN ('password_reset','invitation')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','expired')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, sent_at timestamptz, error_code text
);
CREATE INDEX app_delivery_ready ON app_delivery_outbox(available_at,lease_until) WHERE status IN ('pending','sending');
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['app_document_access','app_operational_settings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY organization_boundary ON %I USING (organization_id::text=current_setting(''app.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''app.organization_id'',true))',t);
 END LOOP;
END $$;
