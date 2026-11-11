#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roundRecipeQuantity, formatQuantity } from '../web/static/js/core/recipe-quantities.js';
import { getQuantityUnitDefinition, normalizeQuantityUnit, formatQuantityUnit } from '../web/static/js/core/quantity-units.js';
import { quantityUnitDefinitions } from '../web/static/js/core/quantity-unit-data.js';
import { ingredientAmount } from '../web/static/js/features/recipe-view.js';
import { stepServings } from '../web/static/js/ui/servings-control.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/recipe_quantity_rounding.json', import.meta.url), 'utf8'));
for (const row of cases) {
  const result = roundRecipeQuantity(Number(row.amount), row.unit);
  assert.deepEqual(result, { value: Number(row.value), unit: row.result_unit }, JSON.stringify(row));
  if (['mass', 'volume'].includes(getQuantityUnitDefinition(result.unit)?.kind) && result.value >= .5) {
    assert.equal(Number.isInteger(result.value * 2), true);
  }
}
assert.equal(ingredientAmount({ quantity_value: 250, quantity_unit: 'ml' }, 2, 6, 'de'), '83 ml');
assert.equal(ingredientAmount({ quantity_value: 1, quantity_unit: 'l' }, 1, 3, 'de'), '333 ml');
assert.equal(ingredientAmount({ quantity_value: 1.5, quantity_unit: 'g' }, 1, 3, 'de'), '0,5 g');
assert.equal(ingredientAmount({ quantity_value: 250, quantity_unit: 'ml' }, 2, 6, 'en'), '83 ml');
assert.equal(ingredientAmount({ quantity_value: 1, quantity_unit: 'Packung' }, 1, 4, 'de'), '1/4 Pack.');
assert.equal(ingredientAmount({ quantity_value: 1, quantity_unit: 'TL' }, 1, 3, 'de'), '1/3 TL');
assert.equal(formatQuantity(1.5, 'pack', 'de'), '1 1/2 Pack.');
assert.equal(formatQuantity(.25, 'pack', 'zh-CN'), '1/4 包');
assert.equal(formatQuantity(.25, 'Hansdampf', 'de', { kitchen: true }), '1/4 Hansdampf');
for (const locale of ['de','en','cs','fr','it','nl','pl','pt-BR','ru','sv','es','zh-CN']) {
  for (const [value, expected] of [[.5,'1/2'], [.75,'3/4'], [2/3,'2/3'], [1.25,'1 1/4']]) {
    assert.equal(formatQuantity(value, null, locale), expected, `${locale}: readable full-size fraction digits`);
  }
}
assert.equal(formatQuantity(.1, 'g', 'de', { kitchen: true }), '0,1 g');
assert.equal(formatQuantity(.25, 'kg', 'de'), '0,25 kg', 'manual Shopping quantities stay exact');
assert.equal(formatQuantity(.25, 'kg', 'de', { kitchen: true }), '250 g');
assert.notEqual(formatQuantity(.000001, 'Hansdampf', 'de'), '0 Hansdampf');
assert.equal(normalizeQuantityUnit('PCS'), 'piece');
assert.equal(normalizeQuantityUnit('Lita'), 'Lita', 'no fuzzy/STT typo correction');
assert.equal(normalizeQuantityUnit('ML'), 'ML', 'SI prefix case is meaningful');
for (const [id, definition] of Object.entries(quantityUnitDefinitions)) {
  if (!definition.labels) continue;
  assert.equal(Object.keys(definition.labels).length, 12, id);
  for (const [locale, label] of Object.entries(definition.labels)) assert.equal(formatQuantityUnit(id, locale), label);
}
assert.equal(ingredientAmount({ quantity_value: 1, quantity_unit: 'g', quantity_text: 'nach Geschmack' }, 2, 6, 'de'), 'nach Geschmack');
assert.equal(ingredientAmount({ quantity_value: null }, 2, 6, 'de'), '');
assert.equal(stepServings(1, -1), 1);
assert.equal(stepServings(100000, 1), 100000);
assert.equal(stepServings(99999.5, 1), 100000);
assert.equal(stepServings(.5, 1), 1.5);
assert.equal(stepServings('', 1), null);
console.log('✅ Shared typed unit policy, safe unknowns, fractions, twelve locale labels and servings boundaries passed');
