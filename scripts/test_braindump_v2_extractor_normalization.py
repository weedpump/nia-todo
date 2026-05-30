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
    _format_workspace_context,
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


def test_parses_common_local_llm_json_variants():
    as_array = _parse_llm_json_content('[{"title":"Call Moni","kind":"todo",}]')
    as_tasks = _parse_llm_json_content('{"tasks":[{"task":"Buy milk","type":"grocery"}]}')
    as_parts = _parse_llm_json_content([{"type":"text","text":"```json\n{\"items\":[\"Water plants\"]}\n```"}])
    as_single = _parse_llm_json_content("{'title':'Check backup','kind':'todo'}")
    assert_true(as_array["candidates"][0]["title"] == "Call Moni", as_array)
    assert_true(as_tasks["candidates"][0]["task"] == "Buy milk", as_tasks)
    assert_true(as_parts["candidates"][0] == "Water plants", as_parts)
    assert_true(as_single["candidates"][0]["title"] == "Check backup", as_single)


def test_normalizes_alias_fields_from_local_models():
    parsed = {"tasks": [{"task": "Buy milk", "type": "grocery", "dueDate": "tomorrow 18:00", "projectName": "Shopping", "sectionName": "Dairy"}]}
    result = _normalize_braindump_json(parsed, "Buy milk tomorrow 18:00")
    item = result["candidates"][0]
    assert_true(item["title"] == "Milk", item)
    assert_true(item["kind"] == "shopping", item)
    assert_true(item["deadline"] and "T18:00" in item["deadline"], item)


def test_multilingual_safety_net_extracts_direct_purchase_phrases():
    spanish = _normalize_braindump_json({"candidates": []}, "Necesito huevos y papel higiénico.")
    english = _normalize_braindump_json({"candidates": []}, "We need milk and bread.")
    french = _normalize_braindump_json({"candidates": []}, "Il faut acheter du lait et du pain.")
    assert_true(any("Huevos" == item["title"] for item in spanish["candidates"]), spanish)
    assert_true(any("Milk" == item["title"] for item in english["candidates"]), english)
    assert_true(any("Lait" == item["title"] for item in french["candidates"]), french)


def test_filters_plain_list_noise_from_safety_net():
    result = _normalize_braindump_json({"candidates": []}, "Ähm ja okay danke, ich teste nur kurz.")
    assert_true(result["candidates"] == [], result)


def test_removes_negated_items_added_by_llm_or_safety_net():
    parsed = {"candidates": [{"title": "Milch", "kind": "shopping"}, {"title": "Kaffee", "kind": "shopping"}, {"title": "Hafermilch", "kind": "shopping"}]}
    result = _normalize_braindump_json(parsed, "Ich brauche Milch, Kaffee, ach nee Kaffee nicht, und Hafermilch.")
    titles = [item["title"] for item in result["candidates"]]
    assert_true("Milch" in titles and "Hafermilch" in titles, titles)
    assert_true("Kaffee" not in titles, titles)


def test_maps_section_name_used_as_project_to_real_project_section():
    parsed = {"candidates": [{"title": "Restore-Doku für Bareos prüfen", "project_name": "Bareos", "kind": "todo"}]}
    context = {"projects": [{"name": "Arbeit", "sections": ["Bareos", "OpenClaw"]}]}
    result = _normalize_braindump_json(parsed, "Für Bareos die Restore-Doku prüfen", context)
    item = result["candidates"][0]
    assert_true(item["project_name"] == "Arbeit" and item["section_name"] == "Bareos", item)


def test_replacement_with_statt_removes_old_item():
    parsed = {"candidates": [{"title": "Nachos", "kind": "shopping"}, {"title": "Setz Chips", "kind": "shopping"}]}
    result = _normalize_braindump_json(parsed, "Setz Chips auf die Einkaufsliste, nein doch lieber Nachos statt Chips.")
    titles = [item["title"] for item in result["candidates"]]
    assert_true("Nachos" in titles, titles)
    assert_true(not any("Chips" in title for title in titles), titles)


def test_reminder_kind_copies_deadline_to_reminder():
    parsed = {"candidates": [{"title": "Snoopy Tabletten geben", "kind": "reminder", "deadline": "morgen 18:00", "reminder": None}]}
    result = _normalize_braindump_json(parsed, "Erinnere mich morgen um 18 Uhr daran Snoopy Tabletten zu geben.")
    item = result["candidates"][0]
    assert_true(item["reminder"] and "T18:00" in item["reminder"], item)


def test_evening_iso_2359_normalizes_to_1900():
    parsed = {"candidates": [{"title": "Tierarzt mit Snoopy", "kind": "appointment", "deadline": "2026-06-01T23:59:00+02:00"}]}
    result = _normalize_braindump_json(parsed, "Übermorgen Abend zum Tierarzt mit Snoopy.")
    item = result["candidates"][0]
    assert_true("T19:00" in item["deadline"], item)


def test_multilingual_titles_are_preserved():
    spanish = _normalize_braindump_json({"candidates": [{"title": "huevos", "kind": "shopping"}, {"title": "revisar los documentos", "kind": "todo"}]}, "Necesito huevos. Mañana revisar los documentos.")
    french = _normalize_braindump_json({"candidates": [{"title": "acheter du lait", "kind": "shopping"}]}, "Il faut acheter du lait.")
    assert_true(any(item["title"].lower() == "huevos" for item in spanish["candidates"]), spanish)
    assert_true(any("documentos" in item["title"].lower() for item in spanish["candidates"]), spanish)
    assert_true(any("lait" in item["title"].lower() for item in french["candidates"]), french)


def test_workspace_context_is_compact():
    context = {"projects": [{"name": f"Project {idx}", "workspace": "Private", "sections": [f"Section {idx}-{s}" for s in range(20)]} for idx in range(60)]}
    formatted = _format_workspace_context(context)
    assert_true(len(formatted) <= 4005, len(formatted))
    assert_true("Project 0" in formatted and "Project 59" not in formatted, formatted[-200:])


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
        test_parses_common_local_llm_json_variants,
        test_normalizes_alias_fields_from_local_models,
        test_multilingual_safety_net_extracts_direct_purchase_phrases,
        test_filters_plain_list_noise_from_safety_net,
        test_removes_negated_items_added_by_llm_or_safety_net,
        test_maps_section_name_used_as_project_to_real_project_section,
        test_replacement_with_statt_removes_old_item,
        test_reminder_kind_copies_deadline_to_reminder,
        test_evening_iso_2359_normalizes_to_1900,
        test_multilingual_titles_are_preserved,
        test_workspace_context_is_compact,
        test_remote_stt_response_parsing_and_multipart_payload,
    ]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"\nBrainDump v2 extractor normalization tests passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
