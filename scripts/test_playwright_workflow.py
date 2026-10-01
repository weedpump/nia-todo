#!/usr/bin/env python3
"""Regression checks for isolated Playwright WebKit CI coverage."""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "mcr.microsoft.com/playwright:v1.63.0-resolute@sha256:b022639ae9197f864040f92eef7b57c6d4b47db2190f77c909d8a5d902dd4b7e"


def load_workflow(name: str) -> dict:
    return yaml.safe_load((ROOT / ".github" / "workflows" / name).read_text())


def step_by_name(job: dict, name: str) -> dict:
    return next(step for step in job["steps"] if step.get("name") == name)


def assert_split(workflow: dict, *, release: bool = False) -> None:
    jobs = workflow["jobs"]
    package_job = jobs["test"]
    browser_install = step_by_name(package_job, "Install Playwright browser")
    assert browser_install["run"] == "npx playwright install --with-deps chromium"

    suite = step_by_name(package_job, "Install package and run test suite")
    assert suite.get("env", {}).get("MOBILE_SWIPE_BROWSERS") == "chromium"

    webkit_job = jobs["webkit-swipe"]
    assert webkit_job["container"]["image"] == IMAGE
    webkit_step = step_by_name(webkit_job, "Run WebKit mobile swipe regression")
    assert webkit_step.get("env", {}).get("MOBILE_SWIPE_BROWSERS") == "webkit"
    assert webkit_step["run"] == "node scripts/test_mobile_swipe_underlay.mjs"
    assert all("playwright install" not in str(step.get("run", "")) for step in webkit_job["steps"])

    if release:
        assert webkit_job.get("permissions") == {"contents": "read"}
        needs = jobs["publish"]["needs"]
        assert "webkit-swipe" in needs


assert_split(load_workflow("tests.yml"))
assert_split(load_workflow("release.yml"), release=True)
print("✅ Playwright WebKit CI isolation checks passed")
