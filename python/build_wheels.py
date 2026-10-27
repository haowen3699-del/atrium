#!/usr/bin/env python3
"""构建可发布的 atrium wheel（每个平台一个，内含 Node 运行时，装完即用）。

用法：
    python3 python/build_wheels.py                     # 自动判断本机平台 + 额外构建 Windows
    python3 python/build_wheels.py --targets mac-arm64,win-x64
    python3 python/build_wheels.py --no-fetch          # 用本机 node 作为运行时（仅本机平台可用）

产物在 python/pypi-dist/，上传：
    python3 -m twine upload python/pypi-dist/*.whl    # 公开 PyPI；镜像源可用 --repository <name>
"""
from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import time
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # 仓库根
PKG = ROOT / "python"                                   # Python 包目录
SRC = PKG / "src" / "atrium"
APP = SRC / "app"
RUNTIME = SRC / "runtime"
OUT = PKG / "pypi-dist"
NODE_VERSION = os.environ.get("NODE_VERSION", "24.19.0")

TARGETS = {
    # 名称: (node 包名, 运行时文件在包内的相对路径, wheel platform tag)
    "mac-arm64": ("darwin-arm64", "bin/node", "macosx_11_0_arm64"),
    "mac-x64": ("darwin-x64", "bin/node", "macosx_10_15_x86_64"),
    "win-x64": ("win-x64", "node.exe", "win_amd64"),
}
MIRRORS = [
    "https://nodejs.org/dist/v{v}/node-v{v}-{pkg}.{ext}",
    "https://registry.npmmirror.com/-/binary/node/v{v}/node-v{v}-{pkg}.{ext}",
]


def ensure_build_deps():
    """构建隔离环境会去公网拉 setuptools（内网可能打不通）→ 先确保当前解释器里有，再用 --no-isolation"""
    try:
        subprocess.run([sys.executable, "-c", "import setuptools, wheel"], check=True, capture_output=True)
        return
    except subprocess.CalledProcessError:
        print("  当前解释器缺 setuptools/wheel，从内网源安装…")
        run([sys.executable, "-m", "pip", "install", "-q", "setuptools", "wheel",
             "--index-url", os.environ.get("ATRIUM_BUILD_PYPI", "https://pypi.org/simple")])


def run(cmd: list[str], cwd: Path | None = None, check: bool = True):
    print("  $", " ".join(str(c) for c in cmd))
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=check)


def host_target() -> str | None:
    m = platform.machine().lower()
    if sys.platform == "darwin":
        return "mac-arm64" if m in ("arm64", "aarch64") else "mac-x64"
    if sys.platform == "win32":
        return "win-x64"
    return None


def build_web_and_server():
    print("[1/4] 构建前端 + 服务端单文件")
    npm = "npm.cmd" if os.name == "nt" else "npm"
    run([npm, "run", "build"], cwd=ROOT)
    esbuild_bin = str(ROOT / "node_modules/.bin/esbuild")
    if os.name == "nt":
        esbuild_bin += ".cmd"
    run([
        esbuild_bin, "src/index.ts",
        "--bundle", "--platform=node", "--format=esm", "--target=node20",
        "--outfile=dist/atrium.mjs", "--banner:js=#!/usr/bin/env node",
    ], cwd=ROOT)


def stage_app():
    print("[2/4] 收集包内资源（mjs + web/dist）")
    if APP.exists():
        shutil.rmtree(APP)
    APP.mkdir(parents=True)
    shutil.copy2(ROOT / "dist" / "atrium.mjs", APP / "atrium.mjs")
    shutil.copytree(ROOT / "web" / "dist", APP / "web")


def runtime_from_existing_wheel(target: str, dest: Path) -> bool:
    """兜底：从已经构建过的同平台 wheel 里把运行时取出来复用（官网抽风/离线时救命）。"""
    _, inner, plat = TARGETS[target]
    exe = "node.exe" if target == "win-x64" else "node"
    for whl in sorted(OUT.glob(f"*{plat}*.whl"), reverse=True):
        try:
            with zipfile.ZipFile(whl) as z:
                name = next(n for n in z.namelist() if n.endswith("runtime/" + exe))
                with z.open(name) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
            dest.chmod(0o755)
            print(f"  复用 {whl.name} 里的 {exe}")
            return True
        except Exception:
            continue
    return False


def fetch_node(target: str, dest: Path, attempts: int = 3) -> Path:
    """下载对应平台的 node 运行时，取出单个可执行文件（下载可能被截断，重试几次）。"""
    last: Exception | None = None
    for i in range(attempts):
        try:
            return _fetch_node_once(target, dest)
        except Exception as e:
            last = e
            print(f"  第 {i + 1} 次下载/解压失败：{e}，重试…")
            time.sleep(2)
    if runtime_from_existing_wheel(target, dest):
        return dest
    raise SystemExit(f"下载 node 运行时失败，且历史 wheel 里也没找到可复用的：{last}")


