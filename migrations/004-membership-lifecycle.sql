ALTER TABLE app_memberships ADD COLUMN revoked_at timestamptz;
CREATE INDEX app_memberships_active_user_idx ON app_memberships(user_id,organization_id) WHERE revoked_at IS NULL;
