-- Only routing, counters and keyed identities are plaintext. Paths and names are encrypted.
CREATE TABLE app_folder_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES app_organizations(id),
 directory_key text NOT NULL CHECK(directory_key ~ '^[a-f0-9]{64}$'),
 connected_by text NOT NULL REFERENCES auth_user(id),
 config bytea NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','disconnected')),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 imported_count integer NOT NULL DEFAULT 0 CHECK(imported_count>=0),
 skipped_count integer NOT NULL DEFAULT 0 CHECK(skipped_count>=0),
 last_synced_at timestamptz,
 error_code text CHECK(error_code IN ('INTAKE_NOT_CONFIGURED','DIRECTORY_UNAVAILABLE','UNSAFE_PATH','SCAN_LIMIT','FILE_CHANGED','FILE_UNAVAILABLE','SYNC_FAILED','MEMBERSHIP_REVOKED')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,directory_key), UNIQUE(id,organization_id)
);
CREATE TABLE app_folder_queue (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_owner uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 FOREIGN KEY(id,organization_id) REFERENCES app_folder_connections(id,organization_id) ON DELETE CASCADE,
 CHECK((lease_owner IS NULL)=(lease_until IS NULL))
);
CREATE INDEX app_folder_queue_ready ON app_folder_queue(available_at,id);
CREATE TABLE app_folder_receipts (
 organization_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 receipt_key text NOT NULL CHECK(receipt_key ~ '^[a-f0-9]{64}$'),
 document_id uuid,
 payload bytea NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('imported','duplicate','invalid','oversize')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(connection_id,receipt_key),
 FOREIGN KEY(connection_id,organization_id) REFERENCES app_folder_connections(id,organization_id),
 FOREIGN KEY(document_id,organization_id) REFERENCES app_documents(id,organization_id)
);
CREATE INDEX app_folder_receipts_recent ON app_folder_receipts(organization_id,connection_id,created_at DESC,receipt_key);
CREATE INDEX app_folder_receipts_document ON app_folder_receipts(organization_id,document_id) WHERE document_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['app_folder_connections','app_folder_queue','app_folder_receipts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY organization_boundary ON %I USING (organization_id::text=current_setting(''app.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''app.organization_id'',true))',t);
 END LOOP;
 EXECUTE format('CREATE POLICY queue_routing_owner ON app_folder_queue TO %I USING (true) WITH CHECK (true)',current_user);
END $$;
CREATE FUNCTION claim_folder_connection(p_owner uuid,p_organizations uuid[] DEFAULT NULL)
RETURNS TABLE(id uuid,organization_id uuid,lease_owner uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_owner IS NULL OR (p_organizations IS NOT NULL AND (cardinality(p_organizations) NOT BETWEEN 1 AND 100 OR array_position(p_organizations,NULL) IS NOT NULL)) THEN
  RAISE EXCEPTION 'Invalid folder routing parameters' USING ERRCODE='22023';
 END IF;
 RETURN QUERY UPDATE public.app_folder_queue q
 SET lease_owner=p_owner,lease_until=clock_timestamp()+interval '90 seconds'
 WHERE q.id=(SELECT candidate.id FROM public.app_folder_queue candidate
  WHERE candidate.available_at<=clock_timestamp() AND (candidate.lease_until IS NULL OR candidate.lease_until<=clock_timestamp())
   AND (p_organizations IS NULL OR candidate.organization_id=ANY(p_organizations))
  ORDER BY candidate.available_at,candidate.id FOR UPDATE SKIP LOCKED LIMIT 1)
 RETURNING q.id,q.organization_id,q.lease_owner;
END $$;
REVOKE ALL ON FUNCTION claim_folder_connection(uuid,uuid[]) FROM PUBLIC;
