#!/usr/bin/env python3
import argparse
import io
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path

DEFAULT_BUILD_SERVER = "hkserver"
DEFAULT_ROUTER = "router0"
DEFAULT_SDK_DIR = "/root/openwrt-sdk-25.12.5-mediatek-filogic_gcc-14.3.0_musl.Linux-x86_64"
PACKAGE_NAME = "luci-theme-round"

EXCLUDE_DIRS = {
    ".git",
    ".github",
    "preview",
    "dist",
    "__pycache__",
    ".vscode",
    ".idea",
}

EXCLUDE_FILES = {
    "deploy.py",
    "build_and_install.py",
    ".DS_Store",
}


def log(msg: str):
    print(f"[*] {msg}")


def error(msg: str):
    print(f"[!] Error: {msg}", file=sys.stderr)
    sys.exit(1)


def bump_release(repo_dir: Path):
    makefile_path = repo_dir / "Makefile"
    if not makefile_path.exists():
        error(f"Makefile not found at {makefile_path}")

    content = makefile_path.read_text(encoding="utf-8")
    m = re.search(r"PKG_RELEASE:=(\d+)", content)
    if not m:
        error("PKG_RELEASE not found in Makefile")

    cur_rel = int(m.group(1))
    new_rel = cur_rel + 1
    new_content = re.sub(
        r"PKG_RELEASE:=\d+", f"PKG_RELEASE:={new_rel}", content, count=1
    )
    makefile_path.write_text(new_content, encoding="utf-8")
    log(f"Bumped PKG_RELEASE: {cur_rel} -> {new_rel}")


def create_tar_stream(repo_dir: Path) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for root, dirs, files in os.walk(repo_dir):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for file in files:
                if file in EXCLUDE_FILES or file.endswith((".pyc", ".apk", ".ipk")):
                    continue
                file_path = Path(root) / file
                rel_path = file_path.relative_to(repo_dir)
                tar.add(file_path, arcname=str(rel_path).replace("\\", "/"))
    return buf.getvalue()


def sync_local_to_server(build_server: str, sdk_dir: str, repo_dir: Path):
    target_dir = f"{sdk_dir}/package/{PACKAGE_NAME}"
    log(f"Syncing local files to {build_server}:{target_dir} ...")

    tar_bytes = create_tar_stream(repo_dir)
    remote_cmd = (
        f"rm -rf '{target_dir}' && "
        f"mkdir -p '{target_dir}' && "
        f"tar -xzf - -C '{target_dir}'"
    )

    proc = subprocess.run(
        ["ssh", build_server, remote_cmd],
        input=tar_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        error(f"Failed to sync files to build server:\n{proc.stderr.decode('utf-8', errors='ignore')}")
    log("Files synced successfully.")


def sync_via_git(build_server: str, sdk_dir: str):
    target_dir = f"{sdk_dir}/package/{PACKAGE_NAME}"
    log(f"Pulling latest git commits on {build_server}:{target_dir} ...")
    cmd = (
        f"if [ -d '{target_dir}/.git' ]; then "
        f"  cd '{target_dir}' && git fetch origin && git reset --hard origin/master; "
        f"else "
        f"  rm -rf '{target_dir}' && git clone https://github.com/CyL-Cly/luci-theme-round.git '{target_dir}'; "
        f"fi"
    )
    res = subprocess.run(["ssh", build_server, cmd])
    if res.returncode != 0:
        error("Git sync on build server failed.")


def build_package(build_server: str, sdk_dir: str) -> str:
    log(f"Building {PACKAGE_NAME} on {build_server} ...")
    compile_cmd = f"cd '{sdk_dir}' && make package/{PACKAGE_NAME}/compile V=s"
    res = subprocess.run(["ssh", build_server, compile_cmd])
    if res.returncode != 0:
        error("Compilation failed on build server.")

    find_cmd = (
        f"find '{sdk_dir}/bin/packages' -type f -name '*{PACKAGE_NAME}*.apk' 2>/dev/null "
        f"| sort -V | tail -n 1"
    )
    proc = subprocess.run(
        ["ssh", build_server, find_cmd],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    apk_path = proc.stdout.strip()
    if not apk_path:
        error("Build finished but no .apk package found.")

    log(f"Found compiled package: {apk_path}")
    return apk_path


def install_to_router(build_server: str, router: str, apk_path: str):
    log(f"Streaming package from {build_server} and installing to {router} ...")

    cat_proc = subprocess.Popen(
        ["ssh", build_server, f"cat '{apk_path}'"],
        stdout=subprocess.PIPE,
    )

    install_cmd = (
        "cat > /tmp/luci-theme-round.apk && "
        "apk add --allow-untrusted --clean-protected --upgrade /tmp/luci-theme-round.apk && "
        "rm -f /tmp/luci-theme-round.apk"
    )

    install_proc = subprocess.run(
        ["ssh", router, install_cmd],
        stdin=cat_proc.stdout,
        text=True,
    )
    cat_proc.stdout.close()
    cat_proc.wait()

    if install_proc.returncode != 0:
        error("Installation on router failed.")

    log("Package installed successfully on router.")


def main():
    parser = argparse.ArgumentParser(
        description="One-click build and install luci-theme-round package."
    )
    parser.add_argument(
        "--build-server",
        default=DEFAULT_BUILD_SERVER,
        help=f"Build server SSH host (default: {DEFAULT_BUILD_SERVER})",
    )
    parser.add_argument(
        "--router",
        default=DEFAULT_ROUTER,
        help=f"Router SSH host (default: {DEFAULT_ROUTER})",
    )
    parser.add_argument(
        "--sdk-dir",
        default=DEFAULT_SDK_DIR,
        help=f"OpenWrt SDK directory on build server (default: {DEFAULT_SDK_DIR})",
    )
    parser.add_argument(
        "--git",
        action="store_true",
        help="Sync via git on build server instead of streaming local workspace files",
    )
    parser.add_argument(
        "--bump",
        action="store_true",
        help="Auto-bump PKG_RELEASE in Makefile before building",
    )
    parser.add_argument(
        "--build-only",
        action="store_true",
        help="Only build on server, do not deploy to router",
    )
    parser.add_argument(
        "--install-only",
        action="store_true",
        help="Skip build, only install existing apk from build server to router",
    )

    args = parser.parse_args()
    repo_dir = Path(__file__).resolve().parent

    if args.bump:
        bump_release(repo_dir)

    apk_path = None
    if not args.install_only:
        if args.git:
            sync_via_git(args.build_server, args.sdk_dir)
        else:
            sync_local_to_server(args.build_server, args.sdk_dir, repo_dir)

        apk_path = build_package(args.build_server, args.sdk_dir)
    else:
        find_cmd = (
            f"find '{args.sdk_dir}/bin/packages' -type f -name '*{PACKAGE_NAME}*.apk' 2>/dev/null "
            f"| sort -V | tail -n 1"
        )
        proc = subprocess.run(
            ["ssh", args.build_server, find_cmd],
            stdout=subprocess.PIPE,
            text=True,
        )
        apk_path = proc.stdout.strip()
        if not apk_path:
            error("No existing apk found on build server.")
        log(f"Using existing package: {apk_path}")

    if not args.build_only and apk_path:
        install_to_router(args.build_server, args.router, apk_path)

    log("All tasks completed.")


if __name__ == "__main__":
    main()
