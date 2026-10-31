"""Standalone static-demo server. No Recovery Room imports or mutation endpoints.

This file is copied alone into a deployment package. Serve public/ behind the
hosting platform's TLS proxy. The local repair workbench is never made public.
"""
from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path


FILES = {"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8",
         "style.css": "text/css; charset=utf-8", "favicon.svg": "image/svg+xml",
         "fonts/InterVariable.woff2": "font/woff2", "fonts/OFL.txt": "text/plain; charset=utf-8",
         "demo-data.json": "application/json; charset=utf-8"}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
       "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")


def load_public(root: Path, manifest: Path) -> dict:
    root = root.resolve()
    checksums = json.loads(manifest.read_text(encoding="utf-8"))
    if set(checksums) != set(FILES):
        raise ValueError("Static package manifest does not contain exactly the public files.")
    assets = {}
    for name, mime in FILES.items():
        path = root / name
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
            raise ValueError("Static package files cannot be links.")
        if path.resolve().is_relative_to(root) is False or path.stat().st_size > 8_000_000:
            raise ValueError("Static package file exceeds its bounds.")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != checksums[name]:
            raise ValueError("Static package changed after verification.")
        assets["/" + name] = (data, mime)
    assets["/"] = assets["/index.html"]
    return assets


def make_public_server(root: Path, manifest: Path, *, host="127.0.0.1", port=8080):
    assets = load_public(root, manifest)

    class Handler(BaseHTTPRequestHandler):
        server_version = "RecoveryRoomStatic"

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_):
            pass  # No user-supplied URLs/headers in logs.

        def _reply(self, status, body=b"", mime="text/plain; charset=utf-8", *, head=False):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Allow", "GET, HEAD")
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def _get(self, head=False):
            item = assets.get(self.path)
            if item is None:
                return self._reply(404, b"Unknown static resource.", head=head)
            self._reply(200, *item, head=head)

        def do_GET(self):
            self._get()

        def do_HEAD(self):
            self._get(head=True)

        def _refuse(self):
            self.close_connection = True
            self._reply(405, b"Read-only recorded demo. No live actions.")

        do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _refuse

    return ThreadingHTTPServer((host, port), Handler)


def main():
    parser = argparse.ArgumentParser(description="Serve only the verified static Recovery Room demo.")
    parser.add_argument("--root", type=Path, default=Path("public"))
    parser.add_argument("--manifest", type=Path, default=Path("public-manifest.json"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    with make_public_server(args.root, args.manifest, host=args.host, port=args.port) as server:
        print("Recovery Room recorded static demo. No model or write endpoints.", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
