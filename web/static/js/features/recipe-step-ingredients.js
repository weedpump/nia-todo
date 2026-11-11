import { t, getActiveLocale } from '../i18n/index.js';
import { escapeHtmlAttr } from '../core/utils.js';
import { formatRecipeIngredient, formatRecipeStepIngredientAmount } from '../core/recipe-quantities.js';

/** Resolve stable recipe-local references. Never infer links from names/text. */
function ingredientResolver(recipe) {
  const ingredients = new Map((recipe?.ingredient_groups || []).flatMap(group => group.ingredients || []).map(item => [item.client_key, item]));
  return step => {
    const seen = new Set();
    return (step?.ingredients || []).flatMap(link => {
      const key = link?.ingredient_client_key, ingredient = ingredients.get(key);
      if (!ingredient || seen.has(key)) return [];
      seen.add(key);
      const partial = link.show_quantity === false && link.quantity_value == null && !link.quantity_text;
      return [{ ingredient, link, showQuantity: !partial, partial }];
    });
  };
}

export function getRecipeStepIngredients(recipe, step) {
  return ingredientResolver(recipe)(step);
}

function totalLabel(ingredient, servings, baseServings, locale) {
  const quantity = formatRecipeIngredient(ingredient, servings, baseServings, locale);
  return quantity ? `(${t('recipe.step.ingredients.totalInline', { quantity })})` : '';
}

export function renderRecipeStepIngredients(recipe, step, { servings = recipe.base_servings, locale = getActiveLocale() } = {}) {
  const selected = getRecipeStepIngredients(recipe, step);
  if (!selected.length) return '';
  return `<ul class="recipe-step-ingredients" aria-label="${escapeHtmlAttr(t('recipe.step.ingredients.label'))}">${selected.map(({ ingredient, link, showQuantity, partial }) => {
    const quantity = formatRecipeStepIngredientAmount(ingredient, link, servings, recipe.base_servings, locale);
    return `<li class="ui-badge recipe-step-ingredient">${showQuantity ? `<span class="recipe-step-ingredient-amount" data-step-ingredient-amount="${escapeHtmlAttr(ingredient.client_key)}" data-recipe-step-key="${escapeHtmlAttr(step.client_key)}">${escapeHtmlAttr(quantity)}</span>` : ''}<span class="recipe-step-ingredient-name">${escapeHtmlAttr(ingredient.name)}</span>${partial ? `<span class="recipe-step-ingredient-source recipe-step-ingredient-partial" data-step-ingredient-source="${escapeHtmlAttr(ingredient.client_key)}" data-recipe-step-key="${escapeHtmlAttr(step.client_key)}">${escapeHtmlAttr(totalLabel(ingredient, servings, recipe.base_servings, locale))}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}

/** Portion input stays mounted while both list/cooking displays update. */
export function refreshRecipeStepIngredientAmounts(container, recipe, servings, locale = getActiveLocale()) {
  const steps = new Map((recipe?.steps || []).map(step => [step.client_key, step]));
  const resolve = ingredientResolver(recipe), resolved = new Map();
  for (const node of container?.querySelectorAll('[data-step-ingredient-amount]') || []) {
    const step = steps.get(node.dataset.recipeStepKey);
    if (!resolved.has(step)) resolved.set(step, new Map(resolve(step).map(row => [row.ingredient.client_key, row])));
    const row = resolved.get(step).get(node.dataset.stepIngredientAmount);
    node.textContent = row ? formatRecipeStepIngredientAmount(row.ingredient, row.link, servings, recipe.base_servings, locale) : '';
  }
  for (const node of container?.querySelectorAll('[data-step-ingredient-source]') || []) {
    const step = steps.get(node.dataset.recipeStepKey);
    const row = resolve(step).find(row => row.ingredient.client_key === node.dataset.stepIngredientSource);
    node.textContent = row ? totalLabel(row.ingredient, servings, recipe.base_servings, locale) : '';
  }
}
