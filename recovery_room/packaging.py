"""Copy only allowlisted static assets after the frontend adapter is present."""
import hashlib
import json
from pathlib import Path
import re

from .demo import MAX_DATA_BYTES
from .public_server import FILES, load_public


def package_demo(data: Path, out: Path, *, web: Path | None = None) -> dict:
    web = web or Path(__file__).parent / "web"
    script = (web / "app.js").read_text(encoding="utf-8")
    if "RR_STATIC_DEMO_V1" not in script:
        raise ValueError("Frontend read-only adapter is pending. No deployable package was created.")
    if data.stat().st_size > MAX_DATA_BYTES:
        raise ValueError("Public dataset exceeds its size limit.")
    raw = data.read_bytes()
    dataset = json.loads(raw)
    if (dataset.get("schema_version") != 1 or dataset.get("read_only") is not True
            or dataset.get("capabilities") != {"investigate": False, "rehearse": False, "export": False, "live_model": False}):
        raise ValueError("Public dataset must implement the read-only version 1 contract.")
    index = (web / "index.html").read_text(encoding="utf-8")
    if len(re.findall(r"<html\b[^>]*>", index, flags=re.I)) != 1:
        raise ValueError("Expected exactly one HTML root for the explicit public-demo mode.")
    index = re.sub(r"<html\b([^>]*)>", r'<html\1 data-demo-mode="read-only">', index, count=1, flags=re.I)
    payloads = {"demo-data.json": raw, "index.html": index.encode()}
    for name in FILES.keys() - payloads.keys():
        source = web / name
        if source.is_symlink() or source.resolve().is_relative_to(web.resolve()) is False:
            raise ValueError("Public assets must be regular files inside the frontend.")
        payloads[name] = source.read_bytes()
    out = out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    public = out / "public"
    for name, encoded in payloads.items():
        path = public / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded)
    manifest = {name: hashlib.sha256(encoded).hexdigest() for name, encoded in sorted(payloads.items())}
    manifest_path = out / "public-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (out / "public_server.py").write_bytes((Path(__file__).parent / "public_server.py").read_bytes())
    (out / "Dockerfile").write_text(
        'FROM python:3.14-slim\nWORKDIR /demo\nCOPY public/ ./public/\n'
        'COPY public_server.py public-manifest.json ./\nUSER 65534:65534\nEXPOSE 8080\n'
        'CMD ["python", "public_server.py", "--host", "0.0.0.0", "--port", "8080"]\n', encoding="utf-8")
    (out / ".dockerignore").write_text("*\n!public/\n!public/**\n!public_server.py\n!public-manifest.json\n!Dockerfile\n", encoding="utf-8")
    load_public(public, manifest_path)
    return {"passed": True, "read_only": True, "public_files": list(manifest),
            "container_tested": False, "deployment_requires_frontend_browser_verification": True}
