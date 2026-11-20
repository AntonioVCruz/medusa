"""CI-only loopback proxy; serves Medusa responses, never local files."""

import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import ssl


HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
UPSTREAM_PORT = 19000


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def request_body(self):
        # Browser requests normally have Content-Length; testRigor API steps can
        # stream JSON with Transfer-Encoding: chunked. Decode it before dropping
        # hop-by-hop headers, otherwise the backend receives an empty body.
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            parts = []
            total = 0
            while True:
                size = int(self.rfile.readline(8192).split(b";", 1)[0], 16)
                if size == 0:
                    while self.rfile.readline(8192) not in (b"\r\n", b"\n", b""):
                        pass
                    return b"".join(parts)
                total += size
                if size < 0 or total > 16 * 1024 * 1024:
                    raise ValueError("Invalid request size")
                parts.append(self.rfile.read(size))
                if self.rfile.read(2) != b"\r\n":
                    raise ValueError("Invalid chunk terminator")
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 16 * 1024 * 1024:
            raise ValueError("Invalid request size")
        return self.rfile.read(length) if length else None

    def forward(self):
        self.connection.settimeout(30)
        upstream = http.client.HTTPConnection("127.0.0.1", UPSTREAM_PORT, timeout=30)
        try:
            body = self.request_body()
            connection_headers = {
                part.strip().lower() for part in self.headers.get("Connection", "").split(",")
            }
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in HOP_HEADERS | connection_headers | {"content-length"}}
            headers["X-Forwarded-Proto"] = "https"
            headers["X-Forwarded-Host"] = self.headers.get("Host", "localhost:18443")
            if body is not None:
                headers["Content-Length"] = str(len(body))
            upstream.request(self.command, self.path, body=body, headers=headers)
            response = upstream.getresponse()
            content = response.read()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP_HEADERS | {"content-length"}:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(content)
        except ValueError:
            self.send_error(400, "Invalid request body")
        except (OSError, http.client.HTTPException):
            self.send_error(502, "Medusa upstream unavailable")
        finally:
            upstream.close()

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = forward

    def log_message(self, *args):
        # Requests can include credentials, tokens or test data. Do not log them.
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cert", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", 18443), Proxy)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(args.cert, args.key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print("CI proxy: https://localhost:18443 -> http://127.0.0.1:19000", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
