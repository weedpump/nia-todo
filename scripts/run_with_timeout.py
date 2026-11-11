#!/usr/bin/env python3
"""Run a command with a hard timeout for its complete process group."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time


def signal_group(process_group: int, sig: signal.Signals) -> None:
    try:
        os.killpg(process_group, sig)
    except ProcessLookupError:
        pass


def group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
        return True
    except ProcessLookupError:
        return False


def terminate_group(process_group: int, grace_seconds: float) -> None:
    if not group_exists(process_group):
        return
    signal_group(process_group, signal.SIGTERM)
    grace_deadline = time.monotonic() + grace_seconds
    while group_exists(process_group) and time.monotonic() < grace_deadline:
        time.sleep(0.05)
    signal_group(process_group, signal.SIGKILL)


def main() -> int:
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <timeout-seconds> <command> [args...]", file=sys.stderr)
        return 2

    try:
        timeout_seconds = float(sys.argv[1])
    except ValueError:
        print(f"Invalid timeout: {sys.argv[1]}", file=sys.stderr)
        return 2
    if timeout_seconds <= 0:
        print("Timeout must be greater than zero.", file=sys.stderr)
        return 2

    process = subprocess.Popen(sys.argv[2:], start_new_session=True)
    process_group = process.pid
    try:
        return_code = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        terminate_group(process_group, 10)
        process.wait()
        return 124
    except KeyboardInterrupt:
        terminate_group(process_group, 0.1)
        process.wait()
        return 130

    terminate_group(process_group, 10)

    if return_code < 0:
        return 128 + (-return_code)
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
