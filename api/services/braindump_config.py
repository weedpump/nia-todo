"""DB-backed BrainDump AI/STT provider configuration."""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import urlparse, urlunparse

from fastapi import HTTPException

from db import get_db
from services.instance_config import _normalize_http_url

DEFAULT_BRAINDUMP_SYSTEM_PROMPT = """You are BrainDump, a strict extractor for nia-todo.
Turn messy speech into todo candidates. Return ONLY compact JSON, no Markdown/prose:
{"candidates":[{"title":"...","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"todo"}]}
If nothing useful/actionable was said, return {"candidates":[]}.

Rules:
- Extract intent, not dictation. Keep each title in the same language as that spoken item. Never translate nouns or task titles.
- Split unrelated tasks/items. Merge duplicates and wording variants.
- Latest correction wins. Remove negated/replaced items completely (e.g. "no chips", "Kaffee nicht", "sin leche", "Nachos statt Chips").
- Ignore filler, tests, thanks, meta talk, completed actions, and questions.
- Never invent projects/sections. Use only exact names from Workspace context when clearly fitting; otherwise null.
- Actively choose a section when an existing section is semantically appropriate, even if its exact words were not spoken. Use category knowledge: map items to the closest existing section by meaning (e.g. a cheese can fit a dairy section, a snack can fit a sweets/snacks section, a beverage can fit a drinks section).
- If no existing section is clearly semantically appropriate, leave section_name null. Do not create new section names.
- If a transcript names a section under a project, use that exact project + section from Workspace.

Kinds:
- todo = action to do. shopping = buy/obtain item. reminder = explicit timed follow-up. appointment = event-like task. note = useful info, not actionable.

Shopping:
- Detect direct and indirect buying needs in any language (e.g. "need", "brauche", "ist leer", "no queda", "il manque").
- Output each shopping item separately. Do not output whole sentences.
- Do not mark non-shopping tasks as shopping just because a list exists.

Time:
- Convert clear relative/absolute times to ISO-8601 with timezone when possible.
- Common relative words: tomorrow/morgen/mañana/demain, day after tomorrow/übermorgen/pasado mañana/après-demain. evening/Abend/noche/soir=19:00, afternoon/Nachmittag/tarde=15:00, noon/Mittag/midi=12:00, morning/früh/matin=09:00.
- reminder/deadline must be ISO or null; never natural language.
- If only a date is known, use deadline, leave reminder null unless an explicit reminder was requested.

Examples:
Transcript: "I need potatoes, strawberries, chips, actually no chips, but coconut milk."
JSON: {"candidates":[{"title":"potatoes","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"shopping"},{"title":"strawberries","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"shopping"},{"title":"coconut milk","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"shopping"}]}
Transcript: "Necesito huevos y papel higiénico. Mañana revisar los documentos de impuestos."
JSON: {"candidates":[{"title":"huevos","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"shopping"},{"title":"papel higiénico","project_name":null,"section_name":null,"deadline":null,"reminder":null,"kind":"shopping"},{"title":"revisar los documentos de impuestos","project_name":null,"section_name":null,"deadline":"mañana","reminder":null,"kind":"todo"}]}
Transcript: "Ähm danke, ich teste nur kurz."
JSON: {"candidates":[]}
"""

BRAINDUMP_CONFIG_KEYS = (
    "braindump_enabled",
    "braindump_llm_provider",
    "braindump_llm_base_url",
    "braindump_llm_api_key",
    "braindump_llm_model",
    "braindump_llm_extra_headers_json",
    "braindump_llm_timeout_seconds",
    "braindump_system_prompt_mode",
    "braindump_system_prompt_custom",
    "braindump_stt_provider",
    "braindump_stt_url",
    "braindump_stt_token",
    "braindump_stt_language",
    "braindump_stt_timeout_seconds",
    # Legacy OpenClaw-specific keys, read for migration/backward compatibility.
    "braindump_openclaw_url",
    "braindump_openclaw_token",
    "braindump_openclaw_model",
    "braindump_openclaw_backend_model",
)

DEFAULT_BRAINDUMP_CONFIG = {
    "enabled": False,
    "llm_provider": "openai_compatible",
    "llm_base_url": "",
    "llm_api_key": "",
    "llm_model": "",
    "llm_extra_headers_json": "",
    "llm_timeout_seconds": 180.0,
    "system_prompt_mode": "default",
    "system_prompt_custom": "",
    "stt_provider": "whisper_cpp_remote",
    "stt_url": "",
    "stt_token": "",
    "stt_language": "",
    "stt_timeout_seconds": 60.0,
}

