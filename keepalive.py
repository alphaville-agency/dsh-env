"""Report whether a developer session is attached, so the workspace can idle when nobody is.

Bound to the tailnet address only. Nothing here is reachable from the public internet: a workspace
that answers on a public interface is exposed, however it authenticates, and the whole reason this
runs as a background worker is that it has no public surface to secure.

A session registers a lease while its shell is open. The service is "awake" while any lease is
live; with none, it reports idle and the platform is free to scale down.
"""
import json
import os
import socket
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

LEASE_DIR = Path(os.environ.get("DSH_LEASE_DIR", "/run/dsh-leases"))
LEASE_TTL_SECONDS = float(os.environ.get("DSH_LEASE_TTL_SECONDS", "120"))
PORT = int(os.environ.get("DSH_STATUS_PORT", "8787"))


def tailnet_address() -> str:
    """The address this node answers on, or loopback if it has not joined yet."""
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5).stdout.strip()
        if out:
            return out.splitlines()[0]
    except (OSError, subprocess.SubprocessError):
        pass
    return "127.0.0.1"


def live_leases() -> list[str]:
    LEASE_DIR.mkdir(parents=True, exist_ok=True)
    now = time.time()
    live = []
    for lease in LEASE_DIR.iterdir():
        try:
            if now - lease.stat().st_mtime <= LEASE_TTL_SECONDS:
                live.append(lease.name)
            else:
                lease.unlink()
        except OSError:
            continue
    return sorted(live)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload, sort_keys=True).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        leases = live_leases()
        if path == "/status":
            self._send(200, {"schema": "dsh.workspace-status.v1", "awake": bool(leases),
                             "sessions": leases, "host": socket.gethostname()})
        elif path == "/healthz":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        """A shell registers or renews its lease by POSTing its own name."""
        if urlparse(self.path).path != "/lease":
            self._send(404, {"error": "not found"})
            return
        name = self.headers.get("X-Lease-Name") or f"session-{os.getpid()}"
        LEASE_DIR.mkdir(parents=True, exist_ok=True)
        (LEASE_DIR / name).touch()
        self._send(200, {"lease": name, "ttl_seconds": LEASE_TTL_SECONDS})

    def log_message(self, *args):
        pass  # a status endpoint that logs every poll is noise


def main():
    address = tailnet_address()
    server = ThreadingHTTPServer((address, PORT), Handler)
    print(f"dsh status on http://{address}:{PORT} (tailnet only)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
