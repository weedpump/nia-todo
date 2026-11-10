import { normalizeQuantityUnit, getQuantityUnitDefinition, formatQuantityUnit } from './quantity-units.js';
import { recipeQuantityPolicy as policy } from './quantity-unit-data.js';

const metric = definition => ['mass', 'volume'].includes(definition?.kind);
const nearInteger = value => Math.abs(value - Math.round(value)) <= Number.EPSILON * Math.max(1, Math.abs(value));

/** Display precision only. Stored recipe and Shopping amounts remain exact so
 * consecutive transfers add their original amounts instead of rounded values. */
export function roundRecipeQuantity(value, unit = null) {
  let amount = Number(value), resultUnit = normalizeQuantityUnit(unit);
  const definition = getQuantityUnitDefinition(resultUnit);
  if (!Number.isFinite(amount) || amount <= 0 || !metric(definition)) return { value: amount, unit: resultUnit };
  // Fractional kg/l use g/ml; already-small units retain tiny spice amounts.
  if (Number(definition.factor) > 1 && !nearInteger(amount)) {
    const converted = amount * Number(definition.factor);
    if (Number.isFinite(converted)) { amount = converted; resultUnit = definition.base_unit; }
  }
  if (amount >= policy.metric_whole_from) amount = Math.round(amount);
  else if (amount >= policy.metric_half_from) amount = Math.round(amount * 2) / 2;
  return { value: amount, unit: resultUnit };
}

const fractionGlyphs = { '1/4': '¼', '1/3': '⅓', '1/2': '½', '2/3': '⅔', '3/4': '¾' };
function formatAmount(amount, locale, fractions) {
  if (!Number.isFinite(amount)) return '—';
  if (fractions && amount > 0 && amount < policy.fraction_limit) {
    const whole = Math.floor(amount), remainder = amount - whole;
    for (const [numerator, denominator] of policy.fractions) {
      if (Math.abs(remainder - numerator / denominator) <= 1e-9) {
        return `${whole ? new Intl.NumberFormat(locale).format(whole) : ''}${fractionGlyphs[`${numerator}/${denominator}`]}`;
      }
    }
  }
  // Significant digits preserve tiny quantities rather than displaying zero.
  const options = Number.isInteger(amount) ? { maximumFractionDigits: 0 }
    : { maximumSignificantDigits: policy.fallback_significant_digits };
  return new Intl.NumberFormat(locale, options).format(amount);
}

export function formatQuantity(value, unit, locale, { kitchen = false } = {}) {
  const displayed = kitchen ? roundRecipeQuantity(value, unit) : { value: Number(value), unit: normalizeQuantityUnit(unit) };
  const definition = getQuantityUnitDefinition(displayed.unit);
  const fraction = definition == null || ['count', 'spoon'].includes(definition.kind);
  const amount = value == null || value === '' ? '' : formatAmount(displayed.value, locale, fraction);
  return [amount, formatQuantityUnit(displayed.unit, locale)].filter(Boolean).join(' ');
}

export function formatRecipeIngredient(ingredient, servings, baseServings, locale) {
  if (ingredient.quantity_text) return ingredient.quantity_text;
  if (ingredient.quantity_value == null) return '';
  const amount = Number(ingredient.quantity_value) * Number(servings) / Number(baseServings);
  return formatQuantity(amount, ingredient.quantity_unit, locale, { kitchen: true });
}

/** Step overrides use the same scaling and presentation as the source list. */
export function formatRecipeStepIngredientAmount(ingredient, link, servings, baseServings, locale) {
  if (link?.quantity_text) return link.quantity_text;
  if (link?.quantity_value != null) return formatRecipeIngredient({ ...ingredient, quantity_value: link.quantity_value, quantity_text: null }, servings, baseServings, locale);
  if (link?.show_quantity === false) return '';
  return formatRecipeIngredient(ingredient, servings, baseServings, locale);
}
