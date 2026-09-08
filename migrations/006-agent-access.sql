CREATE TABLE app_integration_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES app_organizations(id),
 created_by text NOT NULL REFERENCES auth_user(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 token_hash text NOT NULL UNIQUE,
 scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 3 AND scopes <@ ARRAY['portfolio:read','sources:read','mailboxes:read']::text[]),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 last_used_at timestamptz,
 revoked_at timestamptz
);
CREATE INDEX app_integration_tokens_org_created ON app_integration_tokens(organization_id,created_at DESC);
ALTER TABLE app_integration_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_integration_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_boundary ON app_integration_tokens
 USING (organization_id::text=current_setting('app.organization_id',true))
 WITH CHECK (organization_id::text=current_setting('app.organization_id',true));
