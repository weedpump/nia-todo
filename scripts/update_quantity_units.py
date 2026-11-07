#!/usr/bin/env python3
"""Regenerate the small unit alias registry from a pinned Unicode CLDR release.

This maintenance command downloads public locale data; tests use the checked-in
registry and do not need network access. No quantities or unit conversions occur.
"""

import json
import re
import urllib.request
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


def main():
    aliases = {symbol: set() for symbol in UNITS.values()}
    with ThreadPoolExecutor(max_workers=4) as executor:
        for result in executor.map(locale_aliases, LOCALES.values()):
            for symbol, values in result.items():
                aliases[symbol].update(values)
    for symbol, values in EXTRA_ALIASES.items():
        aliases[symbol].update(values)
    for values in aliases.values():
        values.difference_update(alias for alias in list(values) if alias.casefold() in AMBIGUOUS_ALIASES)
    target = ROOT / "api/resources"
    target.mkdir(parents=True, exist_ok=True)
    payload = {"source": f"https://github.com/unicode-org/cldr-json/tree/{VERSION}",
               "license": "Unicode-3.0", "locales": list(LOCALES),
               "units": {symbol: sorted(values) for symbol, values in sorted(aliases.items())}}
    (target / "quantity_units.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with urllib.request.urlopen(f"{SOURCE}/LICENSE", timeout=30) as response:
        (target / "quantity_units.LICENSE").write_bytes(response.read())
    print(f"Generated {len(aliases)} units for {len(LOCALES)} locales")


if __name__ == "__main__":
    main()
