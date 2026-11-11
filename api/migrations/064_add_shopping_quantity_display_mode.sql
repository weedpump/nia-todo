-- Store raw amounts independently from optional kitchen display rounding.
ALTER TABLE shopping_items ADD COLUMN quantity_display_mode TEXT NOT NULL DEFAULT 'exact'
    CHECK(quantity_display_mode IN ('exact', 'kitchen'));
