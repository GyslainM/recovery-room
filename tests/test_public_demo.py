"""Standalone static serving, with no repair engine or provider in the package."""
from contextlib import closing
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import urljoin

from recovery_room.packaging import package_demo
from recovery_room.public_server import FILES, load_public, make_public_server


class PublicDemoTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.web = self.root / "web"
        for name in FILES:
            path = self.web / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"TEST FIXTURE")
        (self.web / "app.js").write_text("// TEST FIXTURE ONLY: RR_STATIC_DEMO_V1\n", encoding="utf-8")
        (self.web / "index.html").write_text('<!doctype html><html lang="en"><head></head><body>TEST FIXTURE</body></html>', encoding="utf-8")
        (self.web / "private.env").write_text("NOT FOR PUBLICATION", encoding="utf-8")
        self.data = self.root / "data.json"
        self.data.write_text(json.dumps({"schema_version": 1, "read_only": True, "capabilities":
                                        {"investigate": False, "rehearse": False, "export": False, "live_model": False}}))
        self.output = self.root / "package"

    def package(self):
        return package_demo(self.data, self.output, web=self.web)

    def test_package_copies_only_allowlisted_assets_and_adds_explicit_mode(self):
        result = self.package()
        self.assertTrue(result["read_only"])
        files = {p.relative_to(self.output / "public").as_posix() for p in (self.output / "public").rglob("*") if p.is_file()}
        self.assertEqual(files, set(FILES))
        self.assertIn('data-demo-mode="read-only"', (self.output / "public/index.html").read_text())
        self.assertFalse(list(self.output.rglob("*.db")))
        self.assertFalse(list(self.output.rglob("private.env")))
        self.assertNotIn("recovery_room", (self.output / "public_server.py").read_text())
        self.assertIn("USER 65534:65534", (self.output / "Dockerfile").read_text())
        self.assertFalse(result["container_tested"])

    def test_pending_frontend_or_write_capability_cannot_package(self):
        (self.web / "app.js").write_text("// adapter pending")
        with self.assertRaisesRegex(ValueError, "Frontend read-only adapter is pending"):
            self.package()
        self.assertFalse(self.output.exists())
        (self.web / "app.js").write_text("// TEST FIXTURE ONLY: RR_STATIC_DEMO_V1")
        data = json.loads(self.data.read_text())
        data["capabilities"]["live_model"] = True
        self.data.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "read-only version 1"):
            self.package()
        self.assertFalse(self.output.exists())

    def test_changed_package_refuses_to_start(self):
        self.package()
        (self.output / "public/app.js").write_text("changed after packaging")
        with self.assertRaisesRegex(ValueError, "changed after verification"):
            load_public(self.output / "public", self.output / "public-manifest.json")

    def test_public_assets_resolve_at_root_and_repository_mount_without_changing_workbench(self):
        original = ('<html><head><link href="/style.css"><link href="/favicon.svg">'
                    '<link href="/fonts/InterVariable.woff2"><script src="/app.js"></script></head>'
                    '<body><a href="/">Recovery Room home</a></body></html>')
        style = '@font-face{src:url("/fonts/InterVariable.woff2")} .other{background:none}'
        (self.web / "index.html").write_text(original, encoding="utf-8")
        (self.web / "style.css").write_text(style, encoding="utf-8")
        self.package()
        index = (self.output / "public/index.html").read_text(encoding="utf-8")
        css = (self.output / "public/style.css").read_text(encoding="utf-8")
        for base in ('https://example.test/', 'https://example.test/recovery-room/'):
            self.assertIn('href="./"', index)
            self.assertEqual(urljoin(base, './'), base)
            for name in ('style.css', 'favicon.svg', 'fonts/InterVariable.woff2', 'app.js'):
                self.assertIn(f'"./{name}"', index)
                self.assertEqual(urljoin(base, './' + name), base + name)
            self.assertIn('url("./fonts/InterVariable.woff2")', css)
            self.assertEqual(urljoin(base + 'style.css', './fonts/InterVariable.woff2'),
                             base + 'fonts/InterVariable.woff2')
        self.assertEqual((self.web / "index.html").read_text(encoding="utf-8"), original)
        self.assertEqual((self.web / "style.css").read_text(encoding="utf-8"), style)
        self.assertEqual(set(load_public(self.output / 'public', self.output / 'public-manifest.json')),
                         {'/' + name for name in FILES} | {'/'})

    def test_real_http_serves_fixed_get_head_resources_and_refuses_all_actions(self):
        self.package()
        server = make_public_server(self.output / "public", self.output / "public-manifest.json", port=0)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            def request(method, path):
                with closing(http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)) as conn:
                    conn.request(method, path, body=b"{}" if method == "POST" else None)
                    with closing(conn.getresponse()) as response:
                        return response.status, dict(response.getheaders()), response.read()
            status, headers, body = request("GET", "/")
            self.assertEqual(status, 200)
            self.assertEqual(int(headers["Content-Length"]), len(body))
            self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
            self.assertEqual(request("HEAD", "/")[2], b"")
            self.assertEqual(request("GET", "/fonts/InterVariable.woff2")[1]["Content-Type"], "font/woff2")
            self.assertEqual(request("GET", "/demo-data.json")[0], 200)
            for path in ("/api/incidents", "/api/runs/abc/artifacts/repair.sql", "/../private.env", "/public_server.py", "/.env", "/?x=1"):
                self.assertEqual(request("GET", path)[0], 404)
            for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
                status, headers, body = request(method, "/api/incidents/import-retry/investigate")
                self.assertEqual(status, 405)
                self.assertEqual(headers["Allow"], "GET, HEAD")
                self.assertIn(b"No live actions", body)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
