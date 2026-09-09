-- Routing metadata only. Report names, people, notes and evidence stay inside
-- the existing authenticated, tenant-bound app_workspace ciphertext.
CREATE TABLE app_report_obligations_queue (
 organization_id uuid PRIMARY KEY REFERENCES app_organizations(id) ON DELETE CASCADE,
 run_after timestamptz NOT NULL DEFAULT now(),
 lease_owner uuid,
 lease_until timestamptz,
 generation bigint NOT NULL DEFAULT 1 CHECK(generation > 0),
 error_code text CHECK(error_code IN ('RECONCILIATION_FAILED','WORKER_STOPPING')),
 CHECK((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE INDEX app_report_obligations_ready ON app_report_obligations_queue(run_after,organization_id);
ALTER TABLE app_report_obligations_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_report_obligations_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_boundary ON app_report_obligations_queue
 USING (organization_id::text=current_setting('app.organization_id',true))
 WITH CHECK (organization_id::text=current_setting('app.organization_id',true));

-- The migrator owns only a metadata routing exception, allowing the definer
-- functions below to work even when the migration role has NOBYPASSRLS.
DO $$ BEGIN
 EXECUTE format('CREATE POLICY queue_routing_owner ON app_report_obligations_queue TO %I USING (true) WITH CHECK (true)',current_user);
END $$;

CREATE FUNCTION claim_report_obligations(p_owner uuid,p_organizations uuid[] DEFAULT NULL)
RETURNS TABLE(organization_id uuid,generation bigint,lease_owner uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_owner IS NULL OR (p_organizations IS NOT NULL AND (cardinality(p_organizations) NOT BETWEEN 1 AND 100 OR array_position(p_organizations,NULL) IS NOT NULL)) THEN
  RAISE EXCEPTION 'Invalid report monitor routing parameters' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
 UPDATE public.app_report_obligations_queue q
 SET lease_owner=p_owner,lease_until=clock_timestamp()+interval '90 seconds'
 WHERE q.organization_id=(
  SELECT candidate.organization_id FROM public.app_report_obligations_queue candidate
  WHERE candidate.run_after<=clock_timestamp()
   AND (candidate.lease_until IS NULL OR candidate.lease_until<=clock_timestamp())
   AND (p_organizations IS NULL OR candidate.organization_id=ANY(p_organizations))
  ORDER BY candidate.run_after,candidate.organization_id
  FOR UPDATE SKIP LOCKED LIMIT 1
 )
 RETURNING q.organization_id,q.generation,q.lease_owner;
END $$;

CREATE FUNCTION finish_report_obligations(p_organization uuid,p_owner uuid,p_generation bigint,p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE affected integer;
BEGIN
 IF p_organization IS NULL OR p_owner IS NULL OR p_generation IS NULL OR p_generation<1
  OR (p_error IS NOT NULL AND p_error NOT IN ('RECONCILIATION_FAILED','WORKER_STOPPING')) THEN
  RAISE EXCEPTION 'Invalid report monitor completion parameters' USING ERRCODE='22023';
 END IF;
 UPDATE public.app_report_obligations_queue q
 SET run_after=CASE WHEN q.generation<>p_generation OR p_error='WORKER_STOPPING'
   THEN LEAST(q.run_after,clock_timestamp()) ELSE clock_timestamp()+interval '60 seconds' END,
  lease_owner=NULL,lease_until=NULL,error_code=p_error
 WHERE q.organization_id=p_organization AND q.lease_owner=p_owner AND q.lease_until>clock_timestamp();
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION claim_report_obligations(uuid,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_report_obligations(uuid,uuid,bigint,text) FROM PUBLIC;
