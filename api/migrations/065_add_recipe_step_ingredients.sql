-- Steps optionally refer to ingredients within the same recipe aggregate.
CREATE UNIQUE INDEX idx_recipe_steps_id_recipe ON recipe_steps(id, recipe_id);
CREATE UNIQUE INDEX idx_recipe_ingredients_id_recipe ON recipe_ingredients(id, recipe_id);

CREATE TABLE recipe_step_ingredients (
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    step_id INTEGER NOT NULL,
    ingredient_id INTEGER NOT NULL,
    show_quantity INTEGER NOT NULL DEFAULT 1 CHECK(show_quantity IN (0, 1)),
    sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
    PRIMARY KEY(recipe_id, step_id, ingredient_id),
    FOREIGN KEY(step_id, recipe_id) REFERENCES recipe_steps(id, recipe_id) ON DELETE CASCADE,
    FOREIGN KEY(ingredient_id, recipe_id) REFERENCES recipe_ingredients(id, recipe_id) ON DELETE CASCADE
);
CREATE INDEX idx_recipe_step_ingredients_ingredient ON recipe_step_ingredients(ingredient_id, recipe_id);