KEY_TO_FIELD = {
    "braindump_enabled": "enabled",
    "braindump_llm_provider": "llm_provider",
    "braindump_llm_base_url": "llm_base_url",
    "braindump_llm_api_key": "llm_api_key",
    "braindump_llm_model": "llm_model",
    "braindump_llm_extra_headers_json": "llm_extra_headers_json",
    "braindump_llm_timeout_seconds": "llm_timeout_seconds",
    "braindump_system_prompt_mode": "system_prompt_mode",
    "braindump_system_prompt_custom": "system_prompt_custom",
    "braindump_stt_provider": "stt_provider",
    "braindump_stt_url": "stt_url",
    "braindump_stt_token": "stt_token",
    "braindump_stt_language": "stt_language",
    "braindump_stt_timeout_seconds": "stt_timeout_seconds",
}

LEGACY_KEY_TO_FIELD = {
    "braindump_openclaw_url": "llm_base_url",
    "braindump_openclaw_token": "llm_api_key",
    "braindump_openclaw_model": "llm_model",
}

FIELD_TO_KEY = {field: key for key, field in KEY_TO_FIELD.items()}
SUPPORTED_STT_PROVIDERS = {"whisper_cpp_remote", "local_whisper_cpp"}
SUPPORTED_LLM_PROVIDERS = {"openai_compatible", "ollama"}
SUPPORTED_SYSTEM_PROMPT_MODES = {"default", "append", "replace"}


def _ollama_endpoint_url(config: dict[str, Any], endpoint: str) -> str:
    raw = str(config.get("llm_base_url") or "").strip().rstrip("/")
    if not raw:
        raise HTTPException(400, "LLM base URL is not configured")
    parsed = urlparse(raw)
    path = parsed.path.rstrip("/")
    if path.endswith(f"/api/{endpoint}"):
        final_path = path
    elif path.endswith("/api/chat") or path.endswith("/api/tags"):
        final_path = f"{path.rsplit('/', 1)[0]}/{endpoint}"
    elif path.endswith("/api"):
        final_path = f"{path}/{endpoint}"
    else:
        final_path = f"{path}/api/{endpoint}"
    return urlunparse((parsed.scheme, parsed.netloc, final_path, "", "", ""))


def _llm_endpoint_url(config: dict[str, Any], endpoint: str) -> str:
    provider = str(config.get("llm_provider") or DEFAULT_BRAINDUMP_CONFIG["llm_provider"]).strip().lower()
    if provider == "ollama":
        return _ollama_endpoint_url(config, "chat" if endpoint == "chat/completions" else "tags")
    raw = str(config.get("llm_base_url") or "").strip().rstrip("/")
    if not raw:
        raise HTTPException(400, "LLM base URL is not configured")
    parsed = urlparse(raw)
    path = parsed.path.rstrip("/")
    if path.endswith("/v1/chat/completions"):
        final_path = path if endpoint == "chat/completions" else path[: -len("/chat/completions")] + "/models"
    elif path.endswith("/v1/models"):
        final_path = path if endpoint == "models" else path[: -len("/models")] + "/chat/completions"
    elif path.endswith("/v1"):
        final_path = f"{path}/{endpoint}"
    else:
        final_path = f"{path}/v1/{endpoint}"
    return urlunparse((parsed.scheme, parsed.netloc, final_path, "", "", ""))


def llm_chat_url(config: dict[str, Any]) -> str:
    return _llm_endpoint_url(config, "chat/completions")


def llm_models_url(config: dict[str, Any]) -> str:
    return _llm_endpoint_url(config, "models")


# Backward-compatible aliases for older imports/tests.
openclaw_chat_url = llm_chat_url
openclaw_models_url = llm_models_url


def build_effective_system_prompt(config: dict[str, Any] | None = None) -> str:
    config = config or {}
    mode = str(config.get("system_prompt_mode") or "default").strip().lower()
    custom = str(config.get("system_prompt_custom") or "").strip()
    if mode == "replace" and custom:
        return custom
    if mode == "append" and custom:
        return f"{DEFAULT_BRAINDUMP_SYSTEM_PROMPT.rstrip()}\n\nAdditional admin instructions:\n{custom}"
    return DEFAULT_BRAINDUMP_SYSTEM_PROMPT


