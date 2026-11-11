"""Account-wide module visibility normalization and serialization."""

import json
import re
from functools import lru_cache
from pathlib import Path

MODULE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
MAX_DISABLED_MODULE_IDS = 128
MODULE_REGISTRY_PATH = Path(__file__).resolve().parents[2] / "web" / "static" / "js" / "modules" / "registry.js"
MODULE_REGISTRY_PATTERN = re.compile(r"REGISTERED_MODULE_IDS\s*=\s*Object\.freeze\((\[[^;]+\])\);", re.DOTALL)


@lru_cache(maxsize=1)
def registered_module_ids() -> tuple[str, ...]:
    match = MODULE_REGISTRY_PATTERN.search(MODULE_REGISTRY_PATH.read_text())
    if not match:
        raise RuntimeError("Could not read registered module ids")
    values = json.loads(match.group(1))
    normalized = normalize_disabled_modules(values)
    if not normalized or len(normalized) != len(values):
        raise RuntimeError("Registered module ids are invalid")
    return tuple(normalized)


def normalize_disabled_modules(module_ids) -> list[str]:
    if not isinstance(module_ids, list):
        return []
    normalized = []
    seen = set()
    for module_id in module_ids[:MAX_DISABLED_MODULE_IDS]:
        if not isinstance(module_id, str) or not MODULE_ID_PATTERN.fullmatch(module_id) or module_id in seen:
            continue
        seen.add(module_id)
        normalized.append(module_id)
    return normalized


def has_enabled_registered_module(disabled_modules) -> bool:
    disabled = set(normalize_disabled_modules(disabled_modules))
    registered = registered_module_ids()
    return bool(registered) and any(module_id not in disabled for module_id in registered)


def normalized_user_disabled_modules(module_ids) -> list[str]:
    disabled = normalize_disabled_modules(module_ids)
    registered = registered_module_ids()
    if registered and all(module_id in disabled for module_id in registered):
        disabled.remove(registered[0])
    return disabled


def module_preferences_payload(row) -> dict:
    payload = dict(row)
    raw = payload.get("disabled_modules_json", "[]")
    try:
        disabled_modules = json.loads(raw or "[]")
    except (TypeError, ValueError):
        disabled_modules = []
    return {"disabled_modules": normalized_user_disabled_modules(disabled_modules)}
