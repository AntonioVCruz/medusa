#!/usr/bin/env bash
# One synchronous CLI run; cloud and fixture credentials stay in the environment.
set -euo pipefail
: "${TESTRIGOR_API_KEY:?Provide the CI token}"
: "${TESTRIGOR_SUITE_ID:?Provide the suite ID}"
: "${MEDUSA_E2E_URL:?Probe the exact browser URL first}"
mode=${1:?Choose login or full}
name=${2:?Provide an evidence name}
[[ "$name" =~ ^[a-z0-9-]+$ ]] || exit 2
raw=tests/E2E/.runtime/ci-raw
case "$mode" in
  login) label=medusa-admin-smoke; report="$raw/junit-$name.xml" ;;
  full) label=medusa-admin-e2e; report="$raw/junit.xml" ;;
  *) exit 2 ;;
esac
export MEDUSA_E2E_PROBE_NAME="admin-$name"
python3 tests/E2E/ci-support.py admin-probe
testrigor test-suite run "$TESTRIGOR_SUITE_ID" \
  --localhost --verbose --url "$MEDUSA_E2E_URL" \
  --test-cases-path 'tests/E2E/test-cases/**/*.yaml' \
  --rules-path 'tests/E2E/rules/**/*.yaml' \
  --variables-path tests/E2E/.runtime/variables.json \
  --settings-path tests/E2E/settings.json \
  --labels "$label" \
  --branch "$HARNESS_BRANCH" --commit "$HARNESS_COMMIT" \
  --junit-report-save-path "$report" \
  > "$raw/cli-$name.log" 2>&1
if [[ "$mode" == full ]]; then
  python3 tests/E2E/ci-support.py result
else
  MEDUSA_E2E_LOGIN_REPORT="$report" python3 tests/E2E/ci-support.py login-result
fi
