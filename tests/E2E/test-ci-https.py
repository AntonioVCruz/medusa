"""Synthetic local TLS/proxy checks; no Docker or testRigor executions."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
from unittest.mock import patch
import urllib.error
import urllib.request


HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = load("ci_proxy", HERE / "ci-proxy.py")
html = b'<html><div id="medusa"></div><script src="/app/assets/main.js"></script></html>'
seen = []


class Upstream(BaseHTTPRequestHandler):
    def do_GET(self):
        seen.append((self.path, dict(self.headers)))
        content = {"/app": html, "/app/assets/main.js": b"export default 1"}.get(self.path)
        self.send_response(200 if content else 404)
        self.end_headers()
        self.wfile.write(content or b"not found")

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        seen.append((self.path, dict(self.headers), body))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *args):
        pass


def serve(server):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    cert, key = root / "cert.pem", root / "private/key.pem"
    key.parent.mkdir()
    subprocess.run([shutil.which("openssl"), "req", "-x509", "-newkey", "rsa:2048",
                    "-sha256", "-nodes", "-days", "1", "-subj", "/CN=localhost",
                    "-addext", "subjectAltName=DNS:localhost", "-keyout", str(key),
                    "-out", str(cert)], check=True, capture_output=True)
    upstream = serve(ThreadingHTTPServer(("127.0.0.1", 0), Upstream))
    try:
        with patch.object(proxy, "UPSTREAM_PORT", upstream.server_port):
            server = ThreadingHTTPServer(("127.0.0.1", 0), proxy.Proxy)
            server.scheme = "https"
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            serve(server)
            try:
                origin = f"https://localhost:{server.server_port}"
                trusted = urllib.request.build_opener(
                    urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(
                        context=ssl.create_default_context(cafile=str(cert))))
                assert trusted.open(origin + "/app").read() == html
                assert trusted.open(origin + "/app/assets/main.js").read() == b"export default 1"
                request = urllib.request.Request(origin + "/auth/user/emailpass",
                                                 data=b'{"synthetic":true}',
                                                 headers={"Origin": origin, "Content-Type": "application/json"})
                assert json.load(trusted.open(request)) == {"ok": True}
                assert seen[-1][1]["Host"] == f"localhost:{server.server_port}"
                assert seen[-1][1]["Origin"] == origin
                assert seen[-1][1]["X-Forwarded-Proto"] == "https"
                assert seen[-1][2] == b'{"synthetic":true}'
                for path in ["/private/key.pem", "/.runtime/tls/key.pem"]:
                    try:
                        trusted.open(origin + path)
                        raise AssertionError("Private file unexpectedly served")
                    except urllib.error.HTTPError as error:
                        assert error.code == 404
                untrusted = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                try:
                    untrusted.open(origin + "/app")
                    raise AssertionError("Self-signed certificate unexpectedly trusted")
                except urllib.error.URLError as error:
                    assert isinstance(error.reason, ssl.SSLCertVerificationError)
                try:
                    trusted.open(f"https://127.0.0.1:{server.server_port}/app")
                    raise AssertionError("Wrong hostname unexpectedly accepted")
                except urllib.error.URLError as error:
                    assert isinstance(error.reason, ssl.SSLCertVerificationError)
            finally:
                server.shutdown()
                server.server_close()
    finally:
        upstream.shutdown()
        upstream.server_close()
print("Passed: HTTPS HTML/assets/API, forwarded origin/body, private-file rejection, "
      "untrusted certificate rejection, and SAN hostname validation")
