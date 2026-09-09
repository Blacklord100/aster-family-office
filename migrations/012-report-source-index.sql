-- Latest source review is selected across every processing state, including
-- accepted/rejected jobs excluded by the active-job uniqueness index.
CREATE INDEX app_jobs_org_document_latest_idx
 ON app_jobs(organization_id,document_id,created_at DESC,id DESC);
