#!/usr/bin/env python3
"""Deterministic BrainDump v2 extractor normalization tests."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers.braindump_v2 import _normalize_braindump_json  # noqa: E402


def assert_true(condition: bool, message: str):
    if not condition:
        raise AssertionError(message)


def test_dedupes_llm_and_safety_net_shopping_items():
    parsed = {
        "candidates": [
            {"title": "Hafermilch", "kind": "shopping", "project_name": "Einkauf", "section_name": "Milchprodukte"},
            {"title": "Hafermilch", "kind": "shopping"},
            {"title": "Honig kaufen", "kind": "shopping"},
            {"title": "Honig", "kind": "shopping"},
        ]
    }
    result = _normalize_braindump_json(parsed, "Hafermilch und Honig kaufen")
    titles = [item["title"] for item in result["candidates"]]
    assert_true(titles.count("Hafermilch") == 1, f"expected one Hafermilch, got {titles}")
    assert_true(titles.count("Honig") == 1, f"expected one Honig, got {titles}")


def test_normalizes_relative_reminder_to_iso_datetime():
    parsed = {"candidates": [{"title": "Zur Mama gehen", "kind": "todo", "deadline": "übermorgenabend", "reminder": "übermorgenabend"}]}
    result = _normalize_braindump_json(parsed, "übermorgenabend zu meiner Mama gehen")
    candidate = result["candidates"][0]
    assert_true(candidate["deadline"] and "T19:00" in candidate["deadline"], candidate)
    assert_true(candidate["reminder"] and "T19:00" in candidate["reminder"], candidate)
    assert_true("übermorgen" not in candidate["reminder"].lower(), candidate)


def test_drops_unparseable_reminder_text():
    parsed = {"candidates": [{"title": "Zur Mama gehen", "kind": "todo", "reminder": "irgendwann bald"}]}
    result = _normalize_braindump_json(parsed, "irgendwann bald zu meiner Mama gehen")
    assert_true(result["candidates"][0]["reminder"] is None, result)


def main():
    tests = [
        test_dedupes_llm_and_safety_net_shopping_items,
        test_normalizes_relative_reminder_to_iso_datetime,
        test_drops_unparseable_reminder_text,
    ]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"\nBrainDump v2 extractor normalization tests passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
