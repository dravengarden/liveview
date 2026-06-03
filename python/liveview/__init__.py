import os
import platform
import stat
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import requests

REPO = "dravengarden/liveview"
VERSION = "0.1.0"


def get_platform_target():
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "linux" and machine in ("x86_64", "amd64"):
        return "x86_64-unknown-linux-gnu"
    elif system == "darwin" and machine in ("x86_64", "amd64"):
        return "x86_64-apple-darwin"
    elif system == "darwin" and machine == "arm64":
        return "aarch64-apple-darwin"
    elif system == "windows" and machine in ("x86_64", "amd64"):
        return "x86_64-pc-windows-msvc"

    raise RuntimeError(f"Unsupported platform: {system}-{machine}")


def get_bin_dir():
    return Path(__file__).parent / "bin"


def get_bin_path():
    bin_name = "liveview.exe" if platform.system() == "Windows" else "liveview"
    return get_bin_dir() / bin_name


def download_binary():
    target = get_platform_target()
    is_windows = platform.system() == "Windows"
    ext = "zip" if is_windows else "tar.gz"

    url = f"https://github.com/{REPO}/releases/download/v{VERSION}/liveview-{target}.{ext}"
    bin_dir = get_bin_dir()
    bin_dir.mkdir(parents=True, exist_ok=True)

    archive_path = bin_dir / f"liveview-{target}.{ext}"

    print(f"Downloading liveview v{VERSION} for {target}...")

    response = requests.get(url, stream=True, allow_redirects=True)
    response.raise_for_status()

    with open(archive_path, "wb") as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)

    print("Extracting...")

    if is_windows:
        with zipfile.ZipFile(archive_path, "r") as z:
            z.extractall(bin_dir)
    else:
        with tarfile.open(archive_path, "r:gz") as t:
            t.extractall(bin_dir)

    bin_path = get_bin_path()
    if not is_windows:
        bin_path.chmod(bin_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    archive_path.unlink()
    print("liveview installed successfully!")


def ensure_binary():
    bin_path = get_bin_path()
    if not bin_path.exists():
        download_binary()
    return bin_path


def main():
    bin_path = ensure_binary()
    result = subprocess.run([str(bin_path)] + sys.argv[1:])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
