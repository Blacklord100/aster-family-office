ALTER TABLE auth_invitation ADD CONSTRAINT invitation_organization_fk FOREIGN KEY (organization_id) REFERENCES app_organizations(id);
CREATE UNIQUE INDEX app_jobs_active_document_mode ON app_jobs(organization_id,document_id,mode) WHERE status IN ('queued','processing','awaiting_review');
