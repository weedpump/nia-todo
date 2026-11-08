import { t } from '../i18n/index.js';
import { escapeHtmlAttr } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';

export const MAX_SERVINGS = 100000;

export function stepServings(value, direction) {
  const current = Number(value);
  if (!Number.isFinite(current) || current <= 0 || current > MAX_SERVINGS) return null;
  return Math.min(MAX_SERVINGS, Math.max(1, current + direction));
}

export function renderServingsControl({ id, labelId = `${id}-label`, value = '', recipeActions = false, required = false } = {}) {
  const action = (direction, name, icon, disabled) => `<button type="button" class="btn btn-secondary btn-icon" data-servings-step="${direction}"${recipeActions ? ` data-recipe-action="${name}"` : ''} aria-label="${escapeHtmlAttr(t(`recipe.servings.${name}`))}" title="${escapeHtmlAttr(t(`recipe.servings.${name}`))}" data-i18n-aria-label-key="recipe.servings.${name}" data-i18n-title-key="recipe.servings.${name}"${disabled ? ' disabled' : ''}>${iconSvg(icon)}</button>`;
  return `<div class="recipe-servings-field"><label id="${escapeHtmlAttr(labelId)}" for="${escapeHtmlAttr(id)}" data-i18n-key="recipe.servings">${escapeHtmlAttr(t('recipe.servings'))}</label><div class="recipe-servings" role="group" aria-labelledby="${escapeHtmlAttr(labelId)}">${action(-1, 'less', 'minus', Number(value) <= 1)}<input class="ui-field" id="${escapeHtmlAttr(id)}" type="number" min="0" max="${MAX_SERVINGS}" step="any" value="${escapeHtmlAttr(value)}" aria-labelledby="${escapeHtmlAttr(labelId)}"${required ? ' required' : ''}>${action(1, 'more', 'plus', Number(value) >= MAX_SERVINGS)}</div></div>`;
}

export function refreshServingsControl(input, { disabled = input.disabled } = {}) {
  const amount = Number(input.value), control = input.closest('.recipe-servings');
  if (!control) return;
  for (const button of control.querySelectorAll('[data-servings-step]')) {
    button.disabled = disabled || !Number.isFinite(amount) || amount <= 0 || amount > MAX_SERVINGS
      || (Number(button.dataset.servingsStep) < 0 ? amount <= 1 : amount >= MAX_SERVINGS);
  }
}
