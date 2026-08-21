#!/usr/bin/env python3
"""Regression tests for release version validation helpers."""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_release_versions.py"
spec = importlib.util.spec_from_file_location("check_release_versions", MODULE_PATH)
if spec is None or spec.loader is None:
    raise SystemExit("Could not load check_release_versions.py")
check = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check
spec.loader.exec_module(check)


def assert_true(value: bool, message: str) -> None:
    if not value:
        raise AssertionError(message)


def assert_false(value: bool, message: str) -> None:
    if value:
        raise AssertionError(message)


def assert_compare(left: str, right: str, expected_sign: int) -> None:
    result = check.compare_versions(left, right)
    sign = 0 if result == 0 else (1 if result > 0 else -1)
    if sign != expected_sign:
        raise AssertionError(f"compare_versions({left!r}, {right!r}) returned {result}, expected sign {expected_sign}")


def copy_release_inputs(tmp: Path) -> None:
    for rel in [
        "web/static/js/core/config.js",
        "web/sw.js",
        "web/index.html",
        "src-tauri/tauri.conf.json",
        "src-tauri/Cargo.toml",
        "src-tauri/Cargo.lock",
        "api/services/instance_config.py",
        "api/migrations/029_add_min_native_client_version_config.sql",
        "scripts/check_release_versions.py",
    ]:
        src = ROOT / rel
        dst = tmp / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")


def run_checker(tmp: Path, version: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "scripts/check_release_versions.py", version],
        cwd=tmp,
        text=True,
        capture_output=True,
        check=False,
    )


def set_min_native(tmp: Path, version: str) -> None:
    path = tmp / "api/services/instance_config.py"
    text = path.read_text(encoding="utf-8")
    text = __import__("re").sub(
        r'SOURCE_MIN_NATIVE_CLIENT_VERSION\s*=\s*"[^"]+"',
        f'SOURCE_MIN_NATIVE_CLIENT_VERSION = "{version}"',
        text,
        count=1,
    )
    path.write_text(text, encoding="utf-8")
    migration_path = tmp / "api/migrations/029_add_min_native_client_version_config.sql"
    migration_text = migration_path.read_text(encoding="utf-8")
    migration_text = __import__("re").sub(
        r"\('min_native_client_version', '[^']+'\)",
        f"('min_native_client_version', '{version}')",
        migration_text,
        count=1,
    )
    migration_path.write_text(migration_text, encoding="utf-8")


def set_sw_version(tmp: Path, version: str) -> None:
    path = tmp / "web/sw.js"
    text = path.read_text(encoding="utf-8")
    text = __import__("re").sub(
        r"const SW_VERSION\s*=\s*'v[^']*';",
        f"const SW_VERSION = 'v{version}';",
        text,
        count=1,
    )
    path.write_text(text, encoding="utf-8")


CURRENT_DEV_VERSION = check.first(
    r"APP_VERSION\s*=\s*['\"]v?([^'\"]+)['\"]",
    (ROOT / "web/static/js/core/config.js").read_text(encoding="utf-8"),
    "current APP_VERSION",
)
_current_parsed = check.parse_version(CURRENT_DEV_VERSION)
TOO_NEW_VERSION = f"{_current_parsed.major + 1}.0.0"


def test_version_helpers() -> None:
    assert_true(check.is_valid_stable_version("2.0.0"), "stable version should be valid")
    assert_true(check.is_valid_dev_version("2.0.1-dev"), "dev version should be valid")
    assert_true(check.is_valid_compat_version("1.7.0"), "compat stable should be valid")
    assert_false(check.is_valid_compat_version("1.7.4.dev"), "dot prerelease must be rejected")
    assert_false(check.is_valid_compat_version("1.7"), "missing patch must be rejected")
    assert_false(check.is_valid_compat_version("foo"), "non-version must be rejected")
    assert_compare("2.0.0-dev", "2.0.0", -1)
    assert_compare("2.0.0", "2.0.0-dev", 1)
    assert_compare("1.7.0", "2.0.0", -1)
    assert_compare("2.0.0", "2.0.0", 0)


def test_checker_rejects_bad_min_native_versions() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        copy_release_inputs(tmp)
        set_sw_version(tmp, CURRENT_DEV_VERSION)
        ok = run_checker(tmp, CURRENT_DEV_VERSION)
        assert_true(ok.returncode == 0, ok.stderr or ok.stdout)

        set_min_native(tmp, TOO_NEW_VERSION)
        too_new = run_checker(tmp, CURRENT_DEV_VERSION)
        assert_true(too_new.returncode != 0, "min_native_client_version above app version must fail")
        assert_true("must not exceed" in too_new.stderr, too_new.stderr)

        set_min_native(tmp, "1.7.4.dev")
        invalid = run_checker(tmp, CURRENT_DEV_VERSION)
        assert_true(invalid.returncode != 0, "invalid min_native_client_version must fail")
        assert_true("not valid" in invalid.stderr, invalid.stderr)


def test_android_generated_mismatch_is_warning_only() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        copy_release_inputs(tmp)
        set_sw_version(tmp, CURRENT_DEV_VERSION)
        props = tmp / "src-tauri/gen/android/app/tauri.properties"
        props.parent.mkdir(parents=True, exist_ok=True)
        props.write_text(
            "// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n"
            "tauri.android.versionName=1.7.0\n"
            "tauri.android.versionCode=1007000\n",
            encoding="utf-8",
        )
        result = run_checker(tmp, CURRENT_DEV_VERSION)
        assert_true(result.returncode == 0, result.stderr or result.stdout)
        assert_true("tauri.properties versionName is 1.7.0" in result.stdout, result.stdout)


def main() -> int:
    test_version_helpers()
    test_checker_rejects_bad_min_native_versions()
    test_android_generated_mismatch_is_warning_only()
    print("✅ Release version checker tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
