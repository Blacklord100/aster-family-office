-- Global operational metadata contains no office documents or financial records.
CREATE TABLE IF NOT EXISTS aster_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now());
ALTER TABLE aster_migrations ADD COLUMN IF NOT EXISTS checksum text;
ALTER TABLE aster_migrations ADD COLUMN IF NOT EXISTS checksum_adopted boolean NOT NULL DEFAULT false;
CREATE TABLE app_lifecycle_control (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), mode text NOT NULL DEFAULT 'open' CHECK(mode IN ('open','draining','maintenance')),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9007199254740991), active_release text NOT NULL DEFAULT 'legacy' CHECK(active_release ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
 schema_version integer NOT NULL DEFAULT 16 CHECK(schema_version>0), resumed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO app_lifecycle_control(id) VALUES(true);
CREATE TABLE app_lifecycle_operations (
 id uuid PRIMARY KEY, token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'), kind text NOT NULL CHECK(kind IN ('request','document','mailbox','folder','archive','reporting','delivery')),
 generation bigint NOT NULL, release_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL
);
CREATE INDEX app_lifecycle_operations_expiry ON app_lifecycle_operations(expires_at);
CREATE TABLE app_lifecycle_events (
 id uuid PRIMARY KEY, request_id uuid UNIQUE NOT NULL, command_hash text NOT NULL,
 action text NOT NULL, generation bigint NOT NULL, release_id text NOT NULL, mode text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON app_lifecycle_control,app_lifecycle_operations,app_lifecycle_events FROM PUBLIC;

CREATE FUNCTION aster_runtime_identity_valid(c public.app_lifecycle_control) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(nullif(current_setting('app.release_id',true),''),'legacy')=c.active_release
 AND coalesce(nullif(current_setting('app.writer_generation',true),''),'1')=c.generation::text
 AND c.schema_version BETWEEN coalesce(nullif(current_setting('app.schema_min',true),''),'16')::integer AND coalesce(nullif(current_setting('app.schema_max',true),''),'16')::integer
$$;
CREATE FUNCTION aster_admit_operation(p_id uuid,p_token_hash text,p_kind text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.app_lifecycle_control; BEGIN
 IF p_id IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' OR p_kind NOT IN ('request','document','mailbox','folder','archive','reporting','delivery') THEN RAISE EXCEPTION USING ERRCODE='P1600',MESSAGE='Invalid lifecycle admission'; END IF;
 PERFORM pg_advisory_xact_lock_shared(176334525);
 SELECT * INTO STRICT c FROM public.app_lifecycle_control WHERE id FOR SHARE;
 IF NOT public.aster_runtime_identity_valid(c) THEN RAISE EXCEPTION USING ERRCODE='P1602',MESSAGE='WRITER_FENCED'; END IF;
 IF c.mode<>'open' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(176334526);
 -- Expired admissions contain no audit or customer data; keep routing state bounded.
 DELETE FROM public.app_lifecycle_operations WHERE id IN (SELECT id FROM public.app_lifecycle_operations WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100);
 IF (SELECT count(*) FROM public.app_lifecycle_operations WHERE expires_at>clock_timestamp())>=1000 THEN RAISE EXCEPTION USING ERRCODE='P1603',MESSAGE='Lifecycle admission capacity'; END IF;
 INSERT INTO public.app_lifecycle_operations(id,token_hash,kind,generation,release_id,expires_at) VALUES(p_id,p_token_hash,p_kind,c.generation,c.active_release,clock_timestamp()+interval '90 seconds');
 RETURN true;
END $$;
CREATE FUNCTION aster_renew_operation(p_id uuid,p_token_hash text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.app_lifecycle_control; changed integer; BEGIN
 PERFORM pg_advisory_xact_lock_shared(176334525);
 SELECT * INTO STRICT c FROM public.app_lifecycle_control WHERE id FOR SHARE;
 IF c.mode='maintenance' OR NOT public.aster_runtime_identity_valid(c) THEN RETURN false; END IF;
 UPDATE public.app_lifecycle_operations SET expires_at=clock_timestamp()+interval '90 seconds' WHERE id=p_id AND token_hash=p_token_hash AND generation=c.generation AND release_id=c.active_release AND expires_at>clock_timestamp();
 GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $$;
CREATE FUNCTION aster_finish_operation(p_id uuid,p_token_hash text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.app_lifecycle_control; BEGIN
 PERFORM pg_advisory_xact_lock_shared(176334525);
 SELECT * INTO STRICT c FROM public.app_lifecycle_control WHERE id FOR SHARE;
 -- Sealed backups also preserve routing metadata. Expired rows are reclaimed after resume.
 IF c.mode='maintenance' OR NOT public.aster_runtime_identity_valid(c) THEN RETURN; END IF;
 DELETE FROM public.app_lifecycle_operations WHERE id=p_id AND token_hash=p_token_hash;
END $$;
CREATE FUNCTION aster_assert_operation() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.app_lifecycle_control; operation_id text; operation_token text; BEGIN
 PERFORM pg_advisory_xact_lock_shared(176334525);
 SELECT * INTO STRICT c FROM public.app_lifecycle_control WHERE id FOR SHARE;
 IF NOT public.aster_runtime_identity_valid(c) THEN RAISE EXCEPTION USING ERRCODE='P1602',MESSAGE='WRITER_FENCED'; END IF;
 IF c.mode='maintenance' THEN RAISE EXCEPTION USING ERRCODE='P1601',MESSAGE='MAINTENANCE_READ_ONLY'; END IF;
 operation_id:=nullif(current_setting('app.operation_id',true),'');
 operation_token:=nullif(current_setting('app.operation_token',true),'');
 IF operation_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.app_lifecycle_operations WHERE id=operation_id::uuid AND token_hash=encode(sha256(convert_to(operation_token,'UTF8')),'hex') AND generation=c.generation AND release_id=c.active_release AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='P1604',MESSAGE='OPERATION_EXPIRED'; END IF;
 ELSIF c.mode<>'open' THEN RAISE EXCEPTION USING ERRCODE='P1601',MESSAGE='MAINTENANCE_READ_ONLY';
 END IF;
 RETURN;
END $$;
CREATE FUNCTION aster_runtime_write_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner oid; BEGIN
 SELECT relowner INTO owner FROM pg_class WHERE oid=TG_RELID;
 IF pg_has_role(session_user,owner,'MEMBER') OR (SELECT rolsuper FROM pg_roles WHERE rolname=session_user) THEN RETURN NULL; END IF;
 PERFORM public.aster_assert_operation();
 RETURN NULL;
END $$;

DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'app\_%' ESCAPE '\' OR tablename LIKE 'auth\_%' ESCAPE '\') AND tablename NOT IN ('app_lifecycle_control','app_lifecycle_operations','app_lifecycle_events') LOOP
  EXECUTE format('CREATE TRIGGER aster_runtime_write_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION aster_runtime_write_guard()',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION aster_runtime_identity_valid(public.app_lifecycle_control),aster_admit_operation(uuid,text,text),aster_renew_operation(uuid,text),aster_finish_operation(uuid,text),aster_runtime_write_guard(),aster_assert_operation() FROM PUBLIC;

DO $$ DECLARE t text; r record; BEGIN
 FOREACH t IN ARRAY ARRAY['app_lifecycle_control','app_lifecycle_operations','app_lifecycle_events'] LOOP
  FOR r IN SELECT DISTINCT a.grantee,pg_get_userbyid(a.grantee) AS name FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('public.'||t)::regclass AND a.grantee<>c.relowner AND a.grantee<>0 LOOP
   EXECUTE format('REVOKE ALL ON %I FROM %I',t,r.name);
  END LOOP;
 END LOOP;
END $$;
