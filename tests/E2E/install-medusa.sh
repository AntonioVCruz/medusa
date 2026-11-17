#!/usr/bin/env bash
set -euo pipefail

E2E_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "$E2E_DIR/../.." && pwd)"
STATE_DIR="$E2E_DIR/.runtime"
mkdir -p "$STATE_DIR"
umask 077

compose() {
  docker compose --project-name medusa-testrigor-e2e \
    --env-file "$STATE_DIR/environment.env" \
    --env-file "$STATE_DIR/image.env" \
    --file "$E2E_DIR/compose.yaml" "$@"
}

prepare() {
  if [[ ! -f "$STATE_DIR/environment.env" ]]; then
    command -v openssl >/dev/null
    {
      printf 'E2E_DATABASE_PASSWORD=%s\n' "$(openssl rand -hex 24)"
      printf 'E2E_ADMIN_EMAIL=admin@medusa-e2e.test\n'
      printf 'E2E_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
      printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)"
      printf 'COOKIE_SECRET=%s\n' "$(openssl rand -hex 32)"
    } > "$STATE_DIR/environment.env"
  fi
  node "$E2E_DIR/prepare-variables.mjs"
  local revision harness
  revision="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
  git -C "$SOURCE_DIR" diff --quiet HEAD -- packages integration-tests scripts \
    package.json yarn.lock .yarnrc.yml turbo.json _tsconfig.base.json .yarn
  harness="$(cd "$E2E_DIR" && { find app -type f -print0 | sort -z | xargs -0 sha256sum; \
    sha256sum Dockerfile Dockerfile.dockerignore compose.yaml install-medusa.sh prepare-variables.mjs; })"
  harness="$(printf '%s' "$harness" | sha256sum | cut -c1-12)"
  printf 'E2E_IMAGE=medusa-testrigor-e2e:%s-%s\n' "${revision:0:12}" "$harness" > "$STATE_DIR/image.env"
  printf '%s\n' "$revision" > "$STATE_DIR/source-revision"
}

ready() {
  for ((attempt=0; attempt<90; attempt++)); do
    if curl --fail --silent http://127.0.0.1:19000/health >/dev/null \
      && curl --fail --silent http://127.0.0.1:19000/app | grep -qi '<html'; then
      printf 'Backend and admin HTTP probes passed at http://127.0.0.1:19000/app\n'
      return
    fi
    sleep 2
  done
  compose logs --tail 100 app
  return 1
}

case "${1:-install}" in
  install)
    prepare
    # Read only the non-secret image name; credentials stay in the environment file.
    E2E_IMAGE="$(sed -n 's/^E2E_IMAGE=//p' "$STATE_DIR/image.env")"
    docker build --progress=plain --file "$E2E_DIR/Dockerfile" \
      --build-arg "MEDUSA_SOURCE_REVISION=$(cat "$STATE_DIR/source-revision")" \
      --build-arg "BUILD_CONCURRENCY=${E2E_BUILD_CONCURRENCY:-4}" \
      --tag "$E2E_IMAGE" "$SOURCE_DIR"
    compose up --detach --wait --wait-timeout 240
    ready
    # Double slash preserves the container path when invoked through Git Bash.
    compose exec -T app cat //source-revision
    ;;
  status) compose ps; ready ;;
  logs) compose logs --tail 100 ;;
  restart) compose restart app; ready ;;
  stop) compose stop ;;
  reset)
    [[ "${2:-}" == "--confirm-reset" ]] || {
      printf 'Reset clears this fixture database. Use reset --confirm-reset.\n' >&2
      exit 2
    }
    compose down --volumes
    # Generated credentials and source image survive; migration/bootstrap recreate the database.
    compose up --detach --wait --wait-timeout 240
    ready
    ;;
  *) printf 'Usage: %s {install|status|logs|restart|stop|reset --confirm-reset}\n' "$0" >&2; exit 2 ;;
esac
