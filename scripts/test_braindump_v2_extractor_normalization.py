#!/usr/bin/env python3
"""Deterministic BrainDump v2 extractor normalization tests."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers.admin import _validate_configured_llm_model  # noqa: E402
from routers import braindump_v2 as braindump_mod  # noqa: E402
from routers.braindump_v2 import (  # noqa: E402
    _braindump_llm_max_tokens,
    _build_multipart_form_data,
    _extract_transcript_from_stt_response,
    _extract_with_llm,
    _format_workspace_context,
    _llm_empty_content_diagnostic,
    _llm_request_payload,
    _llm_response_content,
    _normalize_braindump_json,
    _parse_llm_json_content,
)
from services.braindump_config import DEFAULT_BRAINDUMP_CONFIG, DEFAULT_BRAINDUMP_SYSTEM_PROMPT, normalize_braindump_config, llm_chat_url, llm_models_url  # noqa: E402


def assert_true(condition: bool, message: str):
    if not condition:
        raise AssertionError(message)


def test_dedupes_exact_llm_candidates_without_semantic_rewrites():
    parsed = {
        "candidates": [
            {"title": "Hafermilch", "project_name": "Einkauf", "section_name": "Milchprodukte"},
            {"title": "Hafermilch"},
            {"title": "Honig kaufen"},
            {"title": "Honig"},
        ]
    }
    result = _normalize_braindump_json(parsed, "Hafermilch und Honig kaufen")
    titles = [item["title"] for item in result["candidates"]]
    assert_true(titles.count("Hafermilch") == 1, f"expected one Hafermilch, got {titles}")
    assert_true("Honig kaufen" in titles and "Honig" in titles, titles)


def test_normalizes_relative_reminder_to_iso_datetime():
    parsed = {"candidates": [{"title": "Zur Mama gehen", "deadline": "übermorgenabend", "reminder": "übermorgenabend"}]}
    result = _normalize_braindump_json(parsed, "übermorgenabend zu meiner Mama gehen")
    candidate = result["candidates"][0]
    assert_true(candidate["deadline"] and "T19:00" in candidate["deadline"], candidate)
    assert_true(candidate["reminder"] and "T19:00" in candidate["reminder"], candidate)
    assert_true("übermorgen" not in candidate["reminder"].lower(), candidate)


def test_drops_unparseable_reminder_text():
    parsed = {"candidates": [{"title": "Zur Mama gehen", "reminder": "irgendwann bald"}]}
    result = _normalize_braindump_json(parsed, "irgendwann bald zu meiner Mama gehen")
    assert_true(result["candidates"][0]["reminder"] is None, result)


def test_dedupes_stt_truncated_item_variant():
    parsed = {"candidates": [{"title": "Bananen"}, {"title": "Banan"}]}
    result = _normalize_braindump_json(parsed, "Bananen auf der Einkaufsliste")
    titles = [item["title"] for item in result["candidates"]]
    assert_true(titles == ["Bananen"], titles)


def test_parses_markdown_fenced_llm_json():
    parsed = _parse_llm_json_content('```json\n{"candidates":[{"title":"Chips"}]}\n```')
    assert_true(parsed["candidates"][0]["title"] == "Chips", parsed)


def test_parses_common_local_llm_json_variants():
    as_array = _parse_llm_json_content('[{"title":"Call Moni",}]')
    as_tasks = _parse_llm_json_content('{"tasks":[{"task":"Buy milk","type":"grocery"}]}')
    as_parts = _parse_llm_json_content([{"type":"text","text":"```json\n{\"items\":[\"Water plants\"]}\n```"}])
    as_single = _parse_llm_json_content("{'title':'Check backup'}")
    assert_true(as_array["candidates"][0]["title"] == "Call Moni", as_array)
    assert_true(as_tasks["candidates"][0]["task"] == "Buy milk", as_tasks)
    assert_true(as_parts["candidates"][0] == "Water plants", as_parts)
    assert_true(as_single["candidates"][0]["title"] == "Check backup", as_single)


def test_normalizes_alias_fields_from_local_models_without_kind_semantics():
    parsed = {"tasks": [{"task": "Buy milk", "dueDate": "tomorrow 18:00", "projectName": "Shopping", "sectionName": "Dairy"}]}
    result = _normalize_braindump_json(parsed, "Buy milk tomorrow 18:00")
    item = result["candidates"][0]
    assert_true(item["title"] == "Buy milk", item)
    assert_true("kind" not in item, item)
    assert_true(item["deadline"] and "T18:00" in item["deadline"], item)


def test_invalid_llm_section_is_cleared_when_workspace_known():
    context = {"projects": [{"name": "Shopping", "sections": ["Dairy"]}]}
    result = _normalize_braindump_json({"candidates": [{"title": "Bread", "project_name": "Shopping", "section_name": "Shopping | Drinks"}]}, "Buy bread.", context)
    assert_true(result["candidates"][0]["section_name"] is None, result)


def test_unknown_llm_project_is_cleared_to_inbox_fallback():
    context = {"projects": [{"name": "Shopping", "sections": ["Dairy"]}]}
    result = _normalize_braindump_json({"candidates": [{"title": "Task", "project_name": "Ghost", "section_name": "Nope"}]}, "Task", context)
    item = result["candidates"][0]
    assert_true(item["project_name"] is None and item["section_name"] is None, item)


def test_section_without_project_is_cleared_to_inbox_fallback():
    context = {"projects": [{"name": "Shopping", "sections": ["Dairy"]}]}
    result = _normalize_braindump_json({"candidates": [{"title": "Task", "project_name": None, "section_name": "Dairy"}]}, "Task", context)
    item = result["candidates"][0]
    assert_true(item["project_name"] is None and item["section_name"] is None, item)


def test_backend_does_not_assign_sections_from_title():
    context = {"projects": [{"name": "Privat", "sections": ["Snoopy"]}]}
    result = _normalize_braindump_json({"candidates": [{"title": "Snoopy Tabletten geben", "project_name": "Privat"}]}, "Snoopy Tabletten geben", context)
    item = result["candidates"][0]
    assert_true(item["project_name"] == "Privat" and item["section_name"] is None, item)


def test_backend_keeps_complex_llm_titles():
    result = _normalize_braindump_json({"candidates": [{"title": "Lisa und Tom zur Party einladen, Geschenk besorgen"}]}, "")
    titles = [item["title"] for item in result["candidates"]]
    assert_true("Lisa und Tom zur Party einladen, Geschenk besorgen" in titles, titles)


def test_backend_does_not_semantically_rewrite_llm_candidates():
    parsed = {"candidates": [
        {"title": "Honig kaufen"},
        {"title": "Honig"},
        {"title": "Kaffee"},
        {"title": "Kaffee nicht"},
        {"title": "Setz Chips"},
    ]}
    result = _normalize_braindump_json(parsed, "Honig kaufen. Kaffee nicht. Setz Chips auf die Liste.")
    titles = [item["title"] for item in result["candidates"]]
    assert_true("Honig kaufen" in titles and "Honig" in titles, titles)
    assert_true("Kaffee" in titles and "Kaffee nicht" in titles, titles)
    assert_true("Setz Chips" in titles, titles)


def test_empty_llm_candidates_do_not_trigger_transcript_fallback():
    result = _normalize_braindump_json({"candidates": []}, "Ich brauche Milch und Kaffee.")
    assert_true(result == {"candidates": []}, result)


def test_normalizes_recurring_rule_only_with_deadline():
    parsed = {"candidates": [
        {"title": "Rauchmelder prüfen", "deadline": "morgen", "recurring_rule": {"frequency": "monthly", "interval": 6}},
        {"title": "Filter wechseln", "recurring_rule": {"frequency": "monthly", "interval": 6}},
    ]}
    result = _normalize_braindump_json(parsed, "Ab morgen alle sechs Monate Rauchmelder prüfen. Filter regelmäßig wechseln.")
    by_title = {item["title"]: item for item in result["candidates"]}
    assert_true(by_title["Rauchmelder prüfen"]["recurring_rule"] == {"frequency": "monthly", "interval": 6, "preserve_time": True}, by_title)
    assert_true(by_title["Filter wechseln"]["recurring_rule"] is None, by_title)


def test_normalizes_half_year_recurring_alias():
    for repeat in ("jedes halbe Jahr", "alle sechs Monate", "every six months"):
        parsed = {"candidates": [{"title": "Wartung machen", "deadline": "morgen", "repeat": repeat}]}
        result = _normalize_braindump_json(parsed, f"Ab morgen {repeat} Wartung machen.")
        item = result["candidates"][0]
        assert_true(item["recurring_rule"] == {"frequency": "monthly", "interval": 6, "preserve_time": True}, item)


def test_normalizes_recurring_word_number_intervals():
    parsed = {"candidates": [{"title": "Review machen", "deadline": "morgen", "repeat": "alle zwei Wochen"}]}
    result = _normalize_braindump_json(parsed, "Ab morgen alle zwei Wochen Review machen.")
    item = result["candidates"][0]
    assert_true(item["recurring_rule"] == {"frequency": "weekly", "interval": 2, "preserve_time": True}, item)

def test_default_prompt_requires_language_agnostic_correction_handling():
    prompt = DEFAULT_BRAINDUMP_SYSTEM_PROMPT
    assert_true("language-independently using semantic meaning, not keyword matching" in prompt, prompt)
    assert_true("system prompt language, UI language, and spoken transcript language may all differ" in prompt, prompt)
    assert_true("Process the whole transcript chronologically as edits to a temporary ledger/working set" in prompt, prompt)
    assert_true("Classify each clause by intent" in prompt, prompt)
    assert_true("in any language" in prompt, prompt)
    assert_true("negates, retracts, deletes, cancels, excludes, crosses off, removes, or replaces" in prompt, prompt)
    assert_true("bare noun fragment followed by a correction/removal clause is not enough" in prompt, prompt)
    assert_true("Resolve pronouns, ellipsis, and short references" in prompt, prompt)
    assert_true("ledger entry" in prompt, prompt)
    assert_true("no longer wants/needs" in prompt, prompt)
    assert_true("validate every candidate" in prompt, prompt)
    assert_true("preserve explicit dates/times/reminders" in prompt, prompt)
    assert_true("Prefer omission over false positives" in prompt, prompt)
    assert_true("add A, B, C; later remove B; later add D" in prompt, prompt)
    assert_true("The assistant message content must begin with {" in prompt, prompt)
    assert_true("If the model supports internal reasoning/thinking" in prompt, prompt)
    assert_true("If the model does not support internal reasoning/thinking" in prompt, prompt)
    assert_true("Correct obvious speech recognition errors" in prompt, prompt)
    assert_true("trailing question mark" in prompt, prompt)
    assert_true("recurring_rule" in prompt, prompt)
    assert_true("every six months" in prompt, prompt)
    assert_true("Do not ask follow-up questions" in prompt, prompt)
    assert_true("kind" not in prompt.lower(), prompt)


def test_runtime_llm_prompt_contains_only_input_context():
    calls = []
    original_post = braindump_mod._post_llm_chat

    def fake_post(payload, headers, config):
        calls.append(payload)
        return {"choices": [{"message": {"content": '{"candidates":[]}'}, "finish_reason": "stop"}]}

    try:
        braindump_mod._post_llm_chat = fake_post
        _extract_with_llm(
            "Ab morgen alle sechs Monate Wartung machen.",
            99,
            workspace_context={"projects": [{"name": "Privat", "sections": ["Haus"]}]},
            config={"llm_provider": "openai_compatible", "llm_base_url": "http://localhost:1234", "llm_model": "local-test", "llm_timeout_seconds": 1},
        )
    finally:
        braindump_mod._post_llm_chat = original_post

    system_content = calls[0]["messages"][0]["content"]
    user_content = calls[0]["messages"][1]["content"]
    assert_true('"recurring_rule":null' in system_content, system_content)
    assert_true("alle sechs Monate" in system_content, system_content)
    assert_true("Current datetime:" in user_content, user_content)
    assert_true("Workspace JSON:" in user_content, user_content)
    assert_true("Transcript:" in user_content, user_content)
    assert_true("Output JSON shape" not in user_content, user_content)
    assert_true("Provider-neutral extraction contract" not in user_content, user_content)
    assert_true('"recurring_rule":null' not in user_content, user_content)


def test_llm_token_budget_and_empty_response_diagnostic():
    short_budget = _braindump_llm_max_tokens("Kartoffeln")
    retry_budget = _braindump_llm_max_tokens("Kartoffeln", retry=True)
    assert_true(short_budget >= 1200, short_budget)
    assert_true(retry_budget > short_budget, (short_budget, retry_budget))
    diagnostic = _llm_empty_content_diagnostic({
        "choices": [{"message": {"content": ""}, "finish_reason": "length"}],
        "usage": {"completion_tokens": 500, "completion_tokens_details": {"reasoning_tokens": 497}},
    }, {"llm_provider": "openai_compatible"}, 2000)
    assert_true("finish_reason=length" in diagnostic, diagnostic)
    assert_true("reasoning_tokens=497" in diagnostic, diagnostic)


def test_extract_with_llm_retries_empty_reasoning_response():
    calls = []
    original_post = braindump_mod._post_llm_chat

    def fake_post(payload, headers, config):
        calls.append(payload)
        if len(calls) == 1:
            return {
                "choices": [{"message": {"content": ""}, "finish_reason": "length"}],
                "usage": {"completion_tokens": 500, "completion_tokens_details": {"reasoning_tokens": 497}},
            }
        return {
            "choices": [{"message": {"content": '{"candidates":[{"title":"Kartoffeln"}]}'}, "finish_reason": "stop"}],
            "usage": {"completion_tokens": 40},
        }

    try:
        braindump_mod._post_llm_chat = fake_post
        elapsed, parsed, usage, raw = _extract_with_llm(
            "Ich brauche noch Kartoffeln.",
            42,
            config={"llm_provider": "openai_compatible", "llm_base_url": "http://localhost:1234", "llm_model": "local-test", "llm_timeout_seconds": 1},
        )
    finally:
        braindump_mod._post_llm_chat = original_post

    assert_true(elapsed >= 0, elapsed)
    assert_true(parsed["candidates"][0]["title"] == "Kartoffeln", parsed)
    assert_true(usage == {"completion_tokens": 40}, usage)
    assert_true('"Kartoffeln"' in raw, raw)
    assert_true(len(calls) == 2, len(calls))
    assert_true(calls[0]["max_tokens"] >= 1200, calls[0]["max_tokens"])
    assert_true(calls[1]["max_tokens"] >= 3000, calls[1]["max_tokens"])
    assert_true("Retry instruction" in calls[1]["messages"][1]["content"], calls[1]["messages"][1]["content"])


def test_extract_with_llm_retries_empty_ollama_length_response():
    calls = []
    original_post = braindump_mod._post_llm_chat

    def fake_post(payload, headers, config):
        calls.append(payload)
        if len(calls) == 1:
            return {"message": {"content": ""}, "done_reason": "length", "eval_count": 500}
        return {"message": {"content": '{"candidates":[{"title":"Bananen"}]}'}, "done_reason": "stop", "eval_count": 32}

    try:
        braindump_mod._post_llm_chat = fake_post
        _, parsed, usage, _ = _extract_with_llm(
            "Ich brauche noch Bananen.",
            43,
            config={"llm_provider": "ollama", "llm_base_url": "http://localhost:11434", "llm_model": "local-test", "llm_timeout_seconds": 1},
        )
    finally:
        braindump_mod._post_llm_chat = original_post

    assert_true(parsed["candidates"][0]["title"] == "Bananen", parsed)
    assert_true(usage == {"completion_tokens": 32}, usage)
    assert_true(len(calls) == 2, len(calls))
    assert_true(calls[0]["options"]["num_predict"] >= 1200, calls[0])
    assert_true(calls[1]["options"]["num_predict"] >= 3000, calls[1])


def test_evening_iso_2359_normalizes_to_1900():
    parsed = {"candidates": [{"title": "Tierarzt mit Snoopy", "deadline": "2026-06-01T23:59:00+02:00"}]}
    result = _normalize_braindump_json(parsed, "Übermorgen Abend zum Tierarzt mit Snoopy.")
    item = result["candidates"][0]
    assert_true("T19:00" in item["deadline"], item)


def test_multilingual_titles_are_preserved():
    spanish = _normalize_braindump_json({"candidates": [{"title": "huevos"}, {"title": "revisar los documentos"}]}, "Necesito huevos. Mañana revisar los documentos.")
    french = _normalize_braindump_json({"candidates": [{"title": "acheter du lait"}]}, "Il faut acheter du lait.")
    assert_true(any(item["title"].lower() == "huevos" for item in spanish["candidates"]), spanish)
    assert_true(any("documentos" in item["title"].lower() for item in spanish["candidates"]), spanish)
    assert_true(any("lait" in item["title"].lower() for item in french["candidates"]), french)


def test_date_only_reminder_is_rejected_but_deadline_kept():
    result = _normalize_braindump_json({"candidates": [{"title": "Pay invoice", "deadline": "2026-06-01", "reminder": "2026-06-01"}]}, "Pay invoice on 2026-06-01.")
    item = result["candidates"][0]
    assert_true(item["deadline"] and "2026-06-01" in item["deadline"], item)
    assert_true(item["reminder"] is None, item)


def test_default_stt_language_is_auto():
    assert_true(DEFAULT_BRAINDUMP_CONFIG["stt_language"] == "auto", DEFAULT_BRAINDUMP_CONFIG)
    normalized = normalize_braindump_config({})
    assert_true(normalized["stt_language"] == "auto", normalized)
    cleared = normalize_braindump_config({"stt_language": ""})
    assert_true(cleared["stt_language"] == "auto", cleared)


def test_llm_endpoint_urls_accept_root_v1_and_full_paths():
    cases = [
        ("https://api.openai.com", "https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/models"),
        ("https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/models"),
        ("http://localhost:1234/v1/chat/completions", "http://localhost:1234/v1/chat/completions", "http://localhost:1234/v1/models"),
    ]
    for base, chat, models in cases:
        config = {"llm_provider": "openai_compatible", "llm_base_url": base}
        assert_true(llm_chat_url(config) == chat, llm_chat_url(config))
        assert_true(llm_models_url(config) == models, llm_models_url(config))


def test_ollama_provider_urls_payload_and_response_content():
    cases = [
        ("http://localhost:11434", "http://localhost:11434/api/chat", "http://localhost:11434/api/tags"),
        ("https://ollama.com/api", "https://ollama.com/api/chat", "https://ollama.com/api/tags"),
        ("https://ollama.com/api/chat", "https://ollama.com/api/chat", "https://ollama.com/api/tags"),
    ]
    for base, chat, tags in cases:
        config = {"llm_provider": "ollama", "llm_base_url": base}
        assert_true(llm_chat_url(config) == chat, llm_chat_url(config))
        assert_true(llm_models_url(config) == tags, llm_models_url(config))
    payload = _llm_request_payload({
        "model": "gpt-oss:120b",
        "messages": [{"role": "user", "content": "Hi"}],
        "temperature": 0,
        "stream": False,
        "max_tokens": 2000,
        "user": "ignored-for-ollama",
    }, {"llm_provider": "ollama"})
    assert_true(payload == {"model": "gpt-oss:120b", "messages": [{"role": "user", "content": "Hi"}], "stream": False, "options": {"temperature": 0, "num_predict": 2000}}, payload)
    assert_true(_llm_response_content({"message": {"content": "{\"candidates\":[]}"}}, {"llm_provider": "ollama"}) == '{"candidates":[]}', "ollama content parse")


def test_admin_llm_models_payload_validates_configured_model():
    openai_payload = '{"object":"list","data":[{"id":"openclaw/default"},{"id":"openclaw/braindump"}]}'
    assert_true(_validate_configured_llm_model(openai_payload, "openclaw/braindump") is None, "valid OpenClaw agent should pass")
    error = _validate_configured_llm_model(openai_payload, "openclaw/braindumpd")
    assert_true(error and "openclaw/braindumpd" in error and "openclaw/braindump" in error, error)
    ollama_payload = '{"models":[{"name":"gpt-oss:120b"},{"name":"llama3.1"}]}'
    assert_true(_validate_configured_llm_model(ollama_payload, "gpt-oss:120b") is None, "valid Ollama model should pass")


def test_workspace_context_is_compact_json():
    context = {"workspace_name": "Private", "projects": [{"name": f"Project {idx}", "workspace": "Private", "sections": [f"Section {idx}-{s}" for s in range(20)]} for idx in range(60)]}
    formatted = _format_workspace_context(context)
    payload = json.loads(formatted)
    assert_true(len(formatted) <= 5005, len(formatted))
    assert_true(payload["workspace_name"] == "Private", payload)
    assert_true(payload["projects"][0]["name"] == "Project 0", payload["projects"][:1])
    assert_true(all("name" in project and "sections" in project for project in payload["projects"]), payload)


def test_workspace_context_json_preserves_project_section_nesting():
    context = {"projects": [{"name": "Project", "workspace": "Private", "sections": [f"Section {idx}" for idx in range(12)] + ["Specific Semantic Bucket"]}]}
    formatted = _format_workspace_context(context)
    payload = json.loads(formatted)
    assert_true(payload["projects"][0]["name"] == "Project", payload)
    assert_true("Specific Semantic Bucket" in payload["projects"][0]["sections"], payload)
    assert_true(any("Never attach a section" in rule for rule in payload["rules"]), payload)


def test_workspace_context_includes_saved_places_for_location_routing():
    context = {"projects": [], "places": [{"id": 1, "name": "Zuhause", "address": "hidden"}]}
    formatted = _format_workspace_context(context)
    payload = json.loads(formatted)
    assert_true(payload["places"] == [{"name": "Zuhause"}], payload)
    assert_true(any("place_name" in rule for rule in payload["rules"]), payload)
    assert_true("hidden" not in formatted, formatted)


def test_normalizes_location_reminder_only_for_known_saved_place():
    context = {"places": [{"id": 1, "name": "Zuhause", "address": "Johanneck 24", "icon": "home"}]}
    result = _normalize_braindump_json({"candidates": [{"title": "Müll rausstellen", "location_reminder": {"trigger_type": "arrival", "place_name": "Zuhause"}}]}, "Wenn ich zuhause bin Müll rausstellen", context)
    location = result["candidates"][0]["location_reminder"]
    assert_true(location["place_id"] == 1 and location["place_name"] == "Zuhause", location)
    assert_true(location["address"] == "Johanneck 24", location)

    unknown = _normalize_braindump_json({"candidates": [{"title": "Paket abholen", "location_reminder": {"trigger_type": "arrival", "place_name": "Packstation"}}]}, "Bei der Packstation Paket abholen", context)
    assert_true(unknown["candidates"][0]["location_reminder"] is None, unknown)


def test_default_prompt_requires_generic_semantic_section_routing():
    prompt = DEFAULT_BRAINDUMP_SYSTEM_PROMPT
    assert_true("Treat existing project sections as the user's taxonomy" in prompt, prompt)
    assert_true("synonyms" in prompt and "hypernyms" in prompt and "hyponyms" in prompt, prompt)
    assert_true("exact project + section" in prompt, prompt)
    assert_true("Location reminders" in prompt and "saved places" in prompt and "place_name" in prompt, prompt)


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
        test_dedupes_exact_llm_candidates_without_semantic_rewrites,
        test_normalizes_relative_reminder_to_iso_datetime,
        test_drops_unparseable_reminder_text,
        test_dedupes_stt_truncated_item_variant,
        test_parses_markdown_fenced_llm_json,
        test_parses_common_local_llm_json_variants,
        test_normalizes_alias_fields_from_local_models_without_kind_semantics,
        test_invalid_llm_section_is_cleared_when_workspace_known,
        test_unknown_llm_project_is_cleared_to_inbox_fallback,
        test_section_without_project_is_cleared_to_inbox_fallback,
        test_backend_does_not_assign_sections_from_title,
        test_backend_keeps_complex_llm_titles,
        test_backend_does_not_semantically_rewrite_llm_candidates,
        test_empty_llm_candidates_do_not_trigger_transcript_fallback,
        test_normalizes_recurring_rule_only_with_deadline,
        test_normalizes_half_year_recurring_alias,
        test_normalizes_recurring_word_number_intervals,
        test_default_prompt_requires_language_agnostic_correction_handling,
        test_runtime_llm_prompt_contains_only_input_context,
        test_llm_token_budget_and_empty_response_diagnostic,
        test_extract_with_llm_retries_empty_reasoning_response,
        test_extract_with_llm_retries_empty_ollama_length_response,
        test_evening_iso_2359_normalizes_to_1900,
        test_multilingual_titles_are_preserved,
        test_date_only_reminder_is_rejected_but_deadline_kept,
        test_default_stt_language_is_auto,
        test_llm_endpoint_urls_accept_root_v1_and_full_paths,
        test_ollama_provider_urls_payload_and_response_content,
        test_admin_llm_models_payload_validates_configured_model,
        test_workspace_context_is_compact_json,
        test_workspace_context_json_preserves_project_section_nesting,
        test_workspace_context_includes_saved_places_for_location_routing,
        test_normalizes_location_reminder_only_for_known_saved_place,
        test_default_prompt_requires_generic_semantic_section_routing,
        test_remote_stt_response_parsing_and_multipart_payload,
    ]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"\nBrainDump v2 extractor normalization tests passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
