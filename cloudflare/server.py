"""HTTP wrapper that runs the radar inside the Cloudflare container.

The Worker (cloudflare/src/index.js) posts the state directory (a gzipped tar, base64)
and the command; this runs `python -m radar <command>` and returns the new state and
the report. The state lives in R2 between runs, not in the container, because container
disks are wiped when the instance sleeps.

POST /run?cmd=daily|sources   body: {"state": "<base64 tar.gz or empty>"}
  -> {"exit": int, "state": "<base64 tar.gz>", "report": "<markdown>", "log": "<tail>"}
"""
from __future__ import annotations

import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP = Path(os.environ.get("APP_DIR", "/app"))
WORK = Path(os.environ.get("WORK_DIR", "/tmp/work"))
# The Worker's cron wall-clock limit is 15 minutes; stop the run a little before that.
RUN_TIMEOUT = 13 * 60
LOCK = threading.Lock()


def unpack(b64: str, dest: Path) -> None:
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True)
    if b64:
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(b64)), mode="r:gz") as tar:
            tar.extractall(dest, filter="data")


def pack(src: Path) -> str:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        tar.add(src, arcname=".")
    return base64.b64encode(buf.getvalue()).decode()


def run(cmd: str, state_b64: str) -> dict:
    state = WORK / "state"
    report = WORK / "report.md"
    unpack(state_b64, state)
    report.unlink(missing_ok=True)

    args = [sys.executable, "-m", "radar", cmd, "--state", str(state), "--out", str(report)]
    if os.environ.get("RADAR_EMAIL_TO"):
        args.append("--mail")

    try:
        proc = subprocess.run(args, cwd=APP, capture_output=True, text=True, timeout=RUN_TIMEOUT)
        code, out = proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        code, out = 124, "radar run timed out"

    return {
        "exit": code,
        # Only hand back a new state when the run finished; a half-run would corrupt the leads DB.
        "state": pack(state) if code == 0 else "",
        "report": report.read_text() if report.exists() else "",
        "log": out[-4000:],
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if urlparse(self.path).path == "/health":
            self._send(200, b"ok", "text/plain")
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if url.path != "/run":
            return self._send(404, b"not found", "text/plain")
        cmd = parse_qs(url.query).get("cmd", [""])[0]
        if cmd not in ("daily", "sources"):
            return self._send(400, b"cmd must be daily or sources", "text/plain")

        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        with LOCK:
            result = run(cmd, body.get("state", ""))
        self._send(200, json.dumps(result).encode(), "application/json")

    def _send(self, status: int, payload: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args) -> None:  # keep container logs to errors
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
