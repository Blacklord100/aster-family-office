-- Decoded text is as sensitive as the original: authenticated ciphertext only.
CREATE TABLE app_intelligence_documents (
 document_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES app_organizations(id),
 payload bytea NOT NULL,
 indexed_at timestamptz NOT NULL DEFAULT now(),
 page_count integer NOT NULL CHECK(page_count BETWEEN 1 AND 40),
 FOREIGN KEY(document_id,organization_id) REFERENCES app_documents(id,organization_id)
);
ALTER TABLE app_intelligence_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_intelligence_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_boundary ON app_intelligence_documents
 USING (organization_id::text=current_setting('app.organization_id',true))
 WITH CHECK (organization_id::text=current_setting('app.organization_id',true));
CREATE INDEX intelligence_documents_org ON app_intelligence_documents(organization_id,indexed_at DESC);
