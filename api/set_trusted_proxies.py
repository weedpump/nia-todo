#!/usr/bin/env python3
"""Set or show trusted proxies without editing the SQLite DB manually."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from migrate import run_migrations  # noqa: E402
from services.instance_config import get_trusted_proxies, set_trusted_proxies  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage nia-todo trusted proxies")
    parser.add_argument("proxies", nargs="*", help="Trusted proxy IPs/CIDRs, e.g. 10.0.10.14 172.18.0.0/16")
    parser.add_argument("--clear", action="store_true", help="Clear trusted proxies")
    parser.add_argument("--json", action="store_true", help="Print JSON output")
    args = parser.parse_args()

    run_migrations()

    if args.clear:
        proxies = set_trusted_proxies([])
    elif args.proxies:
        proxies = set_trusted_proxies(args.proxies)
    else:
        proxies = get_trusted_proxies()

    if args.json:
        print(json.dumps({"trusted_proxies": proxies}, indent=2))
    else:
        if proxies:
            print("Trusted Proxies:")
            for proxy in proxies:
                print(f"- {proxy}")
        else:
            print("Trusted Proxies: keine konfiguriert")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
