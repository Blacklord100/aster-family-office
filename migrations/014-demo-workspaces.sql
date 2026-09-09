-- Only the provisioning service marks an isolated synthetic demonstration office.
-- Ordinary offices and imported files can never opt into automated demo review.
ALTER TABLE app_organizations
 ADD COLUMN demo_owner_user_id text REFERENCES auth_user(id),
 ADD COLUMN demo_source_directory text,
 ADD CONSTRAINT app_demo_marker CHECK (
   (demo_owner_user_id IS NULL AND demo_source_directory IS NULL) OR
   (demo_owner_user_id IS NOT NULL AND demo_source_directory='Demo mails')
 );
CREATE INDEX app_organizations_demo_owner ON app_organizations(demo_owner_user_id,created_at DESC)
 WHERE demo_owner_user_id IS NOT NULL;
