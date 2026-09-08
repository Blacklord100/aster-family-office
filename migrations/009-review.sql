ALTER TABLE app_jobs ADD COLUMN review_revision integer NOT NULL DEFAULT 0 CHECK(review_revision >= 0);
ALTER TABLE app_jobs ADD COLUMN review_state bytea;
CREATE UNIQUE INDEX app_jobs_id_organization_review ON app_jobs(id,organization_id);
CREATE TABLE app_review_versions (
 job_id uuid NOT NULL, organization_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision > 0),
 actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 payload bytea NOT NULL,
 PRIMARY KEY(job_id,revision),
 FOREIGN KEY(job_id,organization_id) REFERENCES app_jobs(id,organization_id)
);
ALTER TABLE app_review_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_review_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_boundary ON app_review_versions
 USING(organization_id::text=current_setting('app.organization_id',true))
 WITH CHECK(organization_id::text=current_setting('app.organization_id',true));
CREATE FUNCTION app_review_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Review history is append-only'; END;
$$;
CREATE TRIGGER app_review_versions_immutable BEFORE UPDATE OR DELETE ON app_review_versions
 FOR EACH ROW EXECUTE FUNCTION app_review_versions_immutable();
