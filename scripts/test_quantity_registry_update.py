#!/usr/bin/env python3
"""Offline maintenance regression: refreshing CLDR cannot erase app semantics."""

from copy import deepcopy

from update_quantity_units import LOCALES, VERSION, merge_registry


existing = {
    "source": "old-version", "license": "old-license", "locales": ["en"],
    "units": {"kg": ["kg", "manual kilogram spelling"], "t": ["t"],
              "pack": ["pack", "Packung"], "bag": ["bag", "Beutel"], "tsp": ["tsp", "TL"]},
    "definitions": {
        "kg": {"kind": "mass", "factor": "1000", "base_unit": "g"},
        "t": {"kind": "mass", "factor": "1000000", "base_unit": "g"},
        "pack": {"kind": "count", "labels": {"de": "Pack.", "en": "pack"}},
        "bag": {"kind": "count", "labels": {"de": "Beutel", "en": "bag"}},
        "tsp": {"kind": "spoon", "labels": {"de": "TL", "en": "tsp"}},
    },
    "recipe_rounding": {"metric_whole_from": 10, "fractions": [[1, 3], [1, 2]]},
    "application_metadata": {"reviewed": True},
}
original = deepcopy(existing)
download = {"kg": {"kilogrammes", "kg"}, "t": {"tonne", "ton", "TonS"}}
merged = merge_registry(existing, download)
assert existing == original, "A refresh must not mutate its source"
assert merged["definitions"] == original["definitions"]
assert merged["recipe_rounding"] == original["recipe_rounding"]
assert merged["application_metadata"] == original["application_metadata"]
assert merged["units"]["kg"] == ["kg", "kilogrammes", "manual kilogram spelling"]
for unit in ("pack", "bag", "tsp"):
    assert merged["units"][unit] == sorted(original["units"][unit]), unit
assert merged["units"]["pack"] != merged["units"]["bag"], "Containers keep separate identities"
assert merged["units"]["t"] == ["t", "tonne"], "Ambiguous downloaded tons must stay excluded"
assert "Lita" not in merged["units"]["kg"], "No fuzzy spellings may be invented"
assert merged["source"].endswith(f"/{VERSION}")
assert merged["license"] == "Unicode-3.0"
assert merged["locales"] == list(LOCALES)
assert merge_registry(existing, {"t": ["TonS", "tonne", "ton"], "kg": ["kg", "kilogrammes"]}) == merged
# Returned structures are independent, including application-owned metadata.
merged["definitions"]["pack"]["labels"]["de"] = "changed"
assert existing == original

for invalid in ({}, {**existing, "definitions": {}}, {**existing, "recipe_rounding": {}},
                {**existing, "definitions": {"kg": existing["definitions"]["kg"]}}):
    try:
        merge_registry(invalid, download)
    except ValueError:
        pass
    else:
        raise AssertionError("Missing canonical definitions/policy must fail explicitly")
try:
    merge_registry(existing, {"undefined-new-unit": ["new spelling"]})
except ValueError as error:
    assert "undefined-new-unit" in str(error)
else:
    raise AssertionError("New CLDR units require explicit canonical definitions")
assert existing == original
print("✅ Offline registry refresh preserves aliases, definitions, labels, containers and rounding")
