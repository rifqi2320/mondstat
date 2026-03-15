import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


TARGET_HOST = os.environ.get("TARGET_HOST", "region1.v2.argotunnel.com")
TARGET_PORT = int(os.environ.get("TARGET_PORT", "7844"))
PROBE_INTERVAL_SECONDS = float(os.environ.get("PROBE_INTERVAL_SECONDS", "15"))
NC_TIMEOUT_SECONDS = int(os.environ.get("NC_TIMEOUT_SECONDS", "5"))
LISTEN_PORT = int(os.environ.get("PORT", "9850"))
TARGET_LABEL = f"{TARGET_HOST}:{TARGET_PORT}"

state_lock = threading.Lock()
state = {
    "up": 0.0,
    "duration_seconds": 0.0,
    "last_probe_timestamp_seconds": 0.0,
    "last_success_timestamp_seconds": 0.0,
}


def format_metrics():
    with state_lock:
        snapshot = dict(state)

    lines = [
        "# HELP network_heartbeat_up Whether the latest TCP heartbeat probe succeeded.",
        "# TYPE network_heartbeat_up gauge",
        f'network_heartbeat_up{{target="{TARGET_LABEL}"}} {snapshot["up"]:.0f}',
        "# HELP network_heartbeat_probe_duration_seconds Duration of the latest TCP heartbeat probe.",
        "# TYPE network_heartbeat_probe_duration_seconds gauge",
        f'network_heartbeat_probe_duration_seconds{{target="{TARGET_LABEL}"}} {snapshot["duration_seconds"]:.6f}',
        "# HELP network_heartbeat_last_probe_timestamp_seconds Unix timestamp of the latest TCP heartbeat probe.",
        "# TYPE network_heartbeat_last_probe_timestamp_seconds gauge",
        f'network_heartbeat_last_probe_timestamp_seconds{{target="{TARGET_LABEL}"}} {snapshot["last_probe_timestamp_seconds"]:.0f}',
        "# HELP network_heartbeat_last_success_timestamp_seconds Unix timestamp of the latest successful TCP heartbeat probe.",
        "# TYPE network_heartbeat_last_success_timestamp_seconds gauge",
        f'network_heartbeat_last_success_timestamp_seconds{{target="{TARGET_LABEL}"}} {snapshot["last_success_timestamp_seconds"]:.0f}',
        "",
    ]
    return "\n".join(lines).encode("utf-8")


def probe_target():
    command = [
        "nc",
        "-vz",
        "-w",
        str(NC_TIMEOUT_SECONDS),
        TARGET_HOST,
        str(TARGET_PORT),
    ]
    started_at = time.monotonic()
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    finished_at = time.monotonic()
    now = time.time()

    with state_lock:
        state["up"] = 1.0 if result.returncode == 0 else 0.0
        state["duration_seconds"] = max(0.0, finished_at - started_at)
        state["last_probe_timestamp_seconds"] = now
        if result.returncode == 0:
            state["last_success_timestamp_seconds"] = now


def probe_loop():
    while True:
        probe_target()
        time.sleep(PROBE_INTERVAL_SECONDS)


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return

        payload = format_metrics()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    thread = threading.Thread(target=probe_loop, daemon=True)
    thread.start()
    server = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), MetricsHandler)
    server.serve_forever()
