#!/usr/bin/env python3
"""Live semantic BrainDump extractor checks.

These tests intentionally exercise the product prompt through OpenClaw instead
of only testing deterministic cleanup code. They are not part of the default
backend suite yet because they require a configured local OpenClaw gateway.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers.braindump_v2 import _extract_with_openclaw  # noqa: E402


FIXTURES = [
    {
        "name": "german_grocery_context_sections",
        "context": {
            "projects": [
                {"name": "Inbox", "workspace": "Personal", "is_inbox": True, "sections": []},
                {"name": "Einkauf", "workspace": "Personal", "is_inbox": False, "sections": ["Obst", "Gemüse", "Milchprodukte", "Snacks"]},
            ]
        },
        "text": "Ich brauche Kartoffeln, Erdbeeren, Milch, aber keine Chips.",
        "expect_titles": ["kartoff", "erdbeer", "milch"],
        "reject_titles": ["chip"],
        "expect_project_any": ["Einkauf"],
        "expect_sections_any": ["Obst", "Gemüse", "Milchprodukte"],
    },
    {
        "name": "stamp_collection_not_grocery_hardcoded",
        "context": {
            "projects": [
                {"name": "Inbox", "workspace": "Personal", "is_inbox": True, "sections": []},
                {"name": "Briefmarkensammlung", "workspace": "Hobby", "is_inbox": False, "sections": ["Alben", "Dubletten", "Bestellungen"]},
            ]
        },
        "text": "Für meine Briefmarken muss ich das neue Bayern-Album bestellen und die Dubletten sortieren.",
        "expect_titles": ["album", "dublett"],
        "expect_project_any": ["Briefmarkensammlung"],
        "expect_sections_any": ["Dubletten", "Bestellungen"],
    },
    {
        "name": "homework_sections",
        "context": {
            "projects": [
                {"name": "Hausaufgaben", "workspace": "Schule", "is_inbox": False, "sections": ["Mathe", "Englisch", "Geschichte"]},
            ]
        },
        "text": "Ich muss morgen Mathe Seite 12 fertig machen und Englisch Vokabeln lernen.",
        "expect_titles": ["seite 12", "vokabel"],
        "expect_project_any": ["Hausaufgaben"],
        "expect_sections_any": ["Mathe", "Englisch"],
    },
    {
        "name": "implicit_grocery_section_inference_without_user_section_hints",
        "context": {
            "projects": [
                {"name": "Inbox", "workspace": "Personal", "is_inbox": True, "sections": []},
                {"name": "Einkaufsliste", "workspace": "Personal", "is_inbox": False, "sections": ["Obst und Gemüse", "Milchprodukte", "Tierbedarf"]},
            ]
        },
        "text": "Ich brauche Milch, Hafermilch, Bananen und Hundefutter.",
        "expect_titles": ["milch", "hafermilch", "banan", "hundefutter"],
        "expect_project_any": ["Einkaufsliste"],
        "expect_sections_any": ["Milchprodukte", "Obst und Gemüse", "Tierbedarf"],
    },
    {
        "name": "spanish_grocery_language_and_negation",
        "context": {
            "projects": [
                {"name": "Compras", "workspace": "Casa", "is_inbox": False, "sections": ["Fruta", "Verduras", "Lácteos"]},
            ]
        },
        "text": "Necesito manzanas y leche, pero no galletas.",
        "expect_titles": ["manzana", "leche"],
        "reject_titles": ["galleta"],
        "expect_project_any": ["Compras"],
        "expect_sections_any": ["Fruta", "Lácteos"],
    },
]


def norm(value: object) -> str:
    return str(value or "").casefold()


def flatten(candidates: list[dict], key: str) -> str:
    return "\n".join(norm(candidate.get(key)) for candidate in candidates)


def assert_fixture(index: int, fixture: dict) -> bool:
    elapsed_ms, parsed, usage, raw_json = _extract_with_openclaw(
        fixture["text"],
        segment_id=10_000 + index,
        workspace_context=fixture["context"],
    )
    candidates = parsed.get("candidates") or []
    titles = flatten(candidates, "title")
    projects = flatten(candidates, "project_name")
    sections = flatten(candidates, "section_name")
    failures = []
    for expected in fixture.get("expect_titles", []):
        if expected.casefold() not in titles:
            failures.append(f"missing title fragment: {expected}")
    for rejected in fixture.get("reject_titles", []):
        if rejected.casefold() in titles:
            failures.append(f"rejected title present: {rejected}")
    for expected in fixture.get("expect_project_any", []):
        if expected.casefold() not in projects:
            failures.append(f"missing project routing: {expected}")
    for expected in fixture.get("expect_sections_any", []):
        if expected.casefold() not in sections:
            failures.append(f"missing section routing: {expected}")

    status = "PASS" if not failures else "FAIL"
    print(f"\n[{status}] {fixture['name']} ({elapsed_ms:.0f} ms)")
    print(json.dumps(parsed, ensure_ascii=False, indent=2))
    if usage:
        print("usage:", json.dumps(usage, ensure_ascii=False, separators=(",", ":")))
    for failure in failures:
        print("  -", failure)
    if raw_json and raw_json != json.dumps(parsed, ensure_ascii=False, separators=(",", ":")):
        print("raw:", raw_json)
    return not failures


def main() -> int:
    passed = 0
    for index, fixture in enumerate(FIXTURES, start=1):
        if assert_fixture(index, fixture):
            passed += 1
    total = len(FIXTURES)
    print(f"\nBrainDump semantic extractor live checks: {passed}/{total} passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
