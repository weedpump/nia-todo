#!/usr/bin/env python3
"""Regenerate the small unit alias registry from a pinned Unicode CLDR release.

This maintenance command downloads public locale data; tests use the checked-in
registry and do not need network access. No quantities or unit conversions occur.
"""

import json
import re
import urllib.request
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "48.2.3"
SOURCE = f"https://raw.githubusercontent.com/unicode-org/cldr-json/{VERSION}"
LOCALES = {"cs": "cs", "de": "de", "en": "en", "es": "es", "fr": "fr", "it": "it",
           "nl": "nl", "pl": "pl", "pt-BR": "pt", "ru": "ru", "sv": "sv", "zh-CN": "zh"}
UNITS = {
    "mass-tonne": "t", "mass-kilogram": "kg", "mass-gram": "g",
    "mass-milligram": "mg", "mass-microgram": "µg",
    "volume-hectoliter": "hl", "volume-liter": "l", "volume-deciliter": "dl",
    "volume-centiliter": "cl", "volume-milliliter": "ml",
    "length-kilometer": "km", "length-meter": "m", "length-centimeter": "cm", "length-millimeter": "mm",
    "area-square-meter": "m²", "volume-cubic-meter": "m³", "volume-cubic-centimeter": "cm³",
}
# Common spoken alternatives beyond CLDR's preferred formatting forms.
EXTRA_ALIASES = {"kg": {"kilo", "kilos", "килограммов", "公斤"}, "g": {"граммов", "公克"},
                 "mg": {"миллиграммов"}, "µg": {"микрограммов"}, "l": {"公升"}}
# Across languages these may also mean imperial tons, not metric tonnes.
AMBIGUOUS_ALIASES = {"ton", "tons"}


def locale_aliases(locale):
    url = f"{SOURCE}/cldr-json/cldr-units-full/main/{locale}/units.json"
    with urllib.request.urlopen(url, timeout=30) as response:
        data = json.load(response)["main"][locale]["units"]
    result = {symbol: set() for symbol in UNITS.values()}
    for style in ("long", "short", "narrow"):
        for unit, symbol in UNITS.items():
            for key, pattern in data[style][unit].items():
                if key == "displayName":
                    result[symbol].add(pattern)
                elif "-count-" in key and pattern.count("{0}") == 1:
                    alias = pattern.replace("{0}", "").strip()
                    if alias and not re.search(r"[{}]", alias):
                        result[symbol].add(alias)
    return result


def merge_registry(existing, cldr_aliases):
    """Refresh CLDR spellings without replacing application-owned semantics.

    Definitions, fixed display labels, rounding and manual aliases live in the
    canonical registry. A new unit must be explicitly defined there first.
    """
    if not isinstance(existing, dict) or not isinstance(existing.get("units"), dict):
        raise ValueError("An existing canonical quantity registry is required")
    definitions = existing.get("definitions")
    if not isinstance(definitions, dict) or not definitions or set(definitions) != set(existing["units"]):
        raise ValueError("Canonical quantity definitions must exist for every registered unit")
    if not isinstance(existing.get("recipe_rounding"), dict) or not existing["recipe_rounding"]:
        raise ValueError("Canonical recipe_rounding policy is required")
    unknown = set(cldr_aliases) - set(definitions)
    if unknown:
        raise ValueError(f"Define new CLDR units in the canonical registry first: {', '.join(sorted(unknown))}")
    units = {}
    for symbol, aliases in existing["units"].items():
        if not isinstance(aliases, list) or not all(isinstance(alias, str) for alias in aliases):
            raise ValueError(f"Canonical aliases must be a string list for {symbol}")
        incoming = cldr_aliases.get(symbol, ())
        if not all(isinstance(alias, str) for alias in incoming):
            raise ValueError(f"CLDR aliases must be strings for {symbol}")
        # Preserve every reviewed alias, including manual additions to metric
        # units. Exclude ambiguous spellings only from the downloaded additions.
        additions = {alias for alias in incoming if alias.casefold() not in AMBIGUOUS_ALIASES}
        units[symbol] = sorted(set(aliases) | additions)
    result = deepcopy(existing)
    result.update(source=f"https://github.com/unicode-org/cldr-json/tree/{VERSION}",
                  license="Unicode-3.0", locales=list(LOCALES),
                  units={symbol: units[symbol] for symbol in sorted(units)})
    return result


def main():
    target = ROOT / "api/resources"
    registry_path = target / "quantity_units.json"
    if not registry_path.exists():
        raise SystemExit("An existing canonical quantity_units.json with definitions and recipe_rounding is required")
    existing = json.loads(registry_path.read_text(encoding="utf-8"))
    # Reject missing application semantics before making any network requests.
    merge_registry(existing, {})
    aliases = {symbol: set() for symbol in UNITS.values()}
    with ThreadPoolExecutor(max_workers=4) as executor:
        for result in executor.map(locale_aliases, LOCALES.values()):
            for symbol, values in result.items():
                aliases[symbol].update(values)
    for symbol, values in EXTRA_ALIASES.items():
        aliases[symbol].update(values)
    payload = merge_registry(existing, aliases)
    with urllib.request.urlopen(f"{SOURCE}/LICENSE", timeout=30) as response:
        license_content = response.read()
    registry_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (target / "quantity_units.LICENSE").write_bytes(license_content)
    print(f"Refreshed {len(payload['units'])} units for {len(LOCALES)} locales")


if __name__ == "__main__":
    main()
