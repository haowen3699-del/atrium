"""Remote run-agent sidecar for Windows.

Exposes cc-connect and child opencode processes as runAgents JSON so that the
OpenCode Fleet Monitor can render them alongside remote opencode servers.
"""

from __future__ import annotations

import argparse
import http.server
import json
import platform
import re
import socketserver
import subprocess
import sys
import time
from dataclasses import dataclass

__all__ = ["run"]


@dataclass
class Proc:
    pid: int
    ppid: int
    cmd: str


def _parse_wmic_line(line: str) -> Proc | None:
    parts = [p.strip().strip('"') for p in line.split(",")]
    if len(parts) < 4:
        return None
    # CSV format: NODE,ProcessId,ParentProcessId,CommandLine
    try:
        pid = int(parts[1])
        ppid = int(parts[2])
    except (IndexError, ValueError):
        return None
    cmd = ",".join(parts[3:])
    return Proc(pid=pid, ppid=ppid, cmd=cmd)


def list_processes() -> list[Proc]:
    """Return a list of processes using PowerShell (preferred) or wmic fallback."""
    if platform.system() == "Windows":
        # Modern Windows (especially 11 24H2+) removed wmic; use PowerShell/CIM.
        try:
            out = subprocess.check_output(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
                ],
                text=True,
                timeout=15,
            )
            data = json.loads(out)
            rows = data if isinstance(data, list) else [data]
            procs: list[Proc] = []
            for row in rows:
                if not row:
                    continue
                try:
                    procs.append(Proc(pid=int(row["ProcessId"]), ppid=int(row["ParentProcessId"]), cmd=row.get("CommandLine") or ""))
                except (KeyError, ValueError, TypeError):
                    continue
            if procs:
                return procs
        except Exception:
            pass

        # Fallback to wmic for older Windows.
        try:
            out = subprocess.check_output(
                ["wmic", "process", "get", "ProcessId,ParentProcessId,CommandLine", "/format:csv"],
                text=True,
                timeout=10,
            )
        except Exception:
            return []

        procs = []
        for line in out.splitlines():
            line = line.strip()
            if not line or line.startswith("Node,"):
                continue
            proc = _parse_wmic_line(line)
            if proc:
                procs.append(proc)
        return procs

    # Fallback for development on macOS/Linux: use ps if available.
    try:
        out = subprocess.check_output(["ps", "ax", "-o", "pid=,ppid=,command="], text=True, timeout=5)
        procs = []
        for line in out.splitlines():
            parts = line.split(None, 2)
            if len(parts) < 3:
                continue
            procs.append(Proc(pid=int(parts[0]), ppid=int(parts[1]), cmd=parts[2]))
        return procs
    except Exception:
        return []


def _extract_workdir(cmd: str) -> str:
    # Try to find D:\... or C:\... in the command line.
    match = re.search(r"([A-Za-z]:\\\\[^\"'\\s]+)", cmd)
    if match:
        return match.group(1).rstrip("\\")
    return ""


def _is_electron_helper(cmd: str) -> bool:
    """Filter out Electron/Chrome internal helper processes."""
    cl = cmd.lower()
    return "--type=" in cmd or "crashpad" in cl or "chrome_crashpad" in cl


def _is_shell_script(cmd: str) -> bool:
    """Filter out shell wrapper scripts."""
    cl = cmd.lower().strip()
    return cl.startswith("/bin/zsh") or cl.startswith("/bin/bash") or cl.startswith("/bin/sh") or cl.startswith("zsh ") or cl.startswith("bash ") or cl.startswith("sh ")


def _is_opencode_server(cmd: str) -> bool:
    """Check if this is the opencode server process (already tracked as fleet node)."""
    cl = cmd.lower()
    return "serve" in cl and "--port" in cl


