"""启动器：找到 Node 运行时 → 拉起打包好的服务 → 打印地址/密钥 → 打开浏览器。

pip 装完直接 `atrium` 就能用：不需要目标机预装 Node（包内自带运行时），
不需要 sidecar，不需要手写配置（首次运行自动生成 ~/.atrium/config.json）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from . import __version__
from . import autostart

APP_DIR = Path(__file__).resolve().parent / "app"


def pkg_dir() -> Path:
    return Path(__file__).resolve().parent


def default_home() -> Path:
    if os.environ.get("ATRIUM_HOME"):
        return Path(os.environ["ATRIUM_HOME"]).expanduser()
    if os.name == "nt":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "atrium"
    return Path.home() / ".atrium"


def find_node() -> tuple[str | None, str]:
    """返回 (node 路径, 来源说明)。优先级：显式环境变量 > 包内运行时 > PATH。"""
    env = os.environ.get("ATRIUM_NODE")
    if env and Path(env).exists():
        return env, "ATRIUM_NODE"
    exe = "node.exe" if os.name == "nt" else "node"
    bundled = pkg_dir() / "runtime" / exe
    if bundled.exists():
        try:
            os.chmod(bundled, 0o755)
        except OSError:
            pass
        return str(bundled), "内置运行时"
    found = shutil.which("node")
    if found:
        return found, "系统 PATH"
    # launchd / systemd 的 PATH 很干净，常见位置也找一遍
    cands: list[Path] = []
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA", "") + "\\Programs", os.environ.get("APPDATA", "") + "\\nvm"):
            if base:
                cands.append(Path(base) / "nodejs" / "node.exe")
                cands += sorted((Path(base) / "nodejs").glob("*/node.exe"), reverse=True)
        cands += sorted((Path.home() / "scoop" / "apps" / "nodejs").glob("*/node.exe"), reverse=True)
        cands += [Path("C:/Program Files/nodejs/node.exe")]
    else:
        cands += [Path("/opt/homebrew/bin/node"), Path("/usr/local/bin/node"), Path("/usr/bin/node")]
        cands += sorted((Path.home() / ".nvm" / "versions" / "node").glob("*/bin/node"), reverse=True)
        cands += [Path.home() / ".local/node/bin/node", Path.home() / ".volta/bin/node", Path.home() / ".bun/bin/node"]
    for c in cands:
        if c.exists():
            return str(c), f"常见位置 {c}"
    return None, ""


def node_version(node: str) -> tuple[int, int]:
    try:
        out = subprocess.run([node, "-v"], capture_output=True, text=True, timeout=10).stdout.strip()
        m = re.match(r"v(\d+)\.(\d+)", out)
        if m:
            return int(m.group(1)), int(m.group(2))
    except Exception:
        pass
    return (0, 0)


def _bindable(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            # 必须 SO_REUSEADDR：否则刚关闭实例留下的 TIME_WAIT 会被误判为占用
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def free_port(preferred: int, wait_seconds: float = 30.0) -> int:
    """选端口：首选端口先等一会儿（升级/重启时旧进程与端口可能还没释放干净），
    等不到再往后顺延 25 个端口；等待与顺延都会打日志，避免"莫名跑到别的端口"。"""
    deadline = time.time() + wait_seconds
    waited = False
    while time.time() < deadline:
        if _bindable(preferred):
            if waited:
                print(f"[atrium] 端口 {preferred} 已释放，使用它")
            return preferred
        if not waited:
            print(f"[atrium] 端口 {preferred} 暂时被占用，最多等 {int(wait_seconds)} 秒…")
            waited = True
        time.sleep(0.5)
    for cand in range(preferred + 1, preferred + 26):
        if _bindable(cand):
            print(f"[atrium] 端口 {preferred} 一直没释放，改用 {cand}")
            return cand
    return preferred


def lan_ip() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def wait_ready(port: int, proc: subprocess.Popen, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/api/node-info"
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=1.5) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.35)
    return False


def write_runtime(home: Path, port: int) -> None:
    """记录实际监听端口，供 `atrium info` / 帮助面板读取（自启时终端看不到输出）"""
    try:
        ip = lan_ip()
        payload = {
            "port": port,
            "localUrl": f"http://127.0.0.1:{port}/",
            "lanUrl": f"http://{ip}:{port}/" if ip else None,
            "pid": os.getpid(),
            "version": __version__,
            "python": sys.executable,
            "startedAt": int(time.time() * 1000),
        }
        home.mkdir(parents=True, exist_ok=True)
        (home / "runtime.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
    except Exception:
        pass


def read_runtime(home: Path) -> dict:
    try:
        return json.loads((home / "runtime.json").read_text("utf-8"))
    except Exception:
        return {}


def read_config(home: Path) -> dict:
    try:
        return json.loads((home / "config.json").read_text("utf-8"))
    except Exception:
        return {}


def read_key(home: Path) -> str | None:
    try:
        cfg = json.loads((home / "config.json").read_text("utf-8"))
        return cfg.get("key")
    except Exception:
        return None


def cmd_autostart(args, home: Path) -> int:
    what = args.action or "status"
    port = args.port if args.port else int(os.environ.get("ATRIUM_PORT", 6080))
    msg = autostart.action(what, port, home)
    print(f"[atrium] 开机自启：{msg}")
    if what == "on":
        # 等它真的起来，把地址和密钥直接告诉你（自启模式下不开浏览器，必须主动提示）
        print("[atrium] 正在等待服务就绪…")
        if wait_port(port, 25.0):
            write_runtime(home, port)
            print_banner(port, home, autostart=True)
        else:
            print(f"[atrium] 暂时没等到服务（可能还在启动）。稍后用 `atrium info` 查看地址，或看日志 {home / 'logs' / 'atrium.log'}")
    return 0


def wait_port(port: int, timeout: float) -> bool:
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/api/node-info"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.5) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def print_banner(port: int, home: Path, autostart: bool = False) -> None:
    key = read_key(home)
    ip = lan_ip()
    print("", flush=True)
    print(f"[atrium] 本机看板   http://127.0.0.1:{port}/", flush=True)
    if ip:
        print(f"[atrium] 局域网访问 http://{ip}:{port}/  （首次需填团队密钥）", flush=True)
    if key:
        print(f"[atrium] 团队密钥   {key}", flush=True)
    print(f"[atrium] 数据目录   {home}（配置 config.json / 日志 logs/atrium.log）", flush=True)
    if autostart:
        print("[atrium] 已交给开机自启托管：以后开机自动在后台运行，随时 `atrium info` 看地址", flush=True)
    print("", flush=True)


def server_info(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/node-info", timeout=2) as r:
            if r.status != 200:
                return None
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def cmd_info(args, home: Path) -> int:
    rt = read_runtime(home)
    cfg = read_config(home)
    port = int(rt.get("port") or cfg.get("port") or args.port or 6080)
    info = server_info(port)
    # 必须按实例 id 认领：同一个端口上可能是"别的数据目录"的实例
    alive = bool(info) and bool(cfg.get("id")) and info.get("id") == cfg.get("id")
    never_ran = not rt and not cfg
    auto = {}
    try:
        auto = json.loads((home / "autostart.json").read_text("utf-8"))
    except Exception:
        auto = {}
    print(f"[atrium] 版本     {__version__}")
    print(f"[atrium] 运行状态 {'运行中' if alive else '未在运行'}" + (f"（端口 {port}）" if alive else ""))
    if alive:
        print_banner(port, home, autostart=bool(auto.get("enabled")))
    else:
        print(f"[atrium] 数据目录 {home}")
        if never_ran:
            print("[atrium] 状态     本数据目录还没有运行过实例")
        if info:
            print(f"[atrium] 注意     端口 {port} 上是另一个实例（{info.get('label')} / {info.get('id')}），不是本目录的")
        print("[atrium] 启动方式  `atrium`（前台）或 `atrium autostart on`（开机自启）")
    if auto.get("enabled"):
        print(f"[atrium] 开机自启 已启用（{auto.get('kind')}，端口 {auto.get('port')}）；`atrium autostart off` 可关闭")
    return 0 if alive else 1


def cmd_report_local_server(args, home: Path) -> int:
    """把当前进程环境里的 OpenCode server 密码上报给本机 hub。

    用途：OpenCode 桌面版每次重启都会重新生成密码，且密码只存在于桌面版启动的
    进程环境里（launchd 服务读不到）。在桌面版环境里跑本命令，读自己的
    OPENCODE_SERVER_PASSWORD 并 POST 给 hub，hub 验证后落盘 + 同步全队 + 自动纳入节点。
    """
    from urllib.error import URLError

    username = os.environ.get("OPENCODE_SERVER_USERNAME") or "opencode"
    password = os.environ.get("OPENCODE_SERVER_PASSWORD") or ""
    if not password:
        print("[atrium] 当前环境没有 OPENCODE_SERVER_PASSWORD（请从 OpenCode 桌面版/其终端里运行本命令）", file=sys.stderr)
        return 1
    rt = read_runtime(home)
    cfg = read_config(home)
    port = int(args.port or rt.get("port") or cfg.get("port") or 6080)
    url = f"http://127.0.0.1:{port}/api/local-opencode/report"
    body = json.dumps({"username": username, "password": password}).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"}, method="POST")
        resp = json.loads(urllib.request.urlopen(req, timeout=8).read().decode("utf-8"))
    except URLError as e:
        print(f"[atrium] 上报失败：连不上本机 hub（端口 {port}，请先启动 atrium）：{e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"[atrium] 上报失败：{e}", file=sys.stderr)
        return 1
    if resp.get("ok"):
        rec = resp.get("recovered") or {}
        print(f"[atrium] 已上报并纳入本机 opencode server（端口 {rec.get('port')}）")
        return 0
    print(f"[atrium] 上报未生效：{resp.get('error', '未知错误')}", file=sys.stderr)
    return 1


def cmd_init_opencode_hook(args, home: Path) -> int:
    """初始化 opencode AI 上报钩子：往 ~/.config/opencode/AGENTS.md 写入自检指令块。
    之后 opencode AI 每次开工会自动把本机 OpenCode server 密码上报给 atrium。"""
    from urllib.error import URLError

    enable = getattr(args, "disable", None) is not True
    rt = read_runtime(home)
    cfg = read_config(home)
    port = int(getattr(args, "port", None) or rt.get("port") or cfg.get("port") or 6080)
    url = f"http://127.0.0.1:{port}/api/local-opencode/hook"
    body = json.dumps({"enabled": enable}).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"}, method="POST")
        resp = json.loads(urllib.request.urlopen(req, timeout=8).read().decode("utf-8"))
    except URLError as e:
        print(f"[atrium] 初始化失败：连不上本机 hub（端口 {port}）：{e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"[atrium] 初始化失败：{e}", file=sys.stderr)
        return 1
    if resp.get("ok"):
        print(f"[atrium] {'已启用' if enable else '已停用'} opencode AI 自动上报钩子 → {resp.get('path')}")
        return 0
    print(f"[atrium] 初始化未生效：{resp.get('error', '未知错误')}", file=sys.stderr)
    return 1


def cmd_init_opencode_plugin(args, home: Path) -> int:
    """安装/卸载 opencode 自动上报插件（最稳定：opencode server 每次启动自动把本机密码上报给 atrium）。"""
    from urllib.error import URLError

    enable = getattr(args, "disable", None) is not True
    rt = read_runtime(home)
    cfg = read_config(home)
    port = int(getattr(args, "port", None) or rt.get("port") or cfg.get("port") or 6080)
    url = f"http://127.0.0.1:{port}/api/local-opencode/plugin"
    body = json.dumps({"enabled": enable}).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"}, method="POST")
        resp = json.loads(urllib.request.urlopen(req, timeout=8).read().decode("utf-8"))
    except URLError as e:
        print(f"[atrium] 安装失败：连不上本机 hub（端口 {port}）：{e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"[atrium] 安装失败：{e}", file=sys.stderr)
        return 1
    if resp.get("ok"):
        print(f"[atrium] {'已安装' if enable else '已卸载'} opencode 自动上报插件 → {resp.get('plugin')}")
        return 0
    print(f"[atrium] 安装未生效：{resp.get('error', '未知错误')}", file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="atrium", description="Atrium 机队看板：一个包，装完即用")
    sub = p.add_subparsers(dest="cmd")
    a = sub.add_parser("autostart", help="开机自启：on / off / status")
    a.add_argument("action", nargs="?", choices=["on", "off", "status"], default="status")
    a.add_argument("--port", type=int, default=None, help="自启时使用的端口（默认 6080）")
    sub.add_parser("info", help="查看运行状态 / 访问地址 / 团队密钥（自启模式下用它）")
    r = sub.add_parser("report-local-server", help="把环境里的 OpenCode server 密码上报给本机 hub（桌面版环境里运行）")
    r.add_argument("--port", type=int, default=None, help="hub 端口（默认读 runtime.json/config，再默认 6080）")
    h = sub.add_parser("init-opencode-hook", help="初始化 opencode AI 自动上报钩子（写 ~/.config/opencode/AGENTS.md）")
    h.add_argument("--port", type=int, default=None, help="hub 端口（默认读 runtime.json/config，再默认 6080）")
    h.add_argument("--disable", action="store_true", help="移除该钩子")
    g = sub.add_parser("init-opencode-plugin", help="安装 opencode 自动上报插件（最稳定：server 每次启动自动上报）")
    g.add_argument("--port", type=int, default=None, help="hub 端口（默认读 runtime.json/config，再默认 6080）")
    g.add_argument("--disable", action="store_true", help="卸载该插件")
    p.add_argument("--port", type=int, default=int(os.environ.get("ATRIUM_PORT", 6080)), help="监听端口（默认 6080，占用则自动往下找）")
    p.add_argument("--home", default=None, help="数据/配置目录（默认 ~/.atrium 或 %%APPDATA%%\\atrium）")
    p.add_argument("--config", default=None, help="直接指定配置文件路径")
    p.add_argument("--no-open", action="store_true", help="不要自动打开浏览器")
    p.add_argument("--print-key", action="store_true", help="只打印团队密钥后退出")
    p.add_argument("--version", "-V", action="store_true", help="打印版本")
    return p


def main(argv: list[str] | None = None) -> int:
    # Windows 控制台代码页可能不是 UTF-8：中文输出宁可显示成问号也不要抛 UnicodeEncodeError
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass
    args = build_parser().parse_args(argv)
    home = Path(args.home).expanduser() if args.home else default_home()

    if args.cmd == "autostart":
        return cmd_autostart(args, home)
    if args.cmd == "info":
        return cmd_info(args, home)
    if args.cmd == "report-local-server":
        return cmd_report_local_server(args, home)
    if args.cmd == "init-opencode-hook":
        return cmd_init_opencode_hook(args, home)
    if args.cmd == "init-opencode-plugin":
        return cmd_init_opencode_plugin(args, home)

    if args.version:
        print(f"atrium {__version__}")
        return 0
    if args.print_key:
        key = read_key(home)
        print(key or "(尚未生成：先启动一次 atrium)")
        return 0

    node, source = find_node()
    if not node:
        print("[atrium] 找不到 Node 运行时。三种解法任选其一：", file=sys.stderr)
        print("  1) 装 Node 20+（https://nodejs.org）后重跑", file=sys.stderr)
        print("  2) 安装带内置运行时的平台包：pip install -U opencode-fleet-atrium", file=sys.stderr)
        print("  3) 指定已有 node：ATRIUM_NODE=/path/to/node atrium", file=sys.stderr)
        return 2
    major, minor = node_version(node)
    if major and major < 20:
        print(f"[atrium] Node 版本过低（v{major}.{minor}），需要 20+：{node}", file=sys.stderr)
        return 2

    script = APP_DIR / "atrium.mjs"
    web = APP_DIR / "web"
    if not script.exists():
        print(f"[atrium] 安装不完整，缺少 {script}", file=sys.stderr)
        return 2

    port = free_port(args.port)
    if port != args.port:
        print(f"[atrium] 端口 {args.port} 被占用，改用 {port}")

    env = os.environ.copy()
    env["ATRIUM_WEB_ROOT"] = str(web)
    # 优先用 pip 包元数据的版本（importlib.metadata），避免发版时 pyproject 与 __init__ 不同步
    # 导致 hub 版本号停在旧值、hasUpdate 永远为真、autoUpgrade 无限升级弹窗
    try:
        from importlib.metadata import version as _pkg_version
        env["ATRIUM_VERSION"] = _pkg_version("opencode-fleet-atrium")
    except Exception:
        env["ATRIUM_VERSION"] = __version__
    env["ATRIUM_PORT"] = str(port)
    env["ATRIUM_HOME"] = str(home)
    env["ATRIUM_PYTHON"] = sys.executable
    env["ATRIUM_CLI"] = " ".join([shutil.which("atrium") or "atrium"])
    if args.config:
        env["ATRIUM_CONFIG"] = str(Path(args.config).expanduser())

    print(f"[atrium] 运行时 {node}（{source}）· 数据目录 {home}")
    proc = subprocess.Popen([node, str(script)], env=env, cwd=str(Path.home()), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    stopping = {"v": False}

    def shutdown(signum=None, frame=None):
        if stopping["v"]:
            return
        stopping["v"] = True
        try:
            proc.terminate()
        except Exception:
            pass

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, shutdown)
        except Exception:
            pass

    try:
        if not wait_ready(port, proc):
            rc = proc.poll()
            if rc is None:
                print("[atrium] 服务启动超时，请看上面日志", file=sys.stderr)
                shutdown()
            return rc if rc is not None else 1

        write_runtime(home, port)
        print_banner(port, home)
        print("[atrium]          其它机器装同一个包，把上面密钥在「组网」里填一次即可互通；Ctrl+C 结束", flush=True)
        if not args.no_open:
            try:
                import webbrowser

                webbrowser.open(url)
            except Exception:
                pass
        # watchdog：node 崩溃（非手动 Ctrl+C）自动重启，避免服务挂了要手动拉起
        crashes = 0
        while True:
            proc.wait()
            if stopping["v"]:
                return proc.returncode or 0
            crashes += 1
            if crashes > 5:
                print(f"[atrium] hub 多次崩溃（{crashes}次）后退出，请手动 `atrium` 重启", file=sys.stderr)
                return proc.returncode or 1
            print(f"[atrium] hub 进程异常退出（rc={proc.returncode}），3s 后自动重启（第 {crashes} 次）…", file=sys.stderr)
            time.sleep(3)
            proc = subprocess.Popen([node, str(script)], env=env, cwd=str(Path.home()), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if not wait_ready(port, proc):
                continue
            print("[atrium] hub 已自动重启恢复", flush=True)
    finally:
        if proc.poll() is None:
            shutdown()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())