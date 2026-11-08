#!/usr/bin/env node
import assert from 'node:assert/strict';
import { getRecipeStepIngredients, renderRecipeStepIngredients, refreshRecipeStepIngredientAmounts } from '../web/static/js/features/recipe-step-ingredients.js';
const recipe = { base_servings: 6, ingredient_groups: [{ ingredients: [
  { client_key: 'milk', name: 'Milk <script>', quantity_value: 250, quantity_unit: 'ml' },
  { client_key: 'salt', name: 'Salt', quantity_text: 'to taste' },
  { client_key: 'lemon', name: 'Lemon', quantity_value: 1, quantity_unit: 'piece' },
  { client_key: 'powder', name: 'Baking powder', quantity_value: .25, quantity_unit: 'pack' },
  { client_key: 'same-name', name: 'Milk <script>', quantity_value: 100, quantity_unit: 'g' },
] }], steps: [
  { client_key: 'mix', text: 'Mix.', ingredients: [{ ingredient_client_key: 'milk', show_quantity: true }, { ingredient_client_key: 'salt', show_quantity: true }, { ingredient_client_key: 'lemon', show_quantity: false }, { ingredient_client_key: 'powder', show_quantity: true }] },
  { client_key: 'finish', text: 'Finish.', ingredients: [{ ingredient_client_key: 'lemon', show_quantity: true }] },
] };
const rows = getRecipeStepIngredients(recipe, recipe.steps[0]);
assert.deepEqual(rows.map(row => row.ingredient.client_key), ['milk', 'salt', 'lemon', 'powder']);
assert.equal(rows[0].showQuantity, true);
assert.equal(rows[2].showQuantity, false);
assert.equal(getRecipeStepIngredients(recipe, recipe.steps[1])[0].partial, true, 'multiple uses never repeat the full recipe quantity');
const original = structuredClone(recipe);
const html = renderRecipeStepIngredients(recipe, recipe.steps[0], { servings: 2, locale: 'de' });
assert.match(html, /83 ml/);
assert.match(html, /to taste/);
assert.match(html, /Milk &lt;script&gt;/);
assert.doesNotMatch(html, /<script>/);
assert.match(html, /recipe-step-ingredient-partial/);
assert.deepEqual(recipe, original, 'rendering/portion scaling never changes source data');
assert.equal(renderRecipeStepIngredients(recipe, { client_key: 'legacy', text: 'Old step' }), '');
assert.equal(renderRecipeStepIngredients(recipe, { ingredients: [{ ingredient_client_key: 'not-here' }] }), '');
assert.equal(getRecipeStepIngredients(recipe, { ingredients: [{ ingredient_client_key: 'milk' }, { ingredient_client_key: 'milk' }] }).length, 1);
const reduced = structuredClone(recipe); reduced.steps.splice(1); reduced.steps[0].ingredients[2].show_quantity = true;
assert.equal(getRecipeStepIngredients(reduced, reduced.steps[0])[2].showQuantity, true, 'one remaining full-use link can show quantity');
reduced.ingredient_groups[0].ingredients[0].name = 'Renamed';
assert.equal(getRecipeStepIngredients(reduced, reduced.steps[0])[0].ingredient.name, 'Renamed');
const nodes = ['milk', 'salt', 'lemon', 'powder'].map(key => ({ dataset: { recipeStepKey: 'mix', stepIngredientAmount: key }, textContent: '' }));
refreshRecipeStepIngredientAmounts({ querySelectorAll: () => nodes }, recipe, 2, 'de');
assert.deepEqual(nodes.map(node => node.textContent), ['83 ml', 'to taste', '', '0,0833333 Pack.']);
console.log('✅ Optional step references, partial/multiple quantities, portions, stable keys and escaped shared chips passed');
