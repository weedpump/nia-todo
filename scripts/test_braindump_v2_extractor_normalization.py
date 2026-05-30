#!/usr/bin/env python3
"""Deterministic BrainDump v2 extractor normalization tests."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers.braindump_v2 import (  # noqa: E402
    _build_multipart_form_data,
    _extract_transcript_from_stt_response,
    _normalize_braindump_json,
    _parse_llm_json_content,
)


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


def test_filters_negated_and_filler_candidates_from_llm_output():
    parsed = {
        "candidates": [
            {"title": "Milch", "kind": "shopping"},
            {"title": "Kaffee", "kind": "shopping"},
            {"title": "Ach nee", "kind": "shopping"},
            {"title": "Kaffee nicht", "kind": "shopping"},
            {"title": "Hafermilch", "kind": "shopping"},
        ]
    }
    transcript = "Ich muss morgen Milch und Kaffee einkaufen. Ach nee, Kaffee nicht. Dafür bitte Hafermilch."
    result = _normalize_braindump_json(parsed, transcript)
    titles = [item["title"] for item in result["candidates"]]
    assert_true("Milch" in titles, titles)
    assert_true("Hafermilch" in titles, titles)
    assert_true("Kaffee" not in titles, titles)
    assert_true("Kaffee nicht" not in titles, titles)
    assert_true("Ach nee" not in titles, titles)


def test_dedupes_stt_truncated_item_variant():
    parsed = {"candidates": [{"title": "Bananen", "kind": "shopping"}, {"title": "Banan", "kind": "shopping"}]}
    result = _normalize_braindump_json(parsed, "Bananen auf der Einkaufsliste")
    titles = [item["title"] for item in result["candidates"]]
    assert_true(titles == ["Bananen"], titles)


def test_safety_net_keeps_non_negated_shopping_and_routes_sections():
    parsed = {"candidates": []}
    transcript = "Ich muss morgen Milch und Kaffee einkaufen. Ach nee, Kaffee nicht. Dafür bitte Hafermilch und Bananen auf der Einkaufsliste."
    context = {
        "projects": [
            {"name": "Inbox", "sections": []},
            {"name": "Einkaufsliste", "sections": ["Obst und Gemüse", "Milchprodukte"]},
        ]
    }
    result = _normalize_braindump_json(parsed, transcript, context)
    by_title = {item["title"]: item for item in result["candidates"]}
    assert_true("Milch" in by_title, result)
    assert_true("Hafermilch" in by_title, result)
    assert_true("Bananen" in by_title, result)
    assert_true("Kaffee" not in by_title, result)
    assert_true(by_title["Milch"]["project_name"] == "Einkaufsliste", result)
    assert_true(by_title["Milch"]["section_name"] == "Milchprodukte", result)
    assert_true(by_title["Bananen"]["section_name"] == "Obst und Gemüse", result)


def test_parses_markdown_fenced_llm_json():
    parsed = _parse_llm_json_content('```json\n{"candidates":[{"title":"Chips","kind":"shopping"}]}\n```')
    assert_true(parsed["candidates"][0]["title"] == "Chips", parsed)


def test_remote_stt_response_parsing_and_multipart_payload():
    body, content_type = _build_multipart_form_data(
        {"response_format": "json", "language": "de"},
        {"file": ("segment.ogg", b"audio-bytes", "audio/ogg")},
    )
    assert_true("multipart/form-data" in content_type, content_type)
    assert_true(b'name="file"; filename="segment.ogg"' in body, body[:200])
    assert_true(b"audio-bytes" in body, body[:200])
    transcript = _extract_transcript_from_stt_response(b'{"text":"  Hallo   Welt  "}', "application/json")
    assert_true(transcript == "Hallo Welt", transcript)


def main():
    tests = [
        test_dedupes_llm_and_safety_net_shopping_items,
        test_normalizes_relative_reminder_to_iso_datetime,
        test_drops_unparseable_reminder_text,
        test_filters_negated_and_filler_candidates_from_llm_output,
        test_dedupes_stt_truncated_item_variant,
        test_safety_net_keeps_non_negated_shopping_and_routes_sections,
        test_parses_markdown_fenced_llm_json,
        test_remote_stt_response_parsing_and_multipart_payload,
    ]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"\nBrainDump v2 extractor normalization tests passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
