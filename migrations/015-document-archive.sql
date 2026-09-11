CREATE TABLE app_archive_destinations (
 organization_id uuid PRIMARY KEY REFERENCES app_organizations(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision>0), archive_revision integer NOT NULL CHECK(archive_revision>0),
 enabled boolean NOT NULL DEFAULT false, config bytea NOT NULL,
 configured_by text NOT NULL REFERENCES auth_user(id),
 automatic_from timestamptz NOT NULL DEFAULT clock_timestamp(), include_existing boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app_archive_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES app_archive_destinations(organization_id) ON DELETE CASCADE,
 document_id uuid NOT NULL, source_document_id uuid, destination_revision integer NOT NULL CHECK(destination_revision>0),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','archived','failed')),
 metadata bytea, receipt bytea, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z_]{1,60}$'),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_owner uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(source_document_id,organization_id) REFERENCES app_documents(id,organization_id) ON DELETE SET NULL (source_document_id),
 CHECK(source_document_id IS NULL OR source_document_id=document_id),
 UNIQUE(organization_id,document_id,destination_revision),
 CHECK((lease_owner IS NULL)=(lease_until IS NULL)),
 CHECK(status<>'archived' OR receipt IS NOT NULL)
);
CREATE INDEX app_archive_jobs_ready ON app_archive_jobs(available_at,id) WHERE status IN ('queued','running');
CREATE INDEX app_archive_jobs_document ON app_archive_jobs(organization_id,document_id,created_at DESC);
CREATE TABLE app_archive_commands (
 organization_id uuid NOT NULL REFERENCES app_archive_destinations(organization_id) ON DELETE CASCADE,
 idempotency_key uuid NOT NULL, command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),
 result bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,idempotency_key)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['app_archive_destinations','app_archive_jobs','app_archive_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY organization_boundary ON %I USING (organization_id::text=current_setting(''app.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''app.organization_id'',true))',t);
 END LOOP;
 -- Routing functions expose only UUIDs, never paths, source bytes or archive metadata.
 EXECUTE format('CREATE POLICY archive_routing_owner ON app_archive_destinations TO %I USING (true)',current_user);
 EXECUTE format('CREATE POLICY archive_routing_owner ON app_archive_jobs TO %I USING (true) WITH CHECK (true)',current_user);
END $$;
CREATE FUNCTION archive_destinations_for_poll(p_after uuid DEFAULT NULL,p_organizations uuid[] DEFAULT NULL)
 RETURNS TABLE(organization_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_organizations IS NOT NULL AND (cardinality(p_organizations) NOT BETWEEN 1 AND 100 OR array_position(p_organizations,NULL) IS NOT NULL) THEN RAISE EXCEPTION 'Invalid organization routing'; END IF;
 RETURN QUERY SELECT d.organization_id FROM public.app_archive_destinations d WHERE d.enabled AND (p_after IS NULL OR d.organization_id>p_after) AND (p_organizations IS NULL OR d.organization_id=ANY(p_organizations)) ORDER BY d.organization_id LIMIT 100;
END $$;
CREATE FUNCTION claim_archive_job(p_owner uuid,p_organizations uuid[] DEFAULT NULL)
 RETURNS TABLE(id uuid,organization_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_owner IS NULL OR (p_organizations IS NOT NULL AND (cardinality(p_organizations) NOT BETWEEN 1 AND 100 OR array_position(p_organizations,NULL) IS NOT NULL)) THEN RAISE EXCEPTION 'Invalid archive routing'; END IF;
 RETURN QUERY UPDATE public.app_archive_jobs j SET status='running',lease_owner=p_owner,lease_until=clock_timestamp()+interval '90 seconds',attempts=j.attempts+1,updated_at=clock_timestamp()
 WHERE j.id=(SELECT q.id FROM public.app_archive_jobs q JOIN public.app_archive_destinations d ON d.organization_id=q.organization_id
 WHERE d.enabled AND q.destination_revision=d.archive_revision AND q.status IN ('queued','running') AND q.available_at<=clock_timestamp() AND (q.lease_until IS NULL OR q.lease_until<clock_timestamp()) AND (p_organizations IS NULL OR q.organization_id=ANY(p_organizations)) ORDER BY q.available_at,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 1)
 RETURNING j.id,j.organization_id;
END $$;
REVOKE ALL ON FUNCTION archive_destinations_for_poll(uuid,uuid[]),claim_archive_job(uuid,uuid[]) FROM PUBLIC;
