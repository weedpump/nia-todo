"""Normalize known unit spellings without changing the amount or unknown units."""

from __future__ import annotations

import json
import unicodedata
from functools import lru_cache
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP, localcontext

UNIT_DATA_PATH = Path(__file__).resolve().parents[1] / "resources" / "quantity_units.json"


def unit_key(value: str, *, fold_case: bool = True) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return " ".join((normalized.casefold() if fold_case else normalized).split()).rstrip(".")


@lru_cache(maxsize=1)
def _unit_data() -> dict:
    return json.loads(UNIT_DATA_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _unit_aliases() -> tuple[dict[str, str], dict[str, str]]:
    data = _unit_data()
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
    folded = words.get(unit_key(cleaned))
    folded_kind = _unit_data().get("definitions", {}).get(folded, {}).get("kind")
    if len(key) <= 3 and key.isalnum() and folded_kind not in ("count", "spoon", "other"):
        return cleaned
    return folded or cleaned


def get_unit_definition(unit: str | None) -> dict | None:
    """Return registered semantics, without inventing semantics for unknowns."""
    return _unit_data().get("definitions", {}).get(normalize_quantity_unit(unit))


def round_recipe_quantity(amount: Decimal, unit: str | None) -> tuple[Decimal, str | None]:
    """Return kitchen display quantities; never use these values for storage.

    Counts, spoons and unknown units remain exact. Metric quantities use their
    registered base unit for fractional large units, preserving tiny amounts.
    """
    if not amount.is_finite() or amount < 0:
        raise ValueError("Recipe quantities must be finite and nonnegative")
    unit = normalize_quantity_unit(unit)
    definition = get_unit_definition(unit)
    if amount == 0 or definition is None or definition["kind"] not in ("mass", "volume"):
        return amount, unit
    with localcontext() as context:
        # quantize needs every integer digit, including finite float maxima.
        context.prec = max(34, len(amount.as_tuple().digits), amount.adjusted() + 1) + 10
        factor = Decimal(definition["factor"])
        if factor > 1 and amount != amount.to_integral_value():
            amount, unit = amount * factor, definition["base_unit"]
        rounding = _unit_data()["recipe_rounding"]
        if amount < Decimal(str(rounding["metric_half_from"])):
            return amount, unit
        rounded = (amount.quantize(Decimal(1), rounding=ROUND_HALF_UP) if amount >= Decimal(str(rounding["metric_whole_from"])) else
                   (amount * 2).quantize(Decimal(1), rounding=ROUND_HALF_UP) / 2)
        return rounded, unit


def convert_quantity(value: Decimal, source_unit: str | None, target_unit: str | None) -> Decimal | None:
    source, target = normalize_quantity_unit(source_unit), normalize_quantity_unit(target_unit)
    if source == target:
        return value
    left, right = get_unit_definition(source), get_unit_definition(target)
    if (left is None or right is None or left["kind"] not in ("mass", "volume")
            or left["kind"] != right["kind"] or left["base_unit"] != right["base_unit"]):
        return None
    return value * Decimal(left["factor"]) / Decimal(right["factor"])
