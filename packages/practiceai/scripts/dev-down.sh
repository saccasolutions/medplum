#!/usr/bin/env bash
# Stop what scripts/dev-up.sh started (by PID file only; never by pattern).
#   - Medplum server (process group from .run/server.pid)
#   - Redis, only if dev-up started it (.run/redis.pid)
#   - Postgres, only with --all AND only if dev-up started it (Postgres may be shared)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$(dirname "${SCRIPT_DIR}")/.run"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-medplum}"
STOP_ALL=0
[ "${1:-}" = "--all" ] && STOP_ALL=1

log() { echo "[dev-down] $*"; }

stop_pidfile() {
  local name="$1" file="$2" pid
  if [ ! -f "${file}" ]; then log "${name}: no pid file"; return 0; fi
  pid="$(cat "${file}")"
  if ! kill -0 "${pid}" 2>/dev/null; then log "${name}: pid ${pid} not running"; rm -f "${file}"; return 0; fi
  log "${name}: stopping pid ${pid}"
  # server runs in its own session/process group (setsid) -> signal the group
  if [ "$(ps -o pgid= -p "${pid}" | tr -d ' ')" = "${pid}" ]; then kill -TERM -- "-${pid}" 2>/dev/null || true
  else kill -TERM "${pid}" 2>/dev/null || true; fi
  for _ in $(seq 1 40); do kill -0 "${pid}" 2>/dev/null || break; sleep 1; done
  if kill -0 "${pid}" 2>/dev/null; then
    log "${name}: still alive, sending SIGKILL"
    kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
  fi
  rm -f "${file}"
}

stop_pidfile "medplum-server" "${RUN_DIR}/server.pid"

if [ -f "${RUN_DIR}/redis.pid" ]; then
  rpid="$(cat "${RUN_DIR}/redis.pid")"
  log "redis: stopping pid ${rpid}"
  # graceful shutdown (redis removes its own pidfile); fall back to the pid if it is still alive
  redis-cli -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --no-auth-warning shutdown nosave >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do kill -0 "${rpid}" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "${rpid}" 2>/dev/null; then echo "${rpid}" > "${RUN_DIR}/redis.pid"; stop_pidfile "redis" "${RUN_DIR}/redis.pid"; fi
  rm -f "${RUN_DIR}/redis.pid"
else
  log "redis: not started by dev-up; leaving it"
fi

if [ "${STOP_ALL}" = "1" ]; then
  if [ -f "${RUN_DIR}/postgres.started-by-dev-up" ]; then
    log "postgres: stopping 16/main"
    pg_ctlcluster 16 main stop || true
    rm -f "${RUN_DIR}/postgres.started-by-dev-up"
  else
    log "postgres: not started by dev-up; leaving it"
  fi
fi
log "done"
