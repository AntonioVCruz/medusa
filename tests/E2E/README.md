# Medusa Admin browser smoke

This work continues the admin-login case in
[amandassa-tR/medusa](https://github.com/amandassa-tR/medusa/tree/bd9605e1115396f7a0c0d0081e9d58fbae7a1fda/testRigor).
It adds an assertion for the empty product list after authentication. The fixture
builds this repository's workspace packages and runs a separate application using
those packages. It does not install a released Medusa backend.

The three cases passed strict testRigor syntax validation and five consecutive
full-suite CLI runs against source `01de0be27a` through a dedicated VM HTTPS
endpoint. The earlier localhost tunnel failed before Medusa rendered. Tunnel
connectivity and hosted CI remain unverified. This directory is a development draft.

Local source/fixture builds, HTTP readiness, authenticated product-list access,
repeat installation, restart and reset passed on source `cdf21efc07`. A disposable
product survived install/restart and was cleared by reset; generated credentials
survived all three operations. These are infrastructure/API results, not rendered
browser results.

After syncing the working branch to `01de0be27a`, the fixture was rebuilt with
Medusa 2.22.7 and both default plugins (`draft-order` and `cloud`). The build,
startup migrations, HTTP readiness and authenticated empty product-list checks
passed with the existing database and unchanged generated credentials. Repeat
installation, restart and reset evidence above applies to the earlier source;
those lifecycle checks have not been repeated on the updated revision.

The same source also built on a separate Linux VM and passed fresh-database
startup, HTTP readiness and authenticated empty product-list checks. Five
consecutive cloud browser login/product-list smoke runs then passed against
that VM through a dedicated HTTPS endpoint with certificate verification.
This establishes only the original smoke journey on that pinned environment.
The testRigor tunnel registered there, but requests through its proxy port
timed out; direct HTTPS bypasses that unresolved tunnel issue.

The expanded draft adds invalid-password rejection paired with successful
login, and a category create/edit/delete lifecycle. The category case generates
its own unique name and handle, reloads to check persisted creation and edits,
then deletes the category and checks its absence after another reload. Run it
only against an isolated test catalog. Clean up only records created by a failed
test; never reset a shared application to make a test pass.

All three cases passed together in five consecutive CLI runs against the same
source-built VM image, with sequential execution, whole-test retries disabled
and no categories left behind. This verifies only these admin journeys on that
pinned environment; hosted CI and the localhost tunnel remain unverified.

## Local fixture

Requirements: Docker with Compose v2, Git, Bash, OpenSSL and Node.js. The container
uses Node 22.22.0 and the repository's Yarn 4.18.1. On Windows, run the script in
WSL or Git Bash. Git Bash was used for local verification.

From the repository root:

```bash
bash tests/E2E/install-medusa.sh install
bash tests/E2E/install-medusa.sh status
bash tests/E2E/install-medusa.sh logs
bash tests/E2E/install-medusa.sh restart
bash tests/E2E/install-medusa.sh stop
```

For a machine with limited CPU capacity, use
`E2E_BUILD_CONCURRENCY=1 bash tests/E2E/install-medusa.sh install`. The default is
four source-build tasks. The two default plugins build sequentially against the
already compiled workspace packages.

The admin is at `http://127.0.0.1:19000/app`. Only loopback is published. PostgreSQL
has its own Compose volume and no host port. The project name is
`medusa-testrigor-e2e`; existing project containers are untouched. No storefront,
payment provider or external email service is provisioned.

Generated fixture credentials stay in `.runtime/environment.env` and survive
repeat installation. `.runtime/variables.json` supplies only the fixture login
to testRigor. Both files are ignored. Do not publish them or include them in logs.
The app uses JWT authentication because the local HTTP fixture does not support
production Secure session cookies.

Reset affects only this fixture's Compose database volume:

```bash
bash tests/E2E/install-medusa.sh reset --confirm-reset
```

It clears users and commerce data, runs migrations and recreates the admin.
Generated credentials and built images survive. The smoke case expects an empty
product catalog. Do not use this fixture for manual commerce data creation while
collecting reliability evidence.

The installer rejects tracked source changes so the source-revision marker is
meaningful. It builds the required commerce packages, CLI, dashboard and built-in
draft-order plugin before compiling the fixture. Image tags include the source
revision and a hash of the provisioning files. Rebuild after changing the harness;
record test-case/rule hashes separately for each cloud run.

## Approved cloud development only

Cloud execution requires the suite owner's approval. Syntax validation does not
start a browser run. Supply the designated Medusa suite explicitly and load its
PAT into `TESTRIGOR_API_KEY` from the private project token file, without printing
it or passing it in command arguments.

After approval, run from the repository root with a unique report directory:

```bash
testrigor test-suite run "$TESTRIGOR_SUITE_ID" \
  --url "$MEDUSA_E2E_URL" \
  --test-cases-path 'tests/E2E/test-cases/**/*.yaml' \
  --rules-path 'tests/E2E/rules/**/*.yaml' \
  --variables-path tests/E2E/.runtime/variables.json \
  --settings-path tests/E2E/settings.json \
  --labels medusa-admin-e2e \
  --branch "$HARNESS_BRANCH" --commit "$HARNESS_COMMIT" \
  --junit-report-save-path "$UNIQUE_REPORT_DIR/junit.xml"
```

The report directory must already exist. No run uses `--explicit-mutations`;
remote suite replacement is outside this draft's scope. Do not run against the
senior's reference suite or overlap executions on one suite. A reliable result
requires five consecutive clean runs with unchanged source, harness, cases,
rules, settings and environment. Any failure or change restarts the count.

Set `MEDUSA_E2E_URL` to the approved isolated admin endpoint including `/app`.
Use generated credentials belonging to that instance; a remote VM has its own
credentials, distinct from the local fixture. `settings.json` keeps test cases
sequential and disables whole-test retries. The minimum server setting is two
even though parallel execution is disabled. For only the original smoke, narrow
`--test-cases-path` to its `TC-01` file. Rule labels are inherited by callers, so
the shared login rule's smoke label also appears on the expanded cases. Add
`--localhost` only for a local endpoint after separately verifying tunnel
connectivity.

On Linux, the tunnel binary needs a trusted operating-system CA bundle. Node's
built-in certificate roots alone do not supply that bundle to the tunnel client.

## Opt-in CI

For HTTP-only tunnel diagnosis, dispatch the workflow with `diagnose_tunnel=true`
and `run_cloud=false`. This separate job installs the same pinned CLI and starts
a disposable loopback HTTP page with a unique response. It checks direct access,
tunnel registration, proxy DNS, TCP 443/proxy-port connectivity and HTTP response
identity through the proxy for both loopback aliases. It builds no Medusa image,
uses no suite/token or generated login, calls no suite API and starts no browser
execution. Its isolated tunnel is stopped after probing. A failed HTTP probe fails
the job and still uploads `tunnel-diagnostic.json`; it does not set the repository
verification variable automatically. Do not select both dispatch options together.

`.github/workflows/e2e-tests.yml` provides manual dispatch only, with `run_cloud`
defaulting to false. It has no push, PR or schedule trigger and is advisory: it
should not be added to branch protection. Missing configuration skips the E2E
job before checkout, dependency installation or building.

Before enabling cloud execution, the repository owner must:

1. Designate a dedicated CI suite and its owner. Configure repository variable
   `TESTRIGOR_SUITE_ID` and secret `TESTRIGOR_CI_TOKEN`; the workflow maps the latter
   to the CLI's `TESTRIGOR_API_KEY` environment variable only where needed. Do not
   reuse another project's suite or copy a developer PAT into repository files.
2. Prove HTTP access through the testRigor tunnel from the intended runner network
   without spending browser runs on the known gateway failure. Record that
   evidence before setting repository variable `TESTRIGOR_TUNNEL_VERIFIED=true`.
   This flag records an external prerequisite; it does not test the tunnel.
   Direct VM HTTPS passes do not establish runner tunnel connectivity.
3. Review the selected branch as trusted before dispatching with `run_cloud=true`.
   Dispatch sends generated fixture credentials and page content to testRigor and
   consumes a cloud execution. Repository configuration and hosted execution need
   separate approval. No fork PR code is executed with secrets by this workflow.

The job uses Ubuntu 24.04, Node 22.22.0, exact CLI version 2.0.9 and SHA-pinned
actions. It builds the checked-out source with the existing pinned Docker fixture;
it does not test the previously deployed VM instead. An authenticated API probe
checks the image's source marker and empty products/categories before execution.
After a successful CLI exit it requires three JUnit cases with no failures,
errors or skips, and rechecks the empty catalog. The existing run settings keep
cases sequential and whole-test retries disabled. Ordinary execution omits
`--explicit-mutations` and does not replace saved suite content.

Concurrency is keyed by suite ID across branches, with cancellation disabled.
The owner must coordinate local runs and other repositories using that suite;
GitHub concurrency cannot serialize those callers. The job limit is 90 minutes,
including a 60-minute source-build limit and 20-minute cloud-step limit. A timeout
does not establish that the remote execution has stopped: inspect the suite
before dispatching again. Runner build capacity and these limits remain unverified.

CLI, syntax and build output stay in ignored `.runtime/ci-raw/`. The evidence step
redacts fixture environment values and the CI token, including XML/URL/JSON
representations, before uploading JUnit, logs and provenance from `.run/`. If
collection fails, upload is skipped. Artifact names include run ID and attempt.
The upload explicitly includes hidden files only within that sanitized directory;
raw `.runtime/` files are never included.
Retention is seven days. Source/harness commits, file hashes and image metadata
identify the tested inputs. Failures retain their job status even when evidence
collection succeeds. Cleanup always attempts to remove this ephemeral Compose
fixture and its volume; no shared VM is changed.

Suite ownership, token issuance/rotation and failure triage belong to the enabling
repository owner; upstream maintainer acceptance and a dedicated upstream suite
are still open decisions. Revoke/replace the token when ownership changes or it
is exposed, and update only the repository secret. To disable, remove the tunnel
verification variable or CI token; to retire, remove the workflow, revoke the
token and let retained artifacts expire. This workflow has been validated locally;
no hosted build, tunnel pass or cloud CI result is claimed.

Upstream publication requires a linked issue assigned to the contributor, a
description in the contributor's own words, and completion of Medusa's AI-usage
disclosure.
