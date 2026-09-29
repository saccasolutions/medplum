#!/usr/bin/env bash
# Build the Docker inputs for docker-compose.practiceai.yml from THIS fork's source, using the
# upstream Dockerfiles unchanged (Dockerfile at the repo root, packages/app/Dockerfile).
#
#   bash packages/practiceai/scripts/docker-build.sh            # build artifacts + tarballs, then `docker compose build`
#   bash packages/practiceai/scripts/docker-build.sh --no-docker   # only artifacts + tarballs (no daemon needed)
#
# The upstream Dockerfiles take NO build args. Their inputs are tarballs in the build context,
# produced here exactly like scripts/build-docker-server.sh / build-docker-app.sh (minus buildx push):
#   ./medplum-server-metadata.tar.gz   package.json + package-lock.json of the server workspaces
#   ./medplum-server-runtime.tar.gz    dist/ of core, definitions, fhir-router, ccda, server
#   ./packages/app/medplum-app.tar.gz  packages/app/dist built with __PLACEHOLDER__ values that
#                                      packages/app/docker-entrypoint.sh replaces at container start
#                                      (MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, GOOGLE_CLIENT_ID,
#                                      RECAPTCHA_SITE_KEY, MEDPLUM_REGISTER_ENABLED, MEDPLUM_AWS_TEXTRACT_ENABLED)
# All three are matched by the upstream .gitignore (*.tar.gz).
#
# Base images: the server Dockerfile uses Docker Hardened Images (dhi.io/node:24.18-dev and
# dhi.io/node:24.18), which require `docker login dhi.io` with a Docker account. The app image uses
# nginxinc/nginx-unprivileged:alpine. Platform: set DOCKER_DEFAULT_PLATFORM (e.g. linux/amd64).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"

NO_DOCKER=0
[[ "${1:-}" == "--no-docker" ]] && NO_DOCKER=1

log() { echo "[docker-build] $*" >&2; }

[[ -d node_modules ]] || { log "npm ci"; npm ci; }

log "building @medplum/server and its workspace dependencies"
npx turbo run build --filter=@medplum/server...

log "building @medplum/app's workspace dependencies (normal env, turbo cache)"
npx turbo run build --filter='@medplum/app^...'

# Only the app itself is built with the placeholders. (Upstream runs `turbo run build --force` with the
# placeholder env, but those vars are part of every build task's turbo hash, so that would also
# rebuild core/definitions in place: `rimraf dist` under a running dev server.)
log "building @medplum/app with runtime placeholders"
(
  export MEDPLUM_BASE_URL="__MEDPLUM_BASE_URL__"
  export MEDPLUM_CLIENT_ID="__MEDPLUM_CLIENT_ID__"
  export MEDPLUM_REGISTER_ENABLED="__MEDPLUM_REGISTER_ENABLED__"
  export MEDPLUM_AWS_TEXTRACT_ENABLED="__MEDPLUM_AWS_TEXTRACT_ENABLED__"
  export GOOGLE_CLIENT_ID="__GOOGLE_CLIENT_ID__"
  export RECAPTCHA_SITE_KEY="__RECAPTCHA_SITE_KEY__"
  npm run build -w @medplum/app
)

log "server tarballs (same file lists as scripts/build-docker-server.sh)"
tar --no-xattrs -czf medplum-server-metadata.tar.gz \
  package.json package-lock.json \
  packages/bot-layer/package.json packages/ccda/package.json packages/core/package.json \
  packages/definitions/package.json packages/fhir-router/package.json packages/server/package.json
tar --no-xattrs --exclude='*.ts' --exclude='*.tsbuildinfo' -czf medplum-server-runtime.tar.gz \
  LICENSE.txt NOTICE \
  packages/ccda/dist packages/core/dist packages/definitions/dist packages/fhir-router/dist packages/server/dist

log "app tarball (same as scripts/build-docker-app.sh)"
tar --no-xattrs -czf packages/app/medplum-app.tar.gz -C packages/app/dist .

ls -lh medplum-server-metadata.tar.gz medplum-server-runtime.tar.gz packages/app/medplum-app.tar.gz >&2

if [[ "$NO_DOCKER" == "1" ]]; then
  log "--no-docker: artifacts ready; build later with: docker compose -f docker-compose.practiceai.yml --profile stack build"
  exit 0
fi
docker compose -f docker-compose.practiceai.yml --profile stack build
