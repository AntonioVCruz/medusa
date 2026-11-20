# Admin browser E2E

Nine testRigor cases exercise the Admin UI against an isolated application built
from this checkout. API helpers prepare test data and independently check the
commerce results. No storefront, external payment, carrier or email service is
required.

| Case | Checks |
| --- | --- |
| TC-01 | Sign in and open the empty product list. |
| TC-02 | Reject an invalid password, then accept valid credentials. |
| TC-03 | Create, edit and delete a category; reload to verify persistence. |
| TC-04 | Create four variants, reject a duplicate SKU and verify saved SKU/price mappings. |
| TC-05 | Reject a reservation above stock; create, edit and delete it, restoring available stock. |
| TC-06 | Cancel a draft quantity edit, then save it; verify EUR 50 becomes EUR 75. |
| TC-07 | Add and remove group membership from both views while preserving the customer. |
| TC-08 | Apply a 10% product-scoped promotion; verify EUR 60 becomes EUR 55, then returns to EUR 60 after removal. |
| TC-09 | Fulfill and ship two of three units; verify the remaining unit and stock/reservation arithmetic. |

## GitHub Actions

`Admin E2E (opt-in)` runs only through manual dispatch. It is independent of the
normal build/test pipeline and has no schedule or automatic PR trigger.

Configure a dedicated Chrome desktop suite and these repository values:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `TESTRIGOR_SUITE_ID` | ID of the dedicated suite. |
| Secret | `TESTRIGOR_CI_TOKEN` | That suite's CI token. |
| Variable | `TESTRIGOR_TUNNEL_VERIFIED` | `true` after validating runner access to the fixture. |

Dispatch with `run_cloud=true`. Missing configuration or an unchecked input skips
E2E cleanly. To establish runner access, the enabling owner sets the verification
variable for a controlled first dispatch and checks the login result before
relying on this configuration. Tunnel registration alone is insufficient.

The job builds workspace packages and both default plugins with Node 22.22.0 and
the repository's Yarn 4.18.1. The fixture links those built packages, runs database
migrations and creates an administrator with generated credentials. It verifies
the source revision, exact built Admin HTML, authentication and empty catalog
before executing browsers.

CLI 3.0.0 connects through `https://localhost:18443/app`. A loopback-only proxy
forwards to the fixture on `127.0.0.1:19000`. It uses a one-day certificate with a
`localhost` DNS SAN; local curl, Python and Node helpers trust that certificate
explicitly. Its private key stays outside served content and uploaded artifacts.
The proxy handles both fixed-length and chunked API request bodies. Global TLS
verification is not disabled.

The workflow validates syntax, runs TC-01 first, then runs all nine cases only
after login passes. Cases run sequentially with whole-test retries disabled.
Both CLI exit status and JUnit counts must pass, followed by independent commerce
postchecks. The job attempts both business-record cleanup routines after failures
and removes its Compose containers and database volume at the end.

Repository access is read-only and actions are pinned to commit SHAs. Concurrency
is keyed by suite ID without cancellation; local callers and other repositories
must also avoid overlapping runs on that suite. A job timeout does not establish
that a remote run has stopped: inspect the suite before starting another run.
The job limit is 90 minutes, including a 60-minute source-build limit.

JUnit, CLI/build/container logs and source/harness provenance are uploaded with
seven-day retention. The collector redacts fixture credentials, the CI token and
transient JWTs before upload. Raw `.runtime/` state is excluded. Browser steps and
test data, including generated fixture credentials, are sent to testRigor; use
only a disposable test instance and a dedicated suite.

The enabling owner manages suite access, token rotation and failure triage.
Disable by removing the token or verification variable; retire by disabling the
workflow, revoking the token and allowing retained artifacts to expire. Upstream
suite ownership and acceptance of the service dependency require maintainer
agreement.

## Local fixture

Requirements: Docker with Compose v2, Git, Bash, curl, OpenSSL and Node.js.
On Windows use Git Bash or WSL. Run from the repository root:

```bash
bash tests/E2E/install-medusa.sh install
bash tests/E2E/install-medusa.sh status
bash tests/E2E/install-medusa.sh logs
bash tests/E2E/install-medusa.sh restart
bash tests/E2E/install-medusa.sh stop
```

The Admin is at `http://127.0.0.1:19000/app`. PostgreSQL has no host port; the
Compose project is `medusa-testrigor-e2e`. Credentials are generated once in
`.runtime/environment.env` and reused on repeat installation. Runtime state,
credentials and reports are ignored by Git. The Admin uses JWT authentication.

The installer rejects tracked application-source changes; commit those before
building so the image's source marker identifies the source under test. Image
tags include the revision and a provisioning-file hash. For limited resources,
set `E2E_BUILD_CONCURRENCY=1` (default: four build tasks).

To clear only this fixture database, retaining credentials and images:

```bash
bash tests/E2E/install-medusa.sh reset --confirm-reset
```

## Running locally

Install the pinned CLI with `npm install --global @testrigor/testrigor-cli@3.0.0`.
Set `TESTRIGOR_SUITE_ID` to a dedicated suite and supply its token through
`TESTRIGOR_API_KEY`. Do not put tokens in command arguments. After installing the
fixture, use its HTTPS endpoint for cloud execution:

```bash
bash tests/E2E/ci-proxy.sh start
export MEDUSA_E2E_URL=https://localhost:18443/app
export MEDUSA_E2E_CA_CERT="$PWD/tests/E2E/.runtime/tls/cert.pem"
export NODE_EXTRA_CA_CERTS="$MEDUSA_E2E_CA_CERT"
export HARNESS_BRANCH="$(git branch --show-current)"
export HARNESS_COMMIT="$(git rev-parse HEAD)"
export GITHUB_ENV="$PWD/tests/E2E/.runtime/probe.env"
python3 tests/E2E/ci-support.py admin-probe
python3 tests/E2E/ci-support.py probe
node tests/E2E/prepare-commerce-fixture.mjs prepare
node tests/E2E/prepare-order-infrastructure.mjs prepare
node tests/E2E/prepare-variables.mjs
testrigor test-suite validate-syntax "$TESTRIGOR_SUITE_ID" \
  --test-cases-path 'tests/E2E/test-cases/**/*.yaml' \
  --rules-path 'tests/E2E/rules/**/*.yaml'
bash tests/E2E/ci-run.sh login login-https
bash tests/E2E/ci-run.sh full full-https
```

Always run cleanup, including after a failed execution:

```bash
node tests/E2E/prepare-order-infrastructure.mjs cleanup
node tests/E2E/prepare-commerce-fixture.mjs cleanup
bash tests/E2E/ci-proxy.sh stop
```

Preparation supplies an owned tax-free EUR region, warehouses, stock, customers,
a EUR 50 draft and manual shipping infrastructure. TC-08/09 API rules create
their own business records. Use the same target and `.runtime/` state for prepare,
check and cleanup. Clean the preceding run before preparing again; starting saved
cases in the testRigor UI does not provision these fixtures.

Cleanup deletes recorded business IDs and recovers test-owned records from a
failed run. Owned regions/warehouses/shipping infrastructure remain reusable.
Medusa retains shipped order history; these test orders carry ownership and
retirement metadata. CI removes them with its ephemeral database volume. Use a
dedicated empty catalog; these helpers are not intended for production data.

Runs use the repository's case/rule/variable/settings files without
`--explicit-mutations` (authoritative suite replacement). `settings.json` disables
parallel execution and whole-test retries. The full run requires exactly nine
passing cases; the login selection requires exactly one.

Local proxy regression checks need Python 3, OpenSSL and Node, without Docker or
cloud execution: `python3 tests/E2E/test-ci-https.py`.

## Verification

[Fork CI validation, 2026-11-20](https://github.com/AntonioVCruz/medusa/actions/runs/44757374263)
passed login, all nine cases, independent commerce postchecks and cleanup on
Medusa 2.23.0 at `fa698ac2b6`, with CLI 3.0.0. The nine-case run had
2 recovered action-retry warnings. This is evidence for that source-built
configuration; it does not establish reliability across other revisions.
