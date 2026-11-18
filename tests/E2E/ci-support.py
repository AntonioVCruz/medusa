"""CI probes and sanitized evidence; never starts a testRigor execution."""

import hashlib
import html
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
E2E = ROOT / "tests/E2E"
STATE = E2E / ".runtime"
RAW = STATE / "ci-raw"


def environment():
    path = STATE / "environment.env"
    if not path.exists():
        return {}
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)


def compose(*args):
    return subprocess.check_output([
        "docker", "compose", "--project-name", "medusa-testrigor-e2e",
        "--env-file", str(STATE / "environment.env"),
        "--env-file", str(STATE / "image.env"),
        "--file", str(E2E / "compose.yaml"), *args,
    ], stderr=subprocess.STDOUT, timeout=60).decode()


def request(path, data=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        os.environ.get("MEDUSA_E2E_URL", "http://127.0.0.1:19000/app").removesuffix("/app") + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def admin_probe():
    RAW.mkdir(parents=True, exist_ok=True)
    log = RAW / "admin-http.log"

    def record(message):
        print(message, flush=True)
        with log.open("a", encoding="utf-8") as output:
            output.write(message + "\n")

    log.write_text("", encoding="utf-8")
    # Compose is the authority for the host port, not the container's PORT=9000.
    published = compose("port", "app", "9000").strip()
    if not re.fullmatch(r"127\.0\.0\.1:[0-9]+", published):
        raise ValueError("Expected one IPv4 loopback-only app port mapping")
    url = "http://" + published + "/app"
    record("Admin URL: " + url)
    record("Proxy bypass: --noproxy '*'; no redirects followed; connect timeout 5s, total timeout 20s")
    body = RAW / "admin-http.html"
    response = subprocess.run([
        "curl", "--noproxy", "*", "--silent", "--show-error",
        "--connect-timeout", "5", "--max-time", "20",
        "--output", str(body),
        "--write-out", "%{http_code}\\n%{redirect_url}\\n%{content_type}\\n",
        url,
    ], capture_output=True, text=True, timeout=25)
    fields = response.stdout.splitlines()
    status, location, content_type = (fields + ["", "", ""])[:3]
    record("HTTP status: " + (status or "unavailable"))
    record("Redirect location: " + (location or "(none)"))
    record("Content-Type: " + (content_type or "(none)"))
    record("curl exit code: " + str(response.returncode))
    if response.stderr.strip():
        record(response.stderr.strip())
    if response.returncode or status != "200" or location:
        record("FAIL: expected direct HTTP 200 with no redirect; testRigor must not start")
        raise ValueError("Admin HTTP check failed")
    expected = compose("exec", "-T", "app", "cat",
                       "/app/.medusa/server/public/admin/index.html").encode("utf-8")
    actual = body.read_bytes()
    if ("text/html" not in content_type.lower() or actual != expected
            or not re.search(rb'id=[\"\']medusa[\"\']', actual)):
        record("FAIL: response does not match the built Medusa Admin HTML; testRigor must not start")
        raise ValueError("Unexpected Admin response")
    record("PASS: response matches the fixture's built Medusa Admin HTML (sha256 "
           + hashlib.sha256(actual).hexdigest() + ")")
    # The browser and subsequent fixture helpers use the exact URL just checked.
    with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as output:
        output.write("MEDUSA_E2E_URL=" + url + "\n")


def probe():
    expected = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip()
    actual = compose("exec", "-T", "app", "cat", "/source-revision").strip()
    if actual != expected or expected != os.environ["HARNESS_COMMIT"]:
        raise ValueError("Fixture source revision differs from checked-out harness")
    env = environment()
    token = request("/auth/user/emailpass", {
        "email": env["E2E_ADMIN_EMAIL"], "password": env["E2E_ADMIN_PASSWORD"],
    })["token"]
    for resource in ("products", "product-categories"):
        if request("/admin/" + resource + "?limit=1", token=token)["count"] != 0:
            raise ValueError("Fixture catalog must be empty")
    print("Source, administrator authentication and empty catalogs verified")


def result():
    root = ET.parse(RAW / "junit.xml").getroot()
    cases = list(root.iter("testcase"))
    if len(cases) != 9 or any(list(root.iter(tag)) for tag in ("failure", "error", "skipped")):
        raise ValueError("Expected nine JUnit cases without failures, errors or skips")
    subprocess.run(["node", str(E2E / "prepare-commerce-fixture.mjs"), "check"],
                   cwd=ROOT, check=True, timeout=150)
    subprocess.run(["node", str(E2E / "prepare-order-infrastructure.mjs"), "check"],
                   cwd=ROOT, check=True, timeout=150)
    probe()
    print("Nine cases passed; commerce outcomes, source and empty catalogs rechecked")


def collect():
    RAW.mkdir(parents=True, exist_ok=True)
    if (STATE / "image.env").exists():
        try:
            (RAW / "containers.log").write_text(compose("logs", "--no-color", "--tail", "200"))
            (RAW / "image.txt").write_text(compose("images", "--format", "json"))
        except (subprocess.SubprocessError, OSError):
            (RAW / "collection.txt").write_text("Container evidence unavailable\n")
    secrets = list(environment().values()) + [os.environ.get("TESTRIGOR_API_KEY", "")]
    variants = set()
    for secret in filter(None, secrets):
        variants.update((secret, html.escape(secret, quote=True),
                         urllib.parse.quote(secret, safe=""), json.dumps(secret)[1:-1]))
    output = E2E / ".run"
    output.mkdir(parents=True, exist_ok=True)
    for source in RAW.iterdir():
        if source.is_file() and source.suffix in (".log", ".xml", ".txt"):
            content = source.read_text(errors="replace")
            for value in sorted(variants, key=len, reverse=True):
                content = content.replace(value, "[REDACTED]")
            content = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED JWT]", content)
            (output / source.name).write_text(content, encoding="utf-8")
    files = [p for p in E2E.rglob("*") if p.is_file()
             and not any(part.startswith(".") or part == "__pycache__"
                         for part in p.relative_to(E2E).parts)]
    workflow = ROOT / ".github/workflows/e2e-tests.yml"
    files.append(workflow)
    provenance = {
        "application_commit": os.environ.get("HARNESS_COMMIT"),
        "harness_commit": os.environ.get("HARNESS_COMMIT"),
        "branch": os.environ.get("HARNESS_BRANCH"),
        "job_status": os.environ.get("JOB_STATUS"),
        "cli_version": "2.0.11",
        "admin_url": os.environ.get("MEDUSA_E2E_URL"),
        "transport": "testRigor localhost tunnel (requires separate verification)",
        "sha256": {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                   for p in files},
    }
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print("Sanitized CI evidence prepared")


if __name__ == "__main__":
    try:
        {"admin-probe": admin_probe, "probe": probe, "result": result, "collect": collect}[sys.argv[1]]()
    except Exception as error:
        # Exception text may contain HTTP responses or credentials from subprocess output.
        print("CI verification failed: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