def _fetch_node_once(target: str, dest: Path) -> Path:
    pkg, inner, _ = TARGETS[target]
    ext = "zip" if pkg.startswith("win") else "tar.gz"
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        archive = tmp / f"node.{ext}"
        last_err: Exception | None = None
        for tpl in MIRRORS:
            url = tpl.format(v=NODE_VERSION, pkg=pkg, ext=ext)
            try:
                print(f"  下载 {url}")
                with urllib.request.urlopen(url, timeout=120) as r, open(archive, "wb") as f:
                    shutil.copyfileobj(r, f)
                last_err = None
                break
            except Exception as e:  # 换镜像
                last_err = e
                print(f"  失败：{e}")
        if last_err:
            raise RuntimeError(f"下载 node 失败：{last_err}")
        if ext == "zip":
            with zipfile.ZipFile(archive) as z:
                name = next(n for n in z.namelist() if n.endswith(inner))
                with z.open(name) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
        else:
            with tarfile.open(archive) as t:
                name = next(m for m in t.getmembers() if m.name.endswith(inner) and m.isfile())
                with t.extractfile(name) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
    dest.chmod(0o755)
    return dest


def stage_node(target: str, no_fetch: bool):
    if RUNTIME.exists():
        shutil.rmtree(RUNTIME)
    RUNTIME.mkdir(parents=True)
    exe = "node.exe" if target == "win-x64" else "node"
    dest = RUNTIME / exe
    if no_fetch and target == host_target():
        local = shutil.which("node")
        if not local:
            raise SystemExit("--no-fetch 需要本机有 node")
        shutil.copy2(local, dest)
        dest.chmod(0o755)
        print(f"  使用本机 node：{local}")
        return
    fetch_node(target, dest)


def build_wheel(target: str) -> Path:
    _, _, plat = TARGETS[target]
    print(f"[3/4] 构建 {target} wheel（platform={plat}）")
    OUT.mkdir(parents=True, exist_ok=True)
    # 关键：setuptools 不会清理 build/lib 里的陈旧文件，不清就会把上一个平台的
    # 运行时（如 node.exe）带进这个平台的 wheel 里
    shutil.rmtree(PKG / "build", ignore_errors=True)
    for egg in (PKG / "src").glob("*.egg-info"):
        shutil.rmtree(egg, ignore_errors=True)
    # 每个平台在独立目录里构建再搬过来：避免 glob 到历史版本的同平台 wheel
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        ensure_build_deps()
        run([sys.executable, "-m", "build", "--wheel", "--no-isolation", "--outdir", str(tmp)], cwd=PKG)
        raw = next(tmp.glob("*py3-none-any.whl"))
        run([sys.executable, "-m", "wheel", "tags", "--python-tag", "py3", "--abi-tag", "none",
             "--platform-tag", plat, "--remove", str(raw)])
        tagged = next(tmp.glob(f"*{plat}*.whl"))
        dest = OUT / tagged.name
        if dest.exists():
            dest.unlink()
        shutil.move(str(tagged), str(dest))
    print(f"  产物 {dest.name}  {dest.stat().st_size / 1048576:.1f} MB")
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--targets", default=None, help="逗号分隔：mac-arm64,mac-x64,win-x64")
    ap.add_argument("--no-fetch", action="store_true", help="仅本机平台，用系统 node，不下载")
    ap.add_argument("--keep", action="store_true", help="保留暂存的运行时/资源，便于排查")
    a = ap.parse_args()

    if a.targets:
        targets = [t.strip() for t in a.targets.split(",") if t.strip()]
    else:
        h = host_target()
        targets = [h] if h else []
        if h != "win-x64":
            targets.append("win-x64")
    for t in targets:
        if t not in TARGETS:
            raise SystemExit(f"未知目标 {t}，可选：{', '.join(TARGETS)}")

    build_web_and_server()
    stage_app()
    made = []
    for t in targets:
        stage_node(t, a.no_fetch)
        made.append(build_wheel(t))
    if not a.keep:
        shutil.rmtree(RUNTIME, ignore_errors=True)
        shutil.rmtree(APP, ignore_errors=True)
    print("[4/4] 完成：")
    for m in made:
        print("  ", m)
    print("\n上传（内网 pypi）：")
    print(f"  python3 -m twine upload --repository nexus --config-file {ROOT}/opencode_fleet_sidecar/.pypirc {OUT}/*.whl")


if __name__ == "__main__":
    main()