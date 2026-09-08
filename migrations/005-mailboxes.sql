CREATE TABLE app_mailboxes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES app_organizations(id),
 provider text NOT NULL CHECK(provider IN ('gmail','microsoft')), provider_account_id text NOT NULL,
 email text NOT NULL, display_name text NOT NULL, connected_by text NOT NULL REFERENCES auth_user(id),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','disconnected','reauth_required','error')),
 history_days integer CHECK(history_days IN (30,90,365)), credentials bytea, cursor bytea,
 generation integer NOT NULL DEFAULT 1, imported_count integer NOT NULL DEFAULT 0, skipped_count integer NOT NULL DEFAULT 0,
 last_synced_at timestamptz, error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,provider,provider_account_id), UNIQUE(id,organization_id)
);
CREATE TABLE app_mailbox_queue (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, available_at timestamptz NOT NULL DEFAULT now(),
 lease_owner text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 FOREIGN KEY(id,organization_id) REFERENCES app_mailboxes(id,organization_id) ON DELETE CASCADE
);
CREATE INDEX app_mailbox_queue_ready ON app_mailbox_queue(available_at,lease_until);
CREATE TABLE app_mailbox_receipts (
 organization_id uuid NOT NULL, mailbox_id uuid NOT NULL, message_id text NOT NULL,
 document_id uuid REFERENCES app_documents(id), outcome text NOT NULL CHECK(outcome IN ('imported','oversize','missing','invalid')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(mailbox_id,message_id),
 FOREIGN KEY(mailbox_id,organization_id) REFERENCES app_mailboxes(id,organization_id)
);
CREATE TABLE app_mailbox_oauth_states (
 state_hash text PRIMARY KEY, organization_id uuid NOT NULL REFERENCES app_organizations(id), user_id text NOT NULL REFERENCES auth_user(id),
 session_id text NOT NULL REFERENCES auth_session(id) ON DELETE CASCADE, provider text NOT NULL CHECK(provider IN ('gmail','microsoft')),
 payload bytea NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE INDEX app_mailbox_states_expiry ON app_mailbox_oauth_states(expires_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['app_mailboxes','app_mailbox_receipts','app_mailbox_oauth_states'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY organization_boundary ON %I USING (organization_id::text=current_setting(''app.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''app.organization_id'',true))',t);
 END LOOP;
END $$;
