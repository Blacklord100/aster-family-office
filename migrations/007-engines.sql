CREATE TABLE app_engine_profiles (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES app_organizations(id),
 current_revision integer NOT NULL DEFAULT 1 CHECK(current_revision>0),
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id)
);
CREATE TABLE app_engine_revisions (
 profile_id uuid NOT NULL, organization_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 payload bytea NOT NULL, tested_at timestamptz, test_ok boolean, test_error text,
 PRIMARY KEY(profile_id,revision), UNIQUE(profile_id,revision,organization_id),
 FOREIGN KEY(profile_id,organization_id) REFERENCES app_engine_profiles(id,organization_id)
);
CREATE TABLE app_engine_policy (
 organization_id uuid PRIMARY KEY REFERENCES app_organizations(id),
 profile_id uuid NOT NULL, revision integer NOT NULL, activated_at timestamptz NOT NULL DEFAULT now(),
 cloud_acknowledged_at timestamptz,
 FOREIGN KEY(profile_id,revision,organization_id) REFERENCES app_engine_revisions(profile_id,revision,organization_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['app_engine_profiles','app_engine_revisions','app_engine_policy'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY organization_boundary ON %I USING (organization_id::text=current_setting(''app.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''app.organization_id'',true))',t);
 END LOOP;
END $$;
CREATE FUNCTION preserve_engine_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
 OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.revision IS DISTINCT FROM OLD.revision THEN
  RAISE EXCEPTION 'Engine revision configuration is immutable';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER engine_revision_immutable BEFORE UPDATE ON app_engine_revisions FOR EACH ROW EXECUTE FUNCTION preserve_engine_revision();
ALTER TABLE app_jobs ADD COLUMN engine_snapshot jsonb, ADD COLUMN engine_config bytea;
ALTER TABLE app_jobs ADD COLUMN engine_legacy boolean NOT NULL DEFAULT true;
ALTER TABLE app_jobs ALTER COLUMN engine_legacy SET DEFAULT false;
ALTER TABLE app_jobs ADD CONSTRAINT new_job_engine_required CHECK(engine_legacy OR engine_snapshot IS NOT NULL);
ALTER TABLE app_jobs ADD CONSTRAINT engine_pin_pair CHECK((engine_snapshot IS NULL)=(engine_config IS NULL));
CREATE FUNCTION preserve_job_engine() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.engine_snapshot IS NOT NULL AND (NEW.engine_snapshot IS DISTINCT FROM OLD.engine_snapshot OR NEW.engine_config IS DISTINCT FROM OLD.engine_config) THEN
  RAISE EXCEPTION 'Job engine is immutable';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER job_engine_immutable BEFORE UPDATE ON app_jobs FOR EACH ROW EXECUTE FUNCTION preserve_job_engine();
DROP INDEX app_jobs_active_document_mode;
CREATE UNIQUE INDEX app_jobs_active_document_mode_engine ON app_jobs(organization_id,document_id,mode,COALESCE(engine_snapshot->>'profileId','deployment'),COALESCE(engine_snapshot->>'revision','0'),COALESCE(engine_snapshot->>'model','legacy')) WHERE status IN ('queued','processing','awaiting_review');
ALTER TABLE app_job_queue ADD COLUMN capacity_deferrals integer NOT NULL DEFAULT 0 CHECK(capacity_deferrals>=0);
