#!/usr/bin/env bash
set -euo pipefail
node /source/packages/cli/medusa-cli/cli.js db:migrate
node /source/packages/cli/medusa-cli/cli.js exec ./src/scripts/bootstrap.js
exec node /source/packages/cli/medusa-cli/cli.js start
