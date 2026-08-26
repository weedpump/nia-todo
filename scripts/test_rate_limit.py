#!/usr/bin/env python3
"""Regression tests for login rate-limit isolation."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from rate_limit import RateLimiter  # noqa: E402


def test_successful_login_cannot_clear_another_account_attempts() -> None:
    limiter = RateLimiter()
    ip = "198.51.100.10"

    for _ in range(5):
        assert limiter.check_login(ip, "victim@example.invalid")
        limiter.record_failed_login(ip, "victim@example.invalid")

    limiter.record_successful_login(ip, "attacker@example.invalid")

    assert not limiter.check_login(ip, "victim@example.invalid")


def test_account_limit_applies_across_source_ips() -> None:
    limiter = RateLimiter()

    for index in range(5):
        ip = f"198.51.100.{index}"
        assert limiter.check_login(ip, "victim@example.invalid")
        limiter.record_failed_login(ip, "victim@example.invalid")

    assert not limiter.check_login("203.0.113.10", "victim@example.invalid")


def test_successful_logins_do_not_consume_failed_attempt_budget() -> None:
    limiter = RateLimiter()

    for _ in range(6):
        assert limiter.check_login("198.51.100.10", "user@example.invalid")
        limiter.record_successful_login("198.51.100.10", "user@example.invalid")


if __name__ == "__main__":
    test_successful_login_cannot_clear_another_account_attempts()
    test_account_limit_applies_across_source_ips()
    test_successful_logins_do_not_consume_failed_attempt_budget()
    print("✅ Login rate-limit isolation regression tests passed")