def build_runagents() -> list[dict]:
    procs = list_processes()
    run_agents: list[dict] = []
    now = int(time.time() * 1000)

    # 1. Report cc-connect bridge process(es)
    for p in procs:
        if "cc-connect" not in p.cmd.lower():
            continue
        if _is_shell_script(p.cmd):
            continue
        match = re.search(r'--config\s+"?([^"\s]+)"?', p.cmd)
        work_dir = match.group(1) if match else "~/.cc-connect"
        run_agents.append(
            {
                "id": "run-cc-connect",
                "kind": "run",
                "label": "cc-connect · bridge",
                "pid": p.pid,
                "procCount": 1,
                "bridge": "cc-connect",
                "workDir": work_dir,
                "cpuSeconds": 0,
                "active": True,
                "busyCount": 0,
                "lastActivityAt": now,
                "activeDir": work_dir,
                "sessions": [],
            }
        )

    # 1.5 Report opencode run-mode workers spawned by cc-connect (child or grandchild,
    #     e.g. cc-connect -> cmd.exe -> opencode.exe run --session ses_xxx).
    cc_pids = {
        p.pid
        for p in procs
        if "cc-connect" in p.cmd.lower() and not _is_shell_script(p.cmd)
    }
    ppid_of = {p.pid: p.ppid for p in procs}
    seen_workers: set[str] = set()
    for p in procs:
        cl = p.cmd.lower()
        if "opencode" not in cl or " run " not in f" {cl} ":
            continue
        if _is_electron_helper(p.cmd) or _is_shell_script(p.cmd) or _is_opencode_server(p.cmd):
            continue
        # must descend from a cc-connect process (direct child or via a shell wrapper)
        parent = ppid_of.get(p.ppid)
        if p.ppid not in cc_pids and parent not in cc_pids:
            continue
        sid_match = re.search(r"--session\s+(\S+)", p.cmd)
        sid = sid_match.group(1) if sid_match else ""
        key = sid or str(p.pid)
        if key in seen_workers:
            continue
        seen_workers.add(key)
        run_agents.append(
            {
                "id": f"run-ccw-{key}",
                "kind": "run",
                "label": f"cc-connect · opencode run",
                "pid": p.pid,
                "procCount": 1,
                "bridge": "cc-connect",
                "workDir": _extract_workdir(p.cmd) or "~/.cc-connect",
                "cpuSeconds": 0,
                "active": True,
                "busyCount": 1 if sid else 0,
                "lastActivityAt": now,
                "activeDir": "",
                "sessions": [
                    {
                        "id": sid,
                        "title": "",
                        "directory": "",
                        "busy": True,
                        "updatedAt": now,
                        "cost": 0,
                        "tokens": {"input": 0, "output": 0},
                    }
                ]
                if sid
                else [],
            }
        )

    # 2. Report openclaw process(es)
    for p in procs:
        cl = p.cmd.lower()
        if "openclaw" not in cl or "--type=" in p.cmd:
            continue
        port_match = re.search(r'--port\s+(\d+)', p.cmd)
        port = port_match.group(1) if port_match else "?"
        run_agents.append(
            {
                "id": "run-openclaw",
                "kind": "run",
                "label": f"openclaw · :{port}",
                "pid": p.pid,
                "procCount": 1,
                "bridge": "openclaw",
                "workDir": "~/.openclaw",
                "cpuSeconds": 0,
                "active": True,
                "busyCount": 0,
                "lastActivityAt": now,
                "activeDir": "~/.openclaw",
                "sessions": [],
            }
        )

    # 3. Report opencode desktop app (main process only, skip helpers & server)
    seen_oc = False
    for p in procs:
        cl = p.cmd.lower()
        if "opencode" not in cl:
            continue
        if _is_electron_helper(p.cmd) or _is_shell_script(p.cmd):
            continue
        if _is_opencode_server(p.cmd):
            continue
        if "cc-connect" in cl or "openclaw" in cl:
            continue
        if seen_oc:
            continue
        seen_oc = True
        run_agents.append(
            {
                "id": "run-oc-desktop",
                "kind": "run",
                "label": "OpenCode · Desktop",
                "pid": p.pid,
                "procCount": 1,
                "bridge": "desktop",
                "workDir": "OpenCode Desktop",
                "cpuSeconds": 0,
                "active": True,
                "busyCount": 0,
                "lastActivityAt": now,
                "activeDir": "OpenCode Desktop",
                "sessions": [],
            }
        )

    return run_agents


def _debug_info() -> dict:
    procs = list_processes()
    cc_pids = {p.pid for p in procs if "cc-connect" in p.cmd.lower()}
    opencode_like = [p for p in procs if "opencode" in p.cmd.lower()]
    return {
        "platform": platform.system(),
        "totalProcesses": len(procs),
        "ccConnectPids": sorted(cc_pids)[:20],
        "opencodeLikeProcesses": [
            {"pid": p.pid, "ppid": p.ppid, "cmd": p.cmd[:200], "isHelper": _is_electron_helper(p.cmd), "isServer": _is_opencode_server(p.cmd)}
            for p in opencode_like
        ],
        "ccConnectLikeProcesses": [
            {"pid": p.pid, "ppid": p.ppid, "cmd": p.cmd[:200]}
            for p in procs
            if "cc-connect" in p.cmd.lower()
        ],
    }


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: ANN002
        # Suppress default access logging.
        pass

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/runagents":
            try:
                data = {"machine": platform.node(), "runAgents": build_runagents()}
                body = json.dumps(data, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return
        if self.path in ("/api/sessions", "/session", "/api/health", "/health"):
            body = b"[]" if self.path in ("/api/sessions", "/session") else b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/debug":
            try:
                body = json.dumps(_debug_info(), ensure_ascii=False, indent=2).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return
        body = b'{"ok":false}'
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class _Server(socketserver.TCPServer):
    allow_reuse_address = True


def run(*, port: int = 9099) -> None:
    with _Server(("0.0.0.0", port), Handler) as httpd:
        print(f"OpenCode Fleet sidecar listening on http://0.0.0.0:{port}/runagents")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down...")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OpenCode Fleet sidecar")
    parser.add_argument("--port", type=int, default=9099, help="Port to listen on (default: 9099)")
    args = parser.parse_args(argv)
    run(port=args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
