#!/usr/bin/env python3
"""Regression checks for isolated Playwright WebKit CI coverage."""

import os
from pathlib import Path
import re
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "mcr.microsoft.com/playwright:v1.64.1-resolute@sha256:5804dd8c666684ea858091d52c91ef97974caa999b25f0f03efa485d9ffeb434"


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
    assert suite.get("env", {}).get("ITEM_DND_BROWSERS") == "chromium"

    webkit_job = jobs["webkit-swipe"]
    assert webkit_job["container"]["image"] == IMAGE
    webkit_step = step_by_name(webkit_job, "Run WebKit mobile swipe regression")
    assert webkit_step.get("env", {}).get("MOBILE_SWIPE_BROWSERS") == "webkit"
    assert webkit_step["run"] == "node scripts/test_mobile_swipe_underlay.mjs"
    drag_drop_step = step_by_name(webkit_job, "Run WebKit shared item drag-drop regression")
    assert drag_drop_step.get("env", {}).get("ITEM_DND_BROWSER") == "webkit"
    assert drag_drop_step["run"] == "node scripts/test_shared_item_drag_drop.mjs"
    assert all("playwright install" not in str(step.get("run", "")) for step in webkit_job["steps"])

    if release:
        assert webkit_job.get("permissions") == {"contents": "read"}
        needs = jobs["publish"]["needs"]
        assert "webkit-swipe" in needs


def assert_drag_drop_dispatch() -> None:
    # Execute the release gate's actual dispatcher with a command recorder;
    # never source the gate or start its service/database tests.
    source = (ROOT / "scripts" / "test_all.sh").read_text()
    match = re.search(r"^run_shared_item_drag_drop\(\) \{.*?^\}", source, re.M | re.S)
    assert match, "Release gate must expose its browser dispatcher"
    assert re.search(r"^run_shared_item_drag_drop$", source, re.M), "Release gate must call the dispatcher"
    harness = 'run_step() { printf "%s\\n" "$*"; }\n' + match.group(0) + '\nrun_shared_item_drag_drop\n'
    for selection, expected in [(None, ["chromium", "webkit"]), ("chromium", ["chromium"]),
                                ("webkit", ["webkit"]), ("webkit,chromium", ["webkit", "chromium"])]:
        env = os.environ.copy()
        env.pop("ITEM_DND_BROWSERS", None)
        if selection is not None:
            env["ITEM_DND_BROWSERS"] = selection
        result = subprocess.run(["bash", "-eu", "-c", harness], env=env, text=True, capture_output=True, check=True)
        commands = result.stdout.splitlines()
        assert len(commands) == len(expected), (selection, commands)
        for command, browser in zip(commands, expected):
            assert command.endswith(f"env ITEM_DND_BROWSER={browser} node scripts/test_shared_item_drag_drop.mjs"), command
    env = {**os.environ, "ITEM_DND_BROWSERS": "firefox"}
    invalid = subprocess.run(["bash", "-eu", "-c", harness], env=env, text=True, capture_output=True)
    assert invalid.returncode == 2 and not invalid.stdout, invalid


assert_split(load_workflow("tests.yml"))
assert_split(load_workflow("release.yml"), release=True)
assert_drag_drop_dispatch()
print("✅ Playwright WebKit CI isolation checks passed")
