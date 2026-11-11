-- Preserve authored choices across BrainDump refinement. Existing links have no
-- reliable provenance and must conservatively remain protected as manual.
ALTER TABLE recipe_step_ingredients ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
    CHECK(origin IN ('manual', 'braindump'));
ALTER TABLE recipe_steps ADD COLUMN excluded_ingredients_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(excluded_ingredients_json)
      AND json_type(excluded_ingredients_json) = 'array'
      AND json_array_length(excluded_ingredients_json) <= 500);
