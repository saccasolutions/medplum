#!/usr/bin/env bash
# Idempotently create the Postgres role and databases expected by
# packages/server/medplum.config.json (dev) and packages/server/test.config.json (tests).
# Mirrors postgres/init_test.sql + the docker-compose POSTGRES_USER setup, but without
# making "medplum" a superuser: extensions are pre-created by the postgres superuser.
set -euo pipefail

PSQL=(env PGOPTIONS=--client-min-messages=warning psql -v ON_ERROR_STOP=1 -X -q)
run_psql() {
  if [ "$(id -u)" = "0" ]; then su postgres -c "$(printf '%q ' "${PSQL[@]}" "$@")"; else "${PSQL[@]}" "$@"; fi
}

run_psql -d postgres <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medplum') THEN
    CREATE ROLE medplum LOGIN PASSWORD 'medplum';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medplum_test_readonly') THEN
    CREATE ROLE medplum_test_readonly LOGIN PASSWORD 'medplum_test_readonly';
  END IF;
END $$;
SQL

for db in medplum medplum_test; do
  exists=$(run_psql -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '${db}'")
  if [ "${exists}" != "1" ]; then
    run_psql -d postgres -c "CREATE DATABASE ${db} OWNER medplum"
  fi
  run_psql -d "${db}" <<SQL
GRANT ALL PRIVILEGES ON DATABASE ${db} TO medplum;
ALTER SCHEMA public OWNER TO medplum;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgstattuple;
CREATE EXTENSION IF NOT EXISTS unaccent;
SQL
done

run_psql -d medplum_test <<'SQL'
GRANT CONNECT ON DATABASE medplum_test TO medplum_test_readonly;
GRANT USAGE ON SCHEMA public TO medplum_test_readonly;
GRANT pg_read_all_data TO medplum_test_readonly;
SQL

echo "[init-db] medplum / medplum_test databases ready"
