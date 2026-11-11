-- Source attribution belongs to the recipe and inherits cookbook access.
ALTER TABLE recipes ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE recipes ADD COLUMN source_name TEXT NOT NULL DEFAULT '';
ALTER TABLE recipes ADD COLUMN source_author TEXT NOT NULL DEFAULT '';
ALTER TABLE recipes ADD COLUMN source_yield TEXT NOT NULL DEFAULT '';
