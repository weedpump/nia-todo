-- Optional step-local amounts; total ingredient rows remain the purchase source.
ALTER TABLE recipe_step_ingredients ADD COLUMN quantity_value REAL
    CHECK(quantity_value IS NULL OR (quantity_value > 0 AND quantity_value <= 1.7976931348623157e308 AND show_quantity = 1));
ALTER TABLE recipe_step_ingredients ADD COLUMN quantity_text TEXT
    CHECK(quantity_text IS NULL OR (length(trim(quantity_text)) BETWEEN 1 AND 500 AND quantity_value IS NULL AND show_quantity = 1));
