"""Sequential, opt-in comparisons using the unchanged Admin login case and CLI."""

import json
import os
from pathlib import Path
import subprocess


RAW = Path("tests/E2E/.runtime/ci-raw")
comparisons = [
    ("http-ip-19000", "http://127.0.0.1:19000/app", "https"),
    ("http-localhost-19000", "http://localhost:19000/app", "https"),
    ("http-localhost-18443", "http://localhost:18443/app", "http"),
    ("https-localhost-18443-repeat", "https://localhost:18443/app", "https"),
]
results = []
try:
    for name, url, protocol in comparisons:
        # Restart only the loopback proxy, preserving the Medusa container and data.
        subprocess.run(["bash", "tests/E2E/ci-proxy.sh", protocol], check=True)
        # Probes in child runs must not change the HTTPS fixture/cleanup origin
        # exported to later workflow steps, even if a comparison aborts.
        env = dict(os.environ, MEDUSA_E2E_URL=url, GITHUB_ENV=os.devnull)
        with (RAW / ("comparison-" + name + ".log")).open("w") as output:
            run = subprocess.run(["bash", "tests/E2E/ci-run.sh", "login", name],
                                 env=env, stdout=output, stderr=subprocess.STDOUT)
        results.append({"name": name, "url": url, "cli_exit_code": run.returncode,
                        "passed": run.returncode == 0,
                        "cli_log": "cli-" + name + ".log",
                        "direct_probe": "admin-" + name + ".log"})
        (RAW / "transport-comparisons.txt").write_text(json.dumps(results, indent=2) + "\n")
        print(json.dumps(results[-1]), flush=True)
        # A CLI signal/abnormal termination can leave a cloud run active. Do not
        # start another case in that situation. Ordinary case failures return 1.
        if run.returncode not in (0, 1):
            raise RuntimeError("Abnormal CLI termination; inspect cloud activity")
finally:
    subprocess.run(["bash", "tests/E2E/ci-proxy.sh", "https"], check=True)
