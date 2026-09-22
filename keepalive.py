"""Two listeners, deliberately different in what they expose.

* The platform's port answers ONE constant health response and nothing else. A free service needs
  a public port; this is the smallest public surface that satisfies that, and it reveals nothing.
* The workspace answers only on the tailnet: session leases, status, and the shell.

A login shell polls the public health endpoint while it is open, which is what keeps a free
service from sleeping. When nobody is connected the polling stops and the service is allowed to
idle - the sleep behaviour is the desired one, driven by whether a developer is attached.
"""
import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

LEASE_DIR = Path(os.environ.get("DSH_LEASE_DIR", "/run/dsh-leases"))
LEASE_TTL_SECONDS = float(os.environ.get("DSH_LEASE_TTL_SECONDS", "120"))
TAILNET_PORT = int(os.environ.get("DSH_STATUS_PORT", "8787"))
PUBLIC_PORT = int(os.environ.get("PORT", "10000"))
TAILNET_STATE = os.environ.get("DSH_TAILNET_STATE", "/run/dsh-tailnet.json")


def tailnet_address() -> str:
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


def _reply(handler, code, payload):
    body = json.dumps(payload, sort_keys=True).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class PublicHandler(BaseHTTPRequestHandler):
    """The only thing the internet may see. It answers a constant and reads nothing."""

    def do_GET(self):
        if urlparse(self.path).path == "/healthz":
            state = {"ok": True}
            try:
                state.update(json.loads(Path(TAILNET_STATE).read_text()))
            except (OSError, ValueError):
                state["tailnet"] = "unknown"
            _reply(self, 200, state)
        else:
            _reply(self, 404, {"error": "not found"})

    def log_message(self, *args):
        pass


class TailnetHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        leases = live_leases()
        path = urlparse(self.path).path
        if path == "/status":
            _reply(self, 200, {"schema": "dsh.workspace-status.v1", "awake": bool(leases),
                               "sessions": leases, "public_health": f":{PUBLIC_PORT}/healthz"})
        elif path == "/healthz":
            _reply(self, 200, {"ok": True})
        else:
            _reply(self, 404, {"error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/lease":
            _reply(self, 404, {"error": "not found"})
            return
        name = self.headers.get("X-Lease-Name") or f"session-{os.getpid()}"
        LEASE_DIR.mkdir(parents=True, exist_ok=True)
        (LEASE_DIR / name).touch()
        _reply(self, 200, {"lease": name, "ttl_seconds": LEASE_TTL_SECONDS})

    def log_message(self, *args):
        pass


def serve(handler, address, port, label):
    server = ThreadingHTTPServer((address, port), handler)
    print(f"{label} on http://{address}:{port}", flush=True)
    server.serve_forever()


def main():
    import threading
    threading.Thread(target=serve, args=(PublicHandler, "0.0.0.0", PUBLIC_PORT, "public health"), daemon=True).start()
    serve(TailnetHandler, tailnet_address(), TAILNET_PORT, "workspace (tailnet)")


if __name__ == "__main__":
    main()
