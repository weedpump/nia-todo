#!/usr/bin/env python3
"""Unit spelling regressions using the checked-in registry, without a database."""

import json
import subprocess
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
from services.quantity_units import UNIT_DATA_PATH, convert_quantity, get_unit_definition, normalize_quantity_unit, round_recipe_quantity

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
    "pcs": "piece", "Stück": "piece", "Packung": "pack", "EL": "tbsp", "TL": "tsp",
}.items():
    assert normalize_quantity_unit(value) == expected, (value, expected)
for value in ("Pfund", "g/l", "100 g", "My custom unit", "ML", "Mg", "ton", "tons", "Lita"):
    assert normalize_quantity_unit(value) == value, value
assert normalize_quantity_unit(None) is None
assert normalize_quantity_unit(" \t ") is None
data = json.loads(UNIT_DATA_PATH.read_text())
assert set(data["locales"]) == {p.stem for p in (ROOT / "web/static/i18n").glob("*.json")}
for symbol in data["units"]:
    assert normalize_quantity_unit(symbol) == symbol, symbol
assert set(data["definitions"]) == set(data["units"])
for symbol, definition in data["definitions"].items():
    assert get_unit_definition(symbol) == definition
    assert definition["kind"] in {"mass", "volume", "count", "spoon", "other"}
    if definition["kind"] in {"count", "spoon"}:
        assert set(definition["labels"]) == set(data["locales"])
assert get_unit_definition("Lita") is None
assert convert_quantity(Decimal(1000), "mg", "grams") == 1
assert convert_quantity(Decimal(2), "EL", "tbsp") == 2
assert convert_quantity(Decimal(2), "pcs", "Stück") == 2
for left, right in (("tsp", "tbsp"), ("tsp", "ml"), ("pack", "piece"), ("oz", "g"), ("g", "ml")):
    assert convert_quantity(Decimal(1), left, right) is None, (left, right)
print(f"✅ Shared unit spellings, plural forms, Unicode and unknown-unit preservation passed in {len(examples)} locales")

# One checked-in source, with an offline/DOM-free frontend implementation.
subprocess.run([sys.executable, str(ROOT / "scripts/generate_quantity_unit_data.py"), "--check"], check=True)
frontend_cases = [None, "", " \t ", "L", "Liter", "litres", "grams", "ML", "Mg", "ton", "tons",
                  "μg", "㎏", "毫升", "公斤", "КИЛОГРАММОВ", "\u0085Liter\u0085", "cm³", "g/l", "\ufeffLiter"]
for symbol, aliases in data["units"].items():
    for alias in [symbol, *aliases]:
        frontend_cases.extend([alias, alias.upper(), f"  {alias}.  "])
node = subprocess.run(
    ["node", "--input-type=module", "-e",
     "import { normalizeQuantityUnit } from './web/static/js/core/quantity-units.js';"
     "let input='';for await(const chunk of process.stdin)input+=chunk;"
     "process.stdout.write(JSON.stringify(JSON.parse(input).map(normalizeQuantityUnit)));"],
    input=json.dumps(frontend_cases, ensure_ascii=False), text=True, capture_output=True, cwd=ROOT, check=True,
)
frontend_results = json.loads(node.stdout)
assert len(frontend_results) == len(frontend_cases)
for value, actual in zip(frontend_cases, frontend_results):
    expected = normalize_quantity_unit(value)
    assert actual == expected, (value, actual, expected)
print("✅ Generated offline frontend registry and alias normalization match the backend")

rounding_cases = [(row["amount"], row["unit"], row["value"], row["result_unit"])
                  for row in json.loads((ROOT / "scripts/fixtures/recipe_quantity_rounding.json").read_text())]
rounding_cases += [
    ("0.00025", "kg", "0.25", "g"), ("0.00025", "g", "0.00025", "g"),
    ("0.00025", "mg", "0.00025", "mg"), ("0.1", "ml", "0.1", "ml"),
    ("0.5", "dl", "50", "ml"), ("0.25", "dl", "25", "ml"),
    ("1.25", "EL", "1.25", "tbsp"), ("0.1", None, "0.1", None),
    ("0", "kg", "0", "kg"), ("1e308", "kg", "1e308", "kg"),
    ("1" + "0" * 308 + ".25", "g", "1" + "0" * 308, "g"),
]
for value, unit, expected, expected_unit in rounding_cases:
    assert round_recipe_quantity(Decimal(value), unit) == (Decimal(expected), expected_unit), (value, unit)
for invalid in ("NaN", "Infinity", "-Infinity", "-1"):
    try:
        round_recipe_quantity(Decimal(invalid), "g")
    except (ValueError, InvalidOperation):
        pass
    else:
        raise AssertionError(f"Accepted invalid recipe quantity {invalid}")
print("✅ Kitchen display rounds only registered mass/volume; counts, spoons, unknowns and tiny quantities stay exact")
