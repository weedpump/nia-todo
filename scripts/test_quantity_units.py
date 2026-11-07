#!/usr/bin/env python3
"""Unit spelling regressions using the checked-in registry, without a database."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
from services.quantity_units import UNIT_DATA_PATH, normalize_quantity_unit

examples = {
    "cs": "litrů", "de": "Litern", "en": "litres", "es": "litros", "fr": "litres",
    "it": "litri", "nl": "liters", "pl": "litrów", "pt-BR": "litros", "ru": "литра",
    "sv": "liter", "zh-CN": "升",
}
for locale, value in examples.items():
    assert normalize_quantity_unit(value) == "l", (locale, value)
for value, expected in {
    "  LITER  ": "l", "l.": "l", "L": "l", "mL": "ml", "millilitres": "ml", "Millilitern": "ml",
    "килограммов": "kg", "kilogrammes": "kg", "gramos": "g", "毫升": "ml", "公斤": "kg",
    "DEZILITER": "dl", "centilitres": "cl", "μg": "µg", "㎏": "kg", "cm³": "cm³",
}.items():
    assert normalize_quantity_unit(value) == expected, (value, expected)
for value in ("Pfund", "oz", "pcs", "EL", "Packung", "g/l", "100 g", "My custom unit", "ML", "Mg", "ton", "tons"):
    assert normalize_quantity_unit(value) == value, value
assert normalize_quantity_unit(None) is None
assert normalize_quantity_unit(" \t ") is None
data = json.loads(UNIT_DATA_PATH.read_text())
assert set(data["locales"]) == {p.stem for p in (ROOT / "web/static/i18n").glob("*.json")}
for symbol in data["units"]:
    assert normalize_quantity_unit(symbol) == symbol, symbol
print(f"✅ Shared unit spellings, plural forms, Unicode and unknown-unit preservation passed in {len(examples)} locales")
