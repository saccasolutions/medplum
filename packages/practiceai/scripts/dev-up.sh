#!/usr/bin/env bash
# Start the local Medplum dev stack from this fork's source (idempotent):
#   1. Postgres 16 cluster "main" (pg_ctlcluster) on :5432
#   2. Redis on :6379 with password "medplum"
#   3. medplum / medplum_test databases (scripts/init-db.sh)
#   4. Medplum server (packages/server) on :8103
# PIDs and logs go to packages/practiceai/.run/ (gitignored).
#
# Env overrides:
#   MEDPLUM_SERVER_MODE=dist|dev   dist (default): node dist/index.js (built via turbo if missing)
#                                  dev: tsx src/index.ts (no watch; still needs deps built)
#   MEDPLUM_BUILD=1                force `turbo run build --filter=@medplum/server...` first
#   MEDPLUM_CONFIG=<name>          server config (default file:medplum.config.json, relative to packages/server)
#   MEDPLUM_SKIP_LOCAL_SERVICES=1  don't start host Postgres/Redis or run init-db (use docker-compose.practiceai.yml)
#   MEDPLUM_HEALTH_TIMEOUT=<sec>   how long to wait for /healthcheck (default 900; first boot runs migrations)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "${SCRIPT_DIR}")"
REPO_DIR="$(cd "${PKG_DIR}/../.." && pwd)"
SERVER_DIR="${REPO_DIR}/packages/server"
RUN_DIR="${PKG_DIR}/.run"
mkdir -p "${RUN_DIR}"

MODE="${MEDPLUM_SERVER_MODE:-dist}"
CONFIG="${MEDPLUM_CONFIG:-file:medplum.config.json}"
PORT="${MEDPLUM_PORT:-8103}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-medplum}"
HEALTH_TIMEOUT="${MEDPLUM_HEALTH_TIMEOUT:-900}"

log() { echo "[dev-up] $*"; }
pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# ---------- Postgres ----------
if [ "${MEDPLUM_SKIP_LOCAL_SERVICES:-0}" = "1" ]; then
  log "MEDPLUM_SKIP_LOCAL_SERVICES=1: not starting host Postgres/Redis (e.g. docker-compose.practiceai.yml)"
elif command -v pg_lsclusters >/dev/null 2>&1; then
  status=$(pg_lsclusters --no-header 2>/dev/null | awk '$1=="16" && $2=="main" {print $4}')
  if [ "${status}" != "online" ]; then
    log "starting Postgres 16/main"
    pg_ctlcluster 16 main start
    touch "${RUN_DIR}/postgres.started-by-dev-up"
  else
    log "Postgres 16/main already online"
  fi
else
  log "pg_lsclusters not found; assuming Postgres is reachable on localhost:5432"
fi
for _ in $(seq 1 30); do pg_isready -q -h localhost -p 5432 && break; sleep 1; done
pg_isready -q -h localhost -p 5432 || { log "Postgres not ready"; exit 1; }

# ---------- Redis ----------
if [ "${MEDPLUM_SKIP_LOCAL_SERVICES:-0}" = "1" ]; then
  :
elif redis-cli -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --no-auth-warning ping 2>/dev/null | grep -q PONG; then
  log "Redis already running on :${REDIS_PORT}"
else
  log "starting Redis on :${REDIS_PORT}"
  redis-server --port "${REDIS_PORT}" --requirepass "${REDIS_PASSWORD}" --daemonize yes \
    --pidfile "${RUN_DIR}/redis.pid" --logfile "${RUN_DIR}/redis.log" --dir "${RUN_DIR}" \
    --save "" --appendonly no
  for _ in $(seq 1 20); do
    redis-cli -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --no-auth-warning ping 2>/dev/null | grep -q PONG && break
    sleep 0.5
  done
  redis-cli -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --no-auth-warning ping | grep -q PONG || { log "Redis failed"; exit 1; }
fi

# ---------- Databases ----------
if [ "${MEDPLUM_SKIP_LOCAL_SERVICES:-0}" != "1" ]; then
  "${SCRIPT_DIR}/init-db.sh"
fi

# ---------- Medplum server ----------
health() { curl -fsS "http://localhost:${PORT}/healthcheck" 2>/dev/null; }

if pid_alive "${RUN_DIR}/server.pid" && health >/dev/null; then
  log "Medplum server already running (pid $(cat "${RUN_DIR}/server.pid")) on :${PORT}"
  exit 0
fi
if health >/dev/null; then
  log "something else is already serving :${PORT}/healthcheck (not started by dev-up); leaving it alone"
  exit 0
fi
rm -f "${RUN_DIR}/server.pid"

if [ ! -d "${REPO_DIR}/node_modules" ]; then
  log "installing dependencies (npm ci)"
  (cd "${REPO_DIR}" && npm ci --no-audit --no-fund)
fi

need_build=0
[ "${MEDPLUM_BUILD:-0}" = "1" ] && need_build=1
[ -f "${REPO_DIR}/packages/core/dist/cjs/index.cjs" ] || need_build=1
[ -d "${REPO_DIR}/packages/definitions/dist" ] || need_build=1
if [ "${MODE}" = "dist" ] && [ ! -f "${SERVER_DIR}/dist/index.js" ]; then need_build=1; fi
if [ "${need_build}" = "1" ]; then
  log "building @medplum/server and its workspace dependencies"
  (cd "${REPO_DIR}" && npx turbo run build --filter=@medplum/server...)
fi

cd "${SERVER_DIR}"
case "${MODE}" in
  dist)
    CMD=(node --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import ./dist/otel/instrumentation.js dist/index.js "${CONFIG}")
    ;;
  dev)
    CMD=("${REPO_DIR}/node_modules/.bin/tsx" --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import ./src/otel/instrumentation.ts src/index.ts "${CONFIG}")
    ;;
  *) log "unknown MEDPLUM_SERVER_MODE=${MODE}"; exit 1 ;;
esac

log "starting Medplum server (${MODE}) -> ${RUN_DIR}/server.log"
# setsid: own process group so dev-down can stop the whole tree by PGID.
setsid nohup "${CMD[@]}" >>"${RUN_DIR}/server.log" 2>&1 < /dev/null &
echo $! > "${RUN_DIR}/server.pid"
log "server pid $(cat "${RUN_DIR}/server.pid")"

deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
until health >/dev/null; do
  if ! pid_alive "${RUN_DIR}/server.pid"; then
    log "server exited; last log lines:"; tail -40 "${RUN_DIR}/server.log"; rm -f "${RUN_DIR}/server.pid"; exit 1
  fi
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    log "timed out waiting for healthcheck (server still running; see ${RUN_DIR}/server.log)"; exit 1
  fi
  sleep 2
done
log "healthy: $(health)"