def parse_extra_headers(value: str | None) -> dict[str, str]:
    raw = str(value or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"LLM extra headers must be valid JSON: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(400, "LLM extra headers must be a JSON object")
    headers: dict[str, str] = {}
    forbidden = {"authorization", "content-type"}
    for key, item in parsed.items():
        header = str(key).strip()
        if not header or header.lower() in forbidden or any(ch in header for ch in "\r\n:"):
            raise HTTPException(400, f"LLM extra header is not allowed: {header}")
        value_str = str(item).strip()
        if any(ch in value_str for ch in "\r\n"):
            raise HTTPException(400, f"LLM extra header contains invalid characters: {header}")
        headers[header] = value_str
    return headers


def _normalize_llm_provider(value: str) -> str:
    provider = str(value or DEFAULT_BRAINDUMP_CONFIG["llm_provider"]).strip().lower()
    if provider not in SUPPORTED_LLM_PROVIDERS:
        raise HTTPException(400, f"Unsupported BrainDump LLM provider: {provider}")
    return provider


def _normalize_model(value: str) -> str:
    model = str(value or "").strip()
    if not model:
        return ""
    if any(ch.isspace() for ch in model) or len(model) > 160:
        raise HTTPException(400, "LLM model is invalid")
    return model


def _normalize_extra_headers_json(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if len(raw) > 4096:
        raise HTTPException(400, "LLM extra headers are too long")
    headers = parse_extra_headers(raw)
    return json.dumps(headers, ensure_ascii=False, separators=(",", ":"))


def _normalize_token(value: Optional[str]) -> str:
    token = str(value or "").strip()
    if len(token) > 4096:
        raise HTTPException(400, "Token is too long")
    return token


def _normalize_prompt_mode(value: str) -> str:
    mode = str(value or "default").strip().lower()
    if mode not in SUPPORTED_SYSTEM_PROMPT_MODES:
        raise HTTPException(400, "System prompt mode must be default, append, or replace")
    return mode


def _normalize_custom_prompt(value: str | None) -> str:
    prompt = str(value or "").strip()
    if len(prompt) > 20000:
        raise HTTPException(400, "System prompt is too long")
    return prompt


def _normalize_stt_provider(value: str) -> str:
    provider = str(value or DEFAULT_BRAINDUMP_CONFIG["stt_provider"]).strip().lower()
    if provider not in SUPPORTED_STT_PROVIDERS:
        raise HTTPException(400, f"Unsupported BrainDump STT provider: {provider}")
    return provider


def _normalize_language(value: str) -> str:
    language = str(value or "").strip().lower()
    if len(language) > 16:
        raise HTTPException(400, "STT language is invalid")
    return language


def _normalize_enabled(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    return text in {"1", "true", "yes", "on", "enabled"}


def _normalize_timeout(value: Any, *, label: str) -> float:
    try:
        timeout = float(value)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{label} timeout must be a number")
    if timeout < 1 or timeout > 300:
        raise HTTPException(400, f"{label} timeout must be between 1 and 300 seconds")
    return timeout


def normalize_braindump_config(data: dict[str, Any], *, existing: dict[str, Any] | None = None) -> dict[str, Any]:
    current = {**DEFAULT_BRAINDUMP_CONFIG, **(existing or {})}
    normalized = {
        "enabled": _normalize_enabled(data.get("enabled", current["enabled"])),
        "llm_provider": _normalize_llm_provider(data.get("llm_provider", current["llm_provider"])),
        "llm_base_url": _normalize_http_url(data.get("llm_base_url", current["llm_base_url"]), field="LLM base URL", allow_empty=True),
        "llm_api_key": current.get("llm_api_key") or "",
        "llm_model": _normalize_model(data.get("llm_model", current["llm_model"])),
        "llm_extra_headers_json": _normalize_extra_headers_json(data.get("llm_extra_headers_json", current["llm_extra_headers_json"])),
        "llm_timeout_seconds": _normalize_timeout(data.get("llm_timeout_seconds", current["llm_timeout_seconds"]), label="LLM"),
        "system_prompt_mode": _normalize_prompt_mode(data.get("system_prompt_mode", current["system_prompt_mode"])),
        "system_prompt_custom": _normalize_custom_prompt(data.get("system_prompt_custom", current["system_prompt_custom"])),
        "stt_provider": _normalize_stt_provider(data.get("stt_provider", current["stt_provider"])),
        "stt_url": _normalize_http_url(data.get("stt_url", current["stt_url"]), field="STT URL", allow_empty=True),
        "stt_token": current.get("stt_token") or "",
        "stt_language": _normalize_language(data.get("stt_language", current["stt_language"])),
        "stt_timeout_seconds": _normalize_timeout(data.get("stt_timeout_seconds", current["stt_timeout_seconds"]), label="STT"),
    }
    if "llm_api_key_secret" in data and data.get("llm_api_key_secret") is not None:
        normalized["llm_api_key"] = _normalize_token(data.get("llm_api_key_secret"))
    if "stt_token_secret" in data and data.get("stt_token_secret") is not None:
        normalized["stt_token"] = _normalize_token(data.get("stt_token_secret"))
    if normalized["enabled"]:
        if not normalized["llm_base_url"]:
            raise HTTPException(400, "LLM base URL is required when BrainDump is enabled")
        if not normalized["llm_model"]:
            raise HTTPException(400, "LLM model is required when BrainDump is enabled")
        if normalized["stt_provider"] == "whisper_cpp_remote" and not normalized["stt_url"]:
            raise HTTPException(400, "STT URL is required when BrainDump remote STT is enabled")
    return normalized


def _parse_value(field: str, value: str | None) -> Any:
    if value is None:
        return DEFAULT_BRAINDUMP_CONFIG[field]
    if field == "enabled":
        return _normalize_enabled(value)
    if field in {"stt_timeout_seconds", "llm_timeout_seconds"}:
        return _normalize_timeout(value, label="STT" if field.startswith("stt") else "LLM")
    if field in {"llm_base_url", "stt_url"}:
        return _normalize_http_url(value, field="LLM base URL" if field == "llm_base_url" else "STT URL", allow_empty=True)
    if field == "llm_provider":
        return _normalize_llm_provider(value)
    if field == "llm_model":
        return _normalize_model(value)
    if field == "llm_extra_headers_json":
        return _normalize_extra_headers_json(value)
    if field == "system_prompt_mode":
        return _normalize_prompt_mode(value)
    if field == "system_prompt_custom":
        return _normalize_custom_prompt(value)
    if field == "stt_provider":
        return _normalize_stt_provider(value)
    if field == "stt_language":
        return _normalize_language(value)
    if field in {"llm_api_key", "stt_token"}:
        return _normalize_token(value)
    return value


def get_braindump_config(*, include_secrets: bool = False) -> dict[str, Any]:
    values = dict(DEFAULT_BRAINDUMP_CONFIG)
    rows = []
    try:
        with get_db() as db:
            placeholders = ",".join("?" for _ in BRAINDUMP_CONFIG_KEYS)
            rows = db.execute(f"SELECT key, value FROM app_config WHERE key IN ({placeholders})", BRAINDUMP_CONFIG_KEYS).fetchall()
    except Exception:
        rows = []
    present_new_fields = set()
    legacy_backend_model = ""
    for row in rows:
        key = row["key"]
        field = KEY_TO_FIELD.get(key)
        if field:
            present_new_fields.add(field)
            try:
                values[field] = _parse_value(field, row["value"])
            except HTTPException:
                values[field] = DEFAULT_BRAINDUMP_CONFIG[field]
            continue
        legacy_field = LEGACY_KEY_TO_FIELD.get(key)
        if legacy_field and legacy_field not in present_new_fields:
            try:
                values[legacy_field] = _parse_value(legacy_field, row["value"])
            except HTTPException:
                values[legacy_field] = DEFAULT_BRAINDUMP_CONFIG[legacy_field]
        elif key == "braindump_openclaw_backend_model":
            legacy_backend_model = str(row["value"] or "").strip()
    if legacy_backend_model and not values.get("llm_extra_headers_json"):
        values["llm_extra_headers_json"] = _normalize_extra_headers_json(json.dumps({"x-openclaw-model": legacy_backend_model}))
    if include_secrets:
        return values
    public = {key: value for key, value in values.items() if key not in {"llm_api_key", "stt_token"}}
    public["llm_api_key_configured"] = bool(values.get("llm_api_key"))
    public["stt_token_configured"] = bool(values.get("stt_token"))
    public["default_system_prompt"] = DEFAULT_BRAINDUMP_SYSTEM_PROMPT
    return public


def update_braindump_config(data: dict[str, Any], *, client_ip: Optional[str] = None) -> dict[str, Any]:
    existing = get_braindump_config(include_secrets=True)
    normalized = normalize_braindump_config(data, existing=existing)
    serialized = {FIELD_TO_KEY[key]: str(value) for key, value in normalized.items()}
    old_serialized = {FIELD_TO_KEY[key]: str(value) for key, value in existing.items()}
    changed = [key for key, value in serialized.items() if old_serialized.get(key) != value]
    public_changed = [key for key in changed if key not in {"braindump_llm_api_key", "braindump_stt_token"}]
    if "braindump_llm_api_key" in changed:
        public_changed.append("braindump_llm_api_key")
    if "braindump_stt_token" in changed:
        public_changed.append("braindump_stt_token")
    with get_db() as db:
        for key, value in serialized.items():
            db.execute(
                """INSERT INTO app_config (key, value, updated_at)
                   VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')""",
                (key, value),
            )
        if changed:
            db.execute(
                "INSERT INTO app_config_audit (changed_keys, client_ip) VALUES (?, ?)",
                (json.dumps(public_changed, separators=(",", ":")), client_ip),
            )
        db.commit()
    return get_braindump_config(include_secrets=False)
