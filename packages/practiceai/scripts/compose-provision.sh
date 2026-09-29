#!/usr/bin/env bash
# Entry point of the one-shot `practiceai-provision` service in docker-compose.practiceai.yml.
# Runs inside a node image that holds packages/practiceai/{scripts,src} at /opt/practiceai.
#
# 1. Waits for the Medplum server /healthcheck.
# 2. Creates a super admin ClientApplication once (scripts/smoke.ts: password login as the seeded
#    dev super admin; credentials kept in /opt/practiceai/.run, a named volume).
# 3. Provisions (idempotently) the synthetic PT practice for PRACTICEAI_ORG_ID with
#    scripts/provision-e2e.ts and writes MEDPLUM_PROJECTS to $PRACTICEAI_SHARED_DIR/medplum-projects.env,
#    which the billing service sources at start.
#
# Env: MEDPLUM_BASE_URL (internal URL, e.g. http://medplum-server:8103/), MEDPLUM_GATEWAY_BASE_URL
#      (baseUrl written into MEDPLUM_PROJECTS; default MEDPLUM_BASE_URL), PRACTICEAI_ORG_ID,
#      PRACTICEAI_PRACTICE_NAME, MEDPLUM_ADMIN_EMAIL / MEDPLUM_ADMIN_PASSWORD (seeded dev super admin),
#      PRACTICEAI_SHARED_DIR (default /shared). Synthetic data only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${MEDPLUM_BASE_URL:?MEDPLUM_BASE_URL is required}"
SHARED="${PRACTICEAI_SHARED_DIR:-/shared}"
ORG_ID="${PRACTICEAI_ORG_ID:-d0000000-0000-4000-8000-00000000d001}"
TIMEOUT="${MEDPLUM_HEALTH_TIMEOUT:-300}"

log() { echo "[compose-provision] $*" >&2; }

log "waiting for ${BASE_URL%/}/healthcheck (up to ${TIMEOUT}s)"
deadline=$(( $(date +%s) + TIMEOUT ))
until node -e "fetch(process.argv[1]).then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))" "${BASE_URL%/}/healthcheck"; do
  if (( $(date +%s) > deadline )); then
    log "server did not become healthy"
    exit 1
  fi
  sleep 3
done

cd "$HERE/.."
if [[ ! -f .run/dev-client.json && -z "${MEDPLUM_ADMIN_CLIENT_ID:-}" ]]; then
  log "creating the super admin ClientApplication (smoke.ts)"
  npx tsx scripts/smoke.ts >&2
fi

mkdir -p "$SHARED"
npx tsx scripts/provision-e2e.ts \
  --org "$ORG_ID" \
  --name "${PRACTICEAI_PRACTICE_NAME:-Example Test PT Clinic}" \
  --out .run/e2e-practice.json \
  --env-out "$SHARED/medplum-projects.env" \
  ${MEDPLUM_GATEWAY_BASE_URL:+--gateway-base-url "$MEDPLUM_GATEWAY_BASE_URL"}
log "done: MEDPLUM_PROJECTS for organization $ORG_ID written to $SHARED/medplum-projects.env"
