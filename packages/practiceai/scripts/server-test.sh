#!/usr/bin/env bash
# Run packages/server vitest tests against the local medplum_test database.
#
#   bash packages/practiceai/scripts/server-test.sh src/fhir/accesspolicy.test.ts -t "Access policy restricting read"
#   bash packages/practiceai/scripts/server-test.sh --reseed src/fhir/accesspolicy.test.ts
#
# - Ensures Postgres/Redis are up and the medplum_test DB/roles exist (dev-up's service steps via init-db.sh).
# - The server test config (loadTestConfig in packages/server/src/config/loader.ts) uses db "medplum_test",
#   runMigrations=false and Redis logical DB 7, so tests do NOT touch the dev "medplum" DB the running server uses.
# - Because runMigrations=false, the test DB must first be migrated+seeded by `npm run test:seed`
#   (packages/server/src/seed.test.ts, ~90s). This script does that automatically when the "User" table is
#   missing, or always with --reseed.
# - Remaining args are passed to `vitest run` in packages/server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SERVER_DIR="${REPO_DIR}/packages/server"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-medplum}"
RUN_DIR="$(dirname "${SCRIPT_DIR}")/.run"
mkdir -p "${RUN_DIR}"

RESEED=0
if [ "${1:-}" = "--reseed" ]; then RESEED=1; shift; fi

log() { echo "[server-test] $*"; }

if [ "${MEDPLUM_SKIP_LOCAL_SERVICES:-0}" != "1" ]; then
  if command -v pg_lsclusters >/dev/null 2>&1; then
    status=$(pg_lsclusters --no-header 2>/dev/null | awk '$1=="16" && $2=="main" {print $4}')
    if [ "${status}" != "online" ]; then
      pg_ctlcluster 16 main start
      touch "${RUN_DIR}/postgres.started-by-dev-up"
    fi
  fi
  if ! redis-cli -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --no-auth-warning ping 2>/dev/null | grep -q PONG; then
    redis-server --port "${REDIS_PORT}" --requirepass "${REDIS_PASSWORD}" --daemonize yes \
      --pidfile "${RUN_DIR}/redis.pid" --logfile "${RUN_DIR}/redis.log" --dir "${RUN_DIR}" --save "" --appendonly no
    sleep 1
  fi
  "${SCRIPT_DIR}/init-db.sh"
fi

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
cd "${SERVER_DIR}"

seeded=$(PGPASSWORD=medplum psql -h localhost -U medplum -d medplum_test -Atc \
  "SELECT to_regclass('public.\"User\"') IS NOT NULL" 2>/dev/null || echo f)
if [ "${RESEED}" = "1" ] || [ "${seeded}" != "t" ]; then
  log "migrating + seeding medplum_test (npm run test:seed)"
  npm run test:seed
fi

if [ "$#" -eq 0 ]; then
  log "no test args given; running src/fhir/accesspolicy.test.ts"
  set -- src/fhir/accesspolicy.test.ts
fi
exec npx vitest run "$@"
