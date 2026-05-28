#!/usr/bin/env python3
"""Create local fake GitHub-release assets for server update testing."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="fake stable release version, e.g. 9.9.9")
    parser.add_argument("--output", default=".local/update-test-release", help="output directory")
    parser.add_argument("--base-url", default="http://127.0.0.1:8765", help="URL used in latest.json asset links")
    args = parser.parse_args()

    if not __import__("re").fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version):
        raise SystemExit("version must be stable SemVer, e.g. 9.9.9")

    out = Path(args.output).resolve()
    pkg_root = out / "pkg-root"
    debian = pkg_root / "DEBIAN"
    if out.exists():
        shutil.rmtree(out)
    debian.mkdir(parents=True)
    (debian / "control").write_text(
        f"""Package: nia-todo
Version: {args.version}
Section: web
Priority: optional
Architecture: all
Maintainer: nia-todo test
Description: nia-todo fake update package for local dry-run tests
""",
        encoding="utf-8",
    )
    (pkg_root / "opt" / "nia-todo-test").mkdir(parents=True)
    (pkg_root / "opt" / "nia-todo-test" / "README.txt").write_text("fake update package\n", encoding="utf-8")

    deb_name = f"nia-todo-server-v{args.version}-full.deb"
    deb_path = out / deb_name
    subprocess.run(["dpkg-deb", "--build", str(pkg_root), str(deb_path)], check=True, stdout=subprocess.DEVNULL)
    digest = hashlib.sha256(deb_path.read_bytes()).hexdigest()
    (out / f"{deb_name}.sha256").write_text(f"{digest}  {deb_name}\n", encoding="utf-8")
    latest = {
        "tag_name": f"v{args.version}",
        "html_url": f"{args.base_url}/v{args.version}",
        "assets": [
            {"name": deb_name, "browser_download_url": f"{args.base_url}/{deb_name}", "size": deb_path.stat().st_size},
            {"name": f"{deb_name}.sha256", "browser_download_url": f"{args.base_url}/{deb_name}.sha256", "size": len((out / f"{deb_name}.sha256").read_bytes())},
        ],
    }
    (out / "latest.json").write_text(json.dumps(latest, indent=2) + "\n", encoding="utf-8")
    shutil.rmtree(pkg_root)

    print(f"Created fake update release in {out}")
    print(f"Serve with: cd {out} && python3 -m http.server 8765 --bind 127.0.0.1")
    print("API URL: http://127.0.0.1:8765/latest.json")


if __name__ == "__main__":
    main()
