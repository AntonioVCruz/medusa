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

    def forward(self):
        upstream = http.client.HTTPConnection("127.0.0.1", UPSTREAM_PORT, timeout=30)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else None
            connection_headers = {
                part.strip().lower() for part in self.headers.get("Connection", "").split(",")
            }
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in HOP_HEADERS | connection_headers}
            headers["X-Forwarded-Proto"] = self.server.scheme
            headers["X-Forwarded-Host"] = self.headers.get("Host", "localhost:18443")
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
    parser.add_argument("--protocol", choices=["http", "https"], default="https")
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", 18443), Proxy)
    server.scheme = args.protocol
    if args.protocol == "https":
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(args.cert, args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"CI proxy: {args.protocol}://localhost:18443 -> http://127.0.0.1:19000", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
