"""开机自启：macOS launchd / Windows 注册表 Run 项 / Linux systemd --user。

装完应用只要一条 `atrium autostart on`，之后开机会自动在后台起服务；
`atrium autostart status` 看状态，`atrium autostart off` 撤掉。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

LABEL = "ai.atrium.agent"
UNIT = "atrium.service"


def _python() -> str:
    """后台运行时优先用无窗口解释器（Windows 上 pythonw 不弹黑框）。"""
    exe = Path(sys.executable)
    if os.name == "nt":
        pyw = exe.with_name("pythonw.exe")
        if pyw.exists():
            return str(pyw)
    return str(exe)


def _args(port: int, home: Path) -> list[str]:
    return ["-m", "atrium", "--no-open", "--port", str(port), "--home", str(home)]


def _preflight() -> str | None:
    """自启前确认这个解释器能 import atrium —— 否则 launchd/注册表会静默失败、无限重启。"""
    py = _python()
    r = subprocess.run([py, "-c", "import atrium"], capture_output=True, text=True)
    if r.returncode != 0:
        return (
            f"该解释器里没有 atrium 模块：{py}\n"
            f"        请用装了这个包的解释器执行：确保 `atrium` 命令所在的 venv 是当前解释器，"
            f"或重装 pip install -U opencode-fleet-atrium"
        )
    return None


def _log_path(home: Path) -> Path:
    logs = home / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    return logs / "atrium.log"


# ---------------------------------------------------------------- macOS ----
def _plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def _mac_on(port: int, home: Path) -> str:
    from xml.sax.saxutils import escape

    argv = "".join(f"    <string>{escape(a)}</string>\n" for a in [_python(), *_args(port, home)])
    log = escape(str(_log_path(home)))
    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{argv}  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>{escape(os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"))}</string></dict>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"""
    p = _plist_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(plist, "utf-8")
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], capture_output=True)
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(p)], capture_output=True, text=True)
    if r.returncode != 0:
        r2 = subprocess.run(["launchctl", "load", "-w", str(p)], capture_output=True, text=True)
        if r2.returncode != 0:
            return f"写入 {p} 成功，但 launchctl 加载失败：{r.stderr.strip() or r2.stderr.strip()}"
    subprocess.run(["launchctl", "kickstart", "-k", f"gui/{uid}/{LABEL}"], capture_output=True)
    return f"已启用（launchd）· 配置 {p} · 日志 {_log_path(home)}"


def _mac_off() -> str:
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], capture_output=True)
    p = _plist_path()
    if p.exists():
        p.unlink()
        return "已停用并删除 launchd 配置"
    return "已停用（本来就没有配置）"


def _mac_status() -> str:
    p = _plist_path()
    if not p.exists():
        return "未启用"
    r = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], capture_output=True, text=True)
    if r.returncode == 0:
        state = "运行中" if "state = running" in r.stdout else "已加载"
        pid = ""
        for line in r.stdout.splitlines():
            if "pid = " in line:
                pid = " · pid" + line.split("pid =", 1)[1].strip().rstrip("}")
                break
        return f"{state}{pid}（launchd：{p}）"
    return f"已写配置但未加载（launchd：{p}）"


# -------------------------------------------------------------- Windows ----
_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def _win_cmd(port: int, home: Path) -> str:
    args = " ".join(f'"{a}"' if " " in a else a for a in _args(port, home))
    return f'"{_python()}" {args}'


def _win_on(port: int, home: Path) -> str:
    import winreg  # type: ignore

    # Run 键一般不缺，但用 CreateKeyEx 兜底，避免极端情况下直接抛异常
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, "Atrium", 0, winreg.REG_SZ, _win_cmd(port, home))
    return "已启用（当前用户登录自启）· 下次登录生效；想立刻生效直接跑 atrium"


def _win_off() -> str:
    import winreg  # type: ignore

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, "Atrium")
        return "已停用（已删除登录自启项）"
    except FileNotFoundError:
        return "已停用（本来就没有配置）"


def _win_status() -> str:
    import winreg  # type: ignore

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_READ) as k:
            v, _ = winreg.QueryValueEx(k, "Atrium")
            return f"已启用 · {v}"
    except FileNotFoundError:
        return "未启用"


# ---------------------------------------------------------------- Linux ----
def _unit_path() -> Path:
    return Path.home() / ".config" / "systemd" / "user" / UNIT


def _linux_on(port: int, home: Path) -> str:
    unit = f"""[Unit]
Description=Atrium fleet dashboard
After=network-online.target

[Service]
ExecStart={_python()} {' '.join(_args(port, home))}
Restart=on-failure
StandardOutput=append:{_log_path(home)}
StandardError=append:{_log_path(home)}

[Install]
WantedBy=default.target
"""
    p = _unit_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(unit, "utf-8")
    subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    r = subprocess.run(["systemctl", "--user", "enable", "--now", UNIT], capture_output=True, text=True)
    if r.returncode != 0:
        return f"写入 {p} 成功，但 systemctl 失败：{r.stderr.strip()}"
    return f"已启用（systemd --user）· 配置 {p}"


def _linux_off() -> str:
    subprocess.run(["systemctl", "--user", "disable", "--now", UNIT], capture_output=True)
    p = _unit_path()
    if p.exists():
        p.unlink()
    subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    return "已停用"


def _linux_status() -> str:
    r = subprocess.run(["systemctl", "--user", "is-active", UNIT], capture_output=True, text=True)
    state = r.stdout.strip() or "unknown"
    return f"{'运行中' if state == 'active' else state}（systemd --user：{_unit_path()}）"


# ------------------------------------------------------------------ API ----
def action(what: str, port: int, home: Path) -> str:
    if sys.platform == "darwin":
        on, off, status = _mac_on, _mac_off, _mac_status
    elif os.name == "nt":
        on, off, status = _win_on, _win_off, _win_status
    else:
        on, off, status = _linux_on, _linux_off, _linux_status
    if what == "on":
        err = _preflight()
        if err:
            return f"未启用：\n        {err}"
        return on(port, home)
    if what == "off":
        return off()
    return status()