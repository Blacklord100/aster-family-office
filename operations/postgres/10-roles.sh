#!/bin/sh
# Runs only on first PostgreSQL initialization. Never uses passwords in argv.
set -eu
ASTER_MIGRATION_PASSWORD="$(cat /run/secrets/migration_password)"
ASTER_RUNTIME_PASSWORD="$(cat /run/secrets/runtime_password)"
export ASTER_MIGRATION_PASSWORD ASTER_RUNTIME_PASSWORD
psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname aster <<'SQL'
\getenv migration_password ASTER_MIGRATION_PASSWORD
\getenv runtime_password ASTER_RUNTIME_PASSWORD
CREATE ROLE aster_migrator LOGIN PASSWORD :'migration_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE aster_runtime LOGIN PASSWORD :'runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER DATABASE aster OWNER TO aster_migrator;
REVOKE ALL ON DATABASE aster FROM PUBLIC;
GRANT CONNECT ON DATABASE aster TO aster_migrator, aster_runtime;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO aster_migrator;
GRANT USAGE ON SCHEMA public TO aster_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE aster_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aster_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE aster_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO aster_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE aster_migrator IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER ROLE aster_runtime SET statement_timeout = '30s';
ALTER ROLE aster_runtime SET idle_in_transaction_session_timeout = '30s';
SQL
unset ASTER_MIGRATION_PASSWORD ASTER_RUNTIME_PASSWORD
