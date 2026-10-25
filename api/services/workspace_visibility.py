"""Workspace module visibility normalization and serialization."""

import json
import re
from functools import lru_cache
from pathlib import Path

MODULE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
MAX_WORKSPACE_MODULE_IDS = 128
MODULE_REGISTRY_PATH = Path(__file__).resolve().parents[2] / "web" / "static" / "js" / "modules" / "registry.js"
MODULE_REGISTRY_PATTERN = re.compile(r"REGISTERED_MODULE_IDS\s*=\s*Object\.freeze\((\[[^;]+\])\);", re.DOTALL)


@lru_cache(maxsize=1)
def registered_module_ids() -> tuple[str, ...]:
    match = MODULE_REGISTRY_PATTERN.search(MODULE_REGISTRY_PATH.read_text())
    if not match:
        raise RuntimeError("Could not read registered module ids")
    values = json.loads(match.group(1))
    normalized = normalize_hidden_modules(values)
    if not normalized or len(normalized) != len(values):
        raise RuntimeError("Registered module ids are invalid")
    return tuple(normalized)


def normalize_hidden_modules(module_ids) -> list[str]:
    if not isinstance(module_ids, list):
        return []
    normalized = []
    seen = set()
    for module_id in module_ids[:MAX_WORKSPACE_MODULE_IDS]:
        if not isinstance(module_id, str) or not MODULE_ID_PATTERN.fullmatch(module_id) or module_id in seen:
            continue
        seen.add(module_id)
        normalized.append(module_id)
    return normalized


def has_visible_registered_module(hidden_modules) -> bool:
    hidden = set(normalize_hidden_modules(hidden_modules))
    registered = registered_module_ids()
    return bool(registered) and any(module_id not in hidden for module_id in registered)


def normalized_workspace_hidden_modules(module_ids) -> list[str]:
    hidden = normalize_hidden_modules(module_ids)
    registered = registered_module_ids()
    if registered and all(module_id in hidden for module_id in registered):
        hidden.remove(registered[0])
    return hidden


def workspace_payload(row) -> dict:
    payload = dict(row)
    raw = payload.pop("hidden_modules_json", "[]")
    try:
        hidden_modules = json.loads(raw or "[]")
    except (TypeError, ValueError):
        hidden_modules = []
    payload["hidden_modules"] = normalized_workspace_hidden_modules(hidden_modules)
    return payload
