"""Normalize known unit spellings without changing the amount or unknown units."""

from __future__ import annotations

import json
import unicodedata
from functools import lru_cache
from pathlib import Path

UNIT_DATA_PATH = Path(__file__).resolve().parents[1] / "resources" / "quantity_units.json"


def unit_key(value: str, *, fold_case: bool = True) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return " ".join((normalized.casefold() if fold_case else normalized).split()).rstrip(".")


@lru_cache(maxsize=1)
def _unit_aliases() -> tuple[dict[str, str], dict[str, str]]:
    data = json.loads(UNIT_DATA_PATH.read_text(encoding="utf-8"))
    choices: dict[str, set[str]] = {}
    exact_choices: dict[str, set[str]] = {}
    for symbol, aliases in data["units"].items():
        for alias in [symbol, *aliases]:
            choices.setdefault(unit_key(alias), set()).add(symbol)
            exact_choices.setdefault(unit_key(alias, fold_case=False), set()).add(symbol)
    # A short spelling shared by different units must not silently pick one.
    result = {key: next(iter(symbols)) for key, symbols in choices.items() if len(symbols) == 1}
    exact = {key: next(iter(symbols)) for key, symbols in exact_choices.items() if len(symbols) == 1}
    for symbol in data["units"]:
        result[unit_key(symbol)] = symbol
        exact[unit_key(symbol, fold_case=False)] = symbol
    return exact, result


def normalize_quantity_unit(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    exact, words = _unit_aliases()
    key = unit_key(cleaned, fold_case=False)
    if key in exact:
        return exact[key]
    # SI prefixes are case-sensitive: unknown ML/Mg must not become ml/mg.
    # Known variants such as L/mL are recognized by the exact registry above.
    if len(key) <= 3 and key.isalnum():
        return cleaned
    return words.get(unit_key(cleaned), cleaned)
