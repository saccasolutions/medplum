#!/usr/bin/env bash
# Live end-to-end check of the billing app's MedplumFhirGateway against this fork's server
# (billing GAP-03). Synthetic data only.
#
#   bash packages/practiceai/scripts/billing-live-test.sh [--reuse] [extra vitest args]
#
# 1. Makes sure the dev server answers /healthcheck (starts it with dev-up.sh otherwise).
# 2. Makes sure a super admin ClientApplication exists (.run/dev-client.json, via smoke.ts).
# 3. Provisions a FRESH synthetic PT practice with scripts/provision-e2e.ts (new project per run;
#    --reuse keeps the practice in .run/e2e-practice.json) and writes the fixture (0600, gitignored).
# 4. Runs the billing repo's live suite: tests/medplum-live (vitest config inside that folder).
#
# Env: MEDPLUM_BASE_URL (default http://localhost:8103/), BILLING_DIR (default: ../billing next to
#      this repo), MEDPLUM_LIVE_STRICT=1 (run KNOWN-GAP tests as ordinary tests).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"
RUN_DIR="$PKG/.run"
BASE_URL="${MEDPLUM_BASE_URL:-http://localhost:8103/}"
BILLING_DIR="${BILLING_DIR:-$(cd "$REPO/.." && pwd)/billing}"
FIXTURE="$RUN_DIR/e2e-practice.json"

REUSE=0
if [[ "${1:-}" == "--reuse" ]]; then
  REUSE=1
  shift
fi

if [[ ! -f "$BILLING_DIR/src/lib/fhir/medplum-gateway.ts" ]]; then
  echo "billing repo not found at $BILLING_DIR (set BILLING_DIR)" >&2
  exit 2
fi

if ! curl -fsS "${BASE_URL%/}/healthcheck" >/dev/null 2>&1; then
  echo "[billing-live-test] server not answering at $BASE_URL; starting it with dev-up.sh"
  bash "$HERE/dev-up.sh"
fi
echo "[billing-live-test] healthcheck: $(curl -fsS "${BASE_URL%/}/healthcheck")"

cd "$REPO"
if [[ ! -f "$RUN_DIR/dev-client.json" && -z "${MEDPLUM_ADMIN_CLIENT_ID:-}" ]]; then
  echo "[billing-live-test] no super admin client yet; running smoke.ts"
  MEDPLUM_BASE_URL="$BASE_URL" npx tsx "$HERE/smoke.ts"
fi

PROVISION_ARGS=(--out "$FIXTURE")
if [[ "$REUSE" == "0" ]]; then
  PROVISION_ARGS+=(--fresh)
fi
MEDPLUM_BASE_URL="$BASE_URL" npx tsx "$HERE/provision-e2e.ts" "${PROVISION_ARGS[@]}"

cd "$BILLING_DIR"
echo "[billing-live-test] running $BILLING_DIR/tests/medplum-live"
MEDPLUM_LIVE_FIXTURE="$FIXTURE" VITE_CONFIG_NATIVE_IGNORE_WARNING=true \
  npx vitest run --config tests/medplum-live/vitest.config.ts "$@"
