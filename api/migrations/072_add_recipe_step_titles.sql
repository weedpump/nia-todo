-- Titles are optional metadata, not an implicit first line of the body.
-- Rebuild both parent and referencing table so title-only steps are possible
-- without disabling foreign keys or losing ingredient associations.
CREATE TEMP TABLE recipe_step_links_v72 AS SELECT * FROM recipe_step_ingredients;
CREATE TEMP TABLE recipe_step_sequence_v72 AS
    SELECT seq FROM sqlite_sequence WHERE name = 'recipe_steps';

CREATE TABLE recipe_steps_v72 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 1 AND 200),
    title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 200),
    text TEXT NOT NULL DEFAULT '' CHECK(length(text) <= 8000),
    sort_order INTEGER NOT NULL,
    CHECK(length(trim(title, char(9) || char(10) || char(13) || ' ')) > 0
       OR length(trim(text, char(9) || char(10) || char(13) || ' ')) > 0),
    UNIQUE(recipe_id, client_key)
);

WITH parsed AS (
    SELECT *, instr(text, char(10)) AS line_break,
           rtrim(substr(text, 1, instr(text, char(10)) - 1), char(13)) AS first_line,
           substr(text, instr(text, char(10)) + 1) AS remaining_text
    FROM recipe_steps
), classified AS (
    SELECT *, line_break > 0 AND length(first_line) <= 200
       AND length(trim(first_line, char(9) || char(13) || ' ')) > 0
       AND length(trim(remaining_text, char(9) || char(10) || char(13) || ' ')) > 0 AS split_title
    FROM parsed
)
INSERT INTO recipe_steps_v72 (id, recipe_id, client_key, title, text, sort_order)
SELECT id, recipe_id, client_key,
       CASE WHEN split_title THEN first_line ELSE '' END,
       CASE WHEN split_title THEN remaining_text ELSE text END, sort_order
FROM classified;

DROP TABLE recipe_step_ingredients;
DROP TABLE recipe_steps;
ALTER TABLE recipe_steps_v72 RENAME TO recipe_steps;
CREATE UNIQUE INDEX idx_recipe_steps_id_recipe ON recipe_steps(id, recipe_id);
UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM recipe_step_sequence_v72), 0))
    WHERE name = 'recipe_steps';
INSERT INTO sqlite_sequence (name, seq)
    SELECT 'recipe_steps', seq FROM recipe_step_sequence_v72
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'recipe_steps');

CREATE TABLE recipe_step_ingredients (
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    step_id INTEGER NOT NULL,
    ingredient_id INTEGER NOT NULL,
    show_quantity INTEGER NOT NULL DEFAULT 1 CHECK(show_quantity IN (0, 1)),
    sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
    quantity_value REAL CHECK(quantity_value IS NULL OR (quantity_value > 0 AND quantity_value <= 1.7976931348623157e308 AND show_quantity = 1)),
    quantity_text TEXT CHECK(quantity_text IS NULL OR (length(trim(quantity_text)) BETWEEN 1 AND 500 AND quantity_value IS NULL AND show_quantity = 1)),
    PRIMARY KEY(recipe_id, step_id, ingredient_id),
    FOREIGN KEY(step_id, recipe_id) REFERENCES recipe_steps(id, recipe_id) ON DELETE CASCADE,
    FOREIGN KEY(ingredient_id, recipe_id) REFERENCES recipe_ingredients(id, recipe_id) ON DELETE CASCADE
);
CREATE INDEX idx_recipe_step_ingredients_ingredient ON recipe_step_ingredients(ingredient_id, recipe_id);
INSERT INTO recipe_step_ingredients
    (recipe_id, step_id, ingredient_id, show_quantity, sort_order, quantity_value, quantity_text)
SELECT recipe_id, step_id, ingredient_id, show_quantity, sort_order, quantity_value, quantity_text
FROM recipe_step_links_v72;
DROP TABLE recipe_step_links_v72;
DROP TABLE recipe_step_sequence_v72;
