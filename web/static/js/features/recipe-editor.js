import { normalizeQuantityUnit, formatQuantityUnit } from '../core/quantity-units.js';
import { formatQuantity, formatRecipeStepIngredientAmount } from '../core/recipe-quantities.js';
import { t, translatePage, getActiveLocale } from '../i18n/index.js';
import { escapeHtml, escapeHtmlAttr } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { renderDetailModalFrame } from '../ui/detail-modal.js';
import { hydrateSelect, refreshSelect, closeOpenDropdown } from '../ui/dropdowns.js';
import { renderImagePicker, createImagePickerController } from '../ui/image-picker.js';
import { renderEntityDetailHeader } from './entity-detail-header.js';
import { createEntityEditorModalController } from './entity-editor-modal.js';
import { closeUiLayerNow } from './ui-history.js';
import { sameEntityId } from './entity-metadata.js';
import { validateRecipeChanges } from './recipe-pending.js';
import { canEditRecipe, renderRecipeConflict, resolveRecipeConflict } from './recipe-view.js';

const text = key => `<span data-i18n-key="${escapeHtmlAttr(key)}">${escapeHtmlAttr(t(key))}</span>`;
const field = (id, key, type = 'text', attrs = '') => `<div class="form-group"><label for="recipe-${id}">${text(key)}</label><input id="recipe-${id}" class="ui-field" type="${type}" ${attrs}></div>`;
const addButton = (action, key) => `<button type="button" class="btn btn-secondary" data-recipe-editor-action="${action}">${iconSvg('plus')}${text(key)}</button>`;
const sectionHeading = (key, icon, action, actionKey) => `<div class="ui-section-heading ui-detail-section-heading is-title-only recipe-editor-section-heading"><div class="ui-section-icon ui-detail-section-icon">${iconSvg(icon)}</div><div><h4>${text(key)}</h4></div>${action ? addButton(action, actionKey) : ''}</div>`;
export function renderRecipeEditorModal() {
  return renderDetailModalFrame({ id: 'recipe-modal', contentClasses: ['modal-content', 'entity-modal-content', 'ui-detail-modal-content', 'recipe-editor-content'],
    rootAttributes: { role: 'dialog', 'aria-modal': 'true', 'aria-hidden': 'true', 'aria-labelledby': 'recipe-modal-title' },
    headerHtml: renderEntityDetailHeader({ icon: 'book-open', title: { id: 'recipe-modal-title', key: 'recipe.new' }, subtitle: { key: 'recipe.editor.subtitle' },
      actionsHtml: `<button type="submit" form="recipe-form" id="recipe-save-btn" class="btn btn-primary" data-i18n-key="common.save">${text('common.save')}</button>
      <details class="ui-detail-header-menu-toggle" id="recipe-detail-header-menu" data-ui-editor-menu hidden><summary id="recipe-detail-header-menu-trigger" aria-label="${escapeHtmlAttr(t('common.more'))}" data-i18n-aria-label-key="common.more">${iconSvg('menu')}</summary><div class="ui-detail-header-menu ui-menu" role="menu"><button type="button" id="recipe-delete-btn" class="ui-menu-item danger" role="menuitem">${iconSvg('trash-2')}${text('common.delete')}</button></div></details>
      <button type="button" class="modal-close-x" data-close-modal="recipe-modal" aria-label="${escapeHtmlAttr(t('common.close'))}" data-i18n-aria-label-key="common.close">${iconSvg('x')}</button>` }),
    bodyHtml: `<form id="recipe-form" class="entity-modal-form ui-detail-shell">
      <input type="hidden" id="recipe-id"><input type="hidden" id="recipe-cookbook-id">
      <div id="recipe-editor-conflict"></div>
      <div class="recipe-ai-tools"><button type="button" id="recipe-ai-refine-btn" class="btn btn-secondary" data-recipe-editor-action="brain-dump" hidden>${iconSvg('sparkles')}${text('recipe.ai.refine')}</button><p id="recipe-ai-status" class="recipe-step-hint" role="status" aria-live="polite" hidden></p></div>
      <div id="recipe-import-review" class="recipe-import-review" role="status" hidden></div>
      <section class="ui-detail-section ui-section-divider ui-detail-title-section recipe-editor-intro">
        <div class="recipe-editor-title-row"><div class="form-group ui-detail-title-group"><label for="recipe-name">${text('recipe.title')}</label><input id="recipe-name" class="ui-field ui-detail-title-field" required maxlength="200" autocomplete="off"></div>
          ${renderImagePicker({ prefix: 'recipe-image', labelKey: 'recipe.image.title', chooseKey: 'recipe.image.choose', removeKey: 'recipe.image.remove', accept: 'image/jpeg,image/png,image/webp' })}
        </div>
        <div class="recipe-editor-main">
          <div class="form-group"><label for="recipe-description">${text('entity.description')}</label><textarea id="recipe-description" class="ui-field" rows="3" maxlength="4000"></textarea></div>
          <div class="recipe-editor-meta">${field('base-servings', 'recipe.baseServings', 'number', 'required min="0" max="100000" step="any"')}${field('prep-minutes', 'recipe.prepLabel', 'number', 'min="0" max="100000" step="1"')}${field('cook-minutes', 'recipe.cookLabel', 'number', 'min="0" max="100000" step="1"')}</div>
        </div>
      </section>
      <details class="recipe-editor-source"><summary>${text('recipe.source.title')}</summary><div class="recipe-editor-source-fields">
        ${field('source-url', 'recipe.source.url', 'url', 'maxlength="2048" inputmode="url"')}
        ${field('source-name', 'recipe.source.name', 'text', 'maxlength="200"')}
        ${field('source-author', 'recipe.source.author', 'text', 'maxlength="500"')}
        ${field('source-yield', 'recipe.source.yield', 'text', 'maxlength="500"')}
      </div></details>
      <section class="ui-detail-section ui-section-divider">${sectionHeading('recipe.tags', 'tag', 'tag-add', 'recipe.tag.add')}<div id="recipe-editor-tags" class="recipe-editor-tags"></div></section>
      <section class="ui-detail-section ui-section-divider">${sectionHeading('recipe.ingredients', 'list-todo', 'group-add', 'recipe.group.add')}<div id="recipe-editor-groups"></div></section>
      <section class="ui-detail-section ui-section-divider">${sectionHeading('recipe.steps', 'chef-hat')}<p id="recipe-step-hint" class="recipe-step-hint">${text('recipe.steps.hint')}</p><div id="recipe-editor-steps"></div>${addButton('step-add', 'recipe.step.add')}</section>
      <p id="recipe-error" class="form-error" role="alert"></p></form>` });
}
let nextKey = 0;
const newKey = () => globalThis.crypto?.randomUUID?.() || `recipe-row-${Date.now()}-${++nextKey}`;
const identity = value => ({ ...(value.id != null ? { id: value.id } : {}), client_key: value.client_key || newKey() });
const cloneContent = recipe => ({
  tags: [...(recipe?.tags || [])],
  ingredient_groups: (recipe?.ingredient_groups || []).map(group => ({ ...identity(group), name: group.name || '', ingredients: (group.ingredients || []).map(item => ({ ...identity(item), name: item.name || '', quantity_value: item.quantity_value ?? null, quantity_unit: item.quantity_unit || '', quantity_text: item.quantity_text || '', note: item.note || '' })) })),
  steps: (recipe?.steps || []).map(step => ({ ...identity(step), title: step.title || '', text: step.text || '',
    ingredients: (step.ingredients || []).map(link => ({ ingredient_client_key: link.ingredient_client_key, show_quantity: link.show_quantity !== false,
      ...(Object.hasOwn(link, 'quantity_value') || Object.hasOwn(link, 'quantity_text') ? { quantity_value: link.quantity_value ?? null, quantity_text: link.quantity_text ?? null } : {}) })) })),
});
function orderButtons(kind, key, index, length, groupKey = '') {
  const attributes = `data-key="${escapeHtmlAttr(key)}"${groupKey ? ` data-group-key="${escapeHtmlAttr(groupKey)}"` : ''}`;
  return `<div class="recipe-row-actions">${[['up', 'chevron-up', index === 0, 'recipe.moveUp'], ['down', 'chevron-down', index === length - 1, 'recipe.moveDown'], ['remove', 'trash-2', false, 'common.delete']].map(([action, icon, disabled, label]) => `<button type="button" class="btn btn-secondary btn-icon" data-recipe-editor-action="${kind}-${action}" ${attributes} ${disabled ? 'disabled data-bound-disabled="true"' : ''} aria-label="${escapeHtmlAttr(t(label))}" title="${escapeHtmlAttr(t(label))}" data-i18n-aria-label-key="${label}" data-i18n-title-key="${label}">${iconSvg(icon)}</button>`).join('')}</div>`;
}
export function createRecipeEditorFeature({ getCookbooks = () => [], recipeController,
  getSessionIdentity = () => 'embedded', root = globalThis.document, confirmDanger = async () => false,
  prepareRecipeImage = async () => { throw Object.assign(new Error('Image preparation unavailable'), { code: 'recipe.image.invalid' }); },
  loadRecipeImage = async () => false, releaseRecipeImage = () => {},
  api = null, getBrainDumpAccess = () => false, isOnline = () => globalThis.navigator?.onLine !== false,
  onSaved = () => {}, onDeleted = () => {}, onError = console.error,
} = {}) {
  let model = cloneContent(null), baseline = null, openedRecipe = null, openedBook = null, baselineRevision = null;
  let session, generation = 0, imageGeneration = 0, imageData, preparing = false, busy = null, bound = false, errorKey = '';
  let importWarnings = null, reviewHintKey = 'recipe.import.reviewHint';
  const el = suffix => root.getElementById(`recipe-${suffix}`);
  const books = () => getCookbooks();
  const book = () => books().find(candidate => sameEntityId(candidate.id, el('cookbook-id')?.value)
    || (openedBook && sameEntityId(candidate.created_by_user_id, openedBook.created_by_user_id) && candidate.client_mutation_id != null && sameEntityId(candidate.client_mutation_id, openedBook.client_mutation_id)));
  const current = () => el('id')?.value ? recipeController.getRecipe(el('id').value) : null;
  const active = () => el('modal')?.classList.contains('active');
  const validSession = () => session === getSessionIdentity();
  const editable = () => validSession() && canEditRecipe(el('id')?.value ? current() : null, book());
  const error = key => { errorKey = key; if (el('error')) el('error').textContent = key ? t(key) : ''; };
  const optionalNumber = input => input.value === '' ? null : Number(input.value);
  const value = (row, name) => row.querySelector(`[data-field="${name}"]`)?.value || '';
  function readState() {
    const groups = Array.from(el('editor-groups')?.querySelectorAll('.recipe-editor-group') || []).map(node => {
      const old = model.ingredient_groups.find(group => group.client_key === node.dataset.key) || { client_key: node.dataset.key, ingredients: [] };
      return { ...identity(old), name: value(node, 'group-name').trim(), ingredients: Array.from(node.querySelectorAll('.recipe-editor-ingredient')).map(row => {
        const existing = old.ingredients.find(item => item.client_key === row.dataset.key) || { client_key: row.dataset.key };
        return { ...identity(existing), name: value(row, 'name').trim(), quantity_value: optionalNumber(row.querySelector('[data-field="quantity_value"]')),
          quantity_unit: normalizeQuantityUnit(value(row, 'quantity_unit')) || '', quantity_text: value(row, 'quantity_text').trim(), note: value(row, 'note').trim() };
      }) };
    });
    const ingredientKeys = new Set(groups.flatMap(group => group.ingredients.map(item => item.client_key)));
    const steps = Array.from(el('editor-steps')?.querySelectorAll('.recipe-editor-step') || []).map(node => {
      const step = model.steps.find(step => step.client_key === node.dataset.key) || { client_key: node.dataset.key };
      return { ...identity(step), title: value(node, 'step-title').trim(), text: node.querySelector('textarea').value.trim(),
        ingredients: (step.ingredients || []).filter(link => ingredientKeys.has(link.ingredient_client_key)).map(link => ({ ...link })) };
    });
    return { title: el('name')?.value.trim() || '', description: el('description')?.value.trim() || '',
      base_servings: el('base-servings') ? Number(el('base-servings').value) : 2,
      prep_minutes: el('prep-minutes') ? optionalNumber(el('prep-minutes')) : null, cook_minutes: el('cook-minutes') ? optionalNumber(el('cook-minutes')) : null,
      tags: Array.from(el('editor-tags')?.querySelectorAll('input') || []).map(input => input.value.trim()), ingredient_groups: groups, steps,
      ...Object.fromEntries(['url', 'name', 'author', 'yield'].map(key => [`source_${key}`, el(`source-${key}`)?.value.trim() || ''])),
      ...(imageData !== undefined ? { image_data: imageData } : {}),
    };
  }
  const valid = data => Boolean(validateRecipeChanges(data, true));
  const comparable = data => ({ ...data,
    ingredient_groups: data.ingredient_groups.map(({ id, ingredients, ...group }) => ({ ...group, ingredients: ingredients.map(({ id, ...item }) => item) })),
    steps: data.steps.map(({ id, ...step }) => ({ ...step, ingredients: (step.ingredients || []).map(link => ({ ...link, quantity_value: link.quantity_value ?? null, quantity_text: link.quantity_text || null })) })),
  });
  let ingredientEdit = null;
  let modal;
  const originalImage = () => Object.hasOwn(openedRecipe || {}, 'image_data') ? openedRecipe.image_data : openedRecipe?.image_url;
  const hasImage = () => imageData === undefined ? Boolean(originalImage()) : Boolean(imageData);
  const imagePicker = createImagePickerController({ prefix: 'recipe-image', root,
    canEdit: () => active() && editable() && !current()?.conflict && !busy,
    getHasImage: hasImage, onRemove: removeImage });
  function permissions() {
    const disabled = !editable() || Boolean(current()?.conflict) || busy?.kind === 'ai';
    for (const field of el('form')?.querySelectorAll('input:not([type="hidden"]),textarea,select,button[data-recipe-editor-action]') || []) field.disabled = disabled;
    if (!disabled) {
      for (const node of el('form').querySelectorAll('[data-bound-disabled="true"]')) node.disabled = true;
    }
    for (const control of el('editor-conflict')?.querySelectorAll('button') || []) control.disabled = !editable() || Boolean(busy);
    for (const row of el('editor-groups')?.querySelectorAll('.recipe-editor-ingredient') || []) {
      const opened = row.dataset.key === ingredientEdit?.key;
      const mode = row.querySelector('[data-field="quantity_mode"]');
      for (const input of row.querySelectorAll('input,select')) {
        const inactiveMode = mode.value === 'text' ? ['quantity_value', 'quantity_unit'].includes(input.dataset.field) : input.dataset.field === 'quantity_text';
        input.disabled = disabled || !opened || inactiveMode;
        if (input.matches('input')) input.closest('label').hidden = inactiveMode;
      }
      hydrateSelect(mode); refreshSelect(mode);
    }
    imagePicker.refresh();
    refreshStepIngredientPermissions();
    modal?.syncDeleteMenu(Boolean(el('id')?.value && editable() && !current()?.conflict));
    if (el('delete-btn') && busy?.kind === 'ai') el('delete-btn').disabled = true;
    refreshAI();
    modal?.refreshSaveState();
  }
  const appearance = { setValues: ({ name = '' }, { editable: canEdit = true } = {}) => { el('name').value = name; el('name').disabled = !canEdit; }, focusName: () => el('name')?.focus() };
  modal = createEntityEditorModalController({ prefix: 'recipe', document: root, appearanceController: appearance,
    readState: () => comparable(readState()), isValid: valid, canSubmit: () => editable() && !busy && !preparing && !current()?.conflict,
    resolveView: ({ entity }) => ({ mode: entity ? 'edit' : 'create', titleKey: entity ? 'recipe.edit' : 'recipe.new', appearance: { name: entity?.title || '' },
      appearanceEditable: canEditRecipe(entity, book()), ownershipCanManage: false, canDelete: Boolean(entity && canEditRecipe(entity, book()) && !entity.conflict), readOnly: !canEditRecipe(entity, book()),
      restoreFocus: () => root.querySelector('[data-recipe-action="edit"]') || root.querySelector('[data-recipe-action="create"]'),
    }),
    renderDomain: ({ entity }) => renderContent(entity),
    applyDomainPermissions: permissions, clearError: () => error(''), onSubmit: save, onDelete: remove, onError,
  });
  function renderImportReview() {
    const host = el('import-review');
    if (!host) return;
    host.hidden = importWarnings === null;
    host.innerHTML = importWarnings === null ? '' : `<p>${text(reviewHintKey)}</p>${importWarnings.length ? `<ul>${importWarnings.map(key => `<li>${escapeHtml(t(key))}</li>`).join('')}</ul>` : ''}`;
  }
  function renderContent(entity) {
      imagePicker.close();
      ingredientEdit = null;
      for (const picker of el('editor-steps')?.querySelectorAll('.recipe-editor-step-ingredients[open]') || []) picker.open = false;
      model = cloneContent(entity); imageData = undefined; imageGeneration++; preparing = false;
      el('cookbook-id').value = entity?.cookbook_id ?? openedBook?.id ?? '';
      el('description').value = entity?.description || ''; el('base-servings').value = entity?.base_servings ?? 2;
      el('prep-minutes').value = entity?.prep_minutes ?? ''; el('cook-minutes').value = entity?.cook_minutes ?? '';
      for (const key of ['url', 'name', 'author', 'yield']) if (el(`source-${key}`)) el(`source-${key}`).value = entity?.[`source_${key}`] || '';
      el('form').querySelector('.recipe-editor-source')?.removeAttribute('open');
      importWarnings = null; reviewHintKey = 'recipe.import.reviewHint'; renderImportReview();
      el('image-file').value = ''; renderRows(); el('editor-conflict').innerHTML = renderRecipeConflict(entity);
      renderImage();
  }
  function ingredientSummary(item) {
    return `<span class="recipe-editor-ingredient-name"><span class="recipe-editor-ingredient-amount">${escapeHtml(item.quantity_text || formatQuantity(item.quantity_value, item.quantity_unit, getActiveLocale()))}</span><strong>${escapeHtml(item.name || t('recipe.ingredient.name'))}</strong></span>${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}`;
  }
  function activeIngredientValid() {
    validateQuantities();
    const row = Array.from(el('editor-groups').querySelectorAll('.recipe-editor-ingredient')).find(node => node.dataset.key === ingredientEdit?.key);
    for (const input of row?.querySelectorAll('input,select') || []) if (!input.reportValidity()) return false;
    return true;
  }
  const stepPickerSignatures = new WeakMap();
  function refreshStepIngredientPermissions() {
    const disabled = !active() || !editable() || Boolean(current()?.conflict) || Boolean(busy);
    for (const choice of el('editor-steps')?.querySelectorAll('[data-step-choice]') || []) {
      const selected = choice.querySelector('[data-step-ingredient]').checked;
      for (const control of choice.querySelectorAll('input,button')) control.disabled = disabled || (control.hasAttribute('data-step-quantity-value') && control.dataset.noNumeric === 'true') || (!control.hasAttribute('data-step-ingredient') && !selected);
      choice.querySelector('[data-recipe-editor-action="step-quantity-toggle"]').setAttribute('aria-disabled', String(disabled || !selected));
    }
    for (const summary of el('editor-steps')?.querySelectorAll('[data-recipe-editor-action="step-ingredients-toggle"]') || []) summary.setAttribute('aria-disabled', String(disabled));
  }
  function refreshStepPickers(data = readState()) {
    const ingredients = new Map(data.ingredient_groups.flatMap(group => group.ingredients.map(item => [item.client_key, item])));
    const signature = JSON.stringify([getActiveLocale(), data.ingredient_groups]);
    for (const node of el('editor-steps')?.querySelectorAll('.recipe-editor-step') || []) {
      const step = model.steps.find(value => value.client_key === node.dataset.key);
      if (!step) continue;
      step.ingredients = (step.ingredients || []).filter(link => ingredients.has(link.ingredient_client_key));
      const selected = new Map(step.ingredients.map(link => [link.ingredient_client_key, link]));
      const container = node.querySelector('[data-step-picker-content]');
      const focus = container.contains(root.activeElement) ? { key: root.activeElement.closest('[data-step-choice]')?.dataset.stepChoice,
        number: root.activeElement.hasAttribute('data-step-quantity-value'), free: root.activeElement.hasAttribute('data-step-quantity-text'),
        value: root.activeElement.value, start: root.activeElement.selectionStart, end: root.activeElement.selectionEnd } : null;
      if (node.querySelector('.recipe-editor-step-ingredients').open && stepPickerSignatures.get(container) !== signature) {
        const opened = new Set(Array.from(container.querySelectorAll('[data-step-choice] details[open]')).map(details => details.closest('[data-step-choice]').dataset.stepChoice));
        const openGroups = new Set(Array.from(container.querySelectorAll('[data-step-group][open]')).map(details => details.dataset.stepGroup));
        container.innerHTML = data.ingredient_groups.map(group => group.ingredients.length ? `<details class="recipe-editor-step-ingredient-group" data-step-group="${escapeHtmlAttr(group.client_key)}" ${openGroups.has(group.client_key) ? 'open' : ''}><summary class="recipe-editor-step-group-name">${escapeHtml(group.name || t('recipe.ingredients'))}<span data-step-group-count></span></summary>${group.ingredients.map(item => `<div class="recipe-editor-step-ingredient-choice" data-step-choice="${escapeHtmlAttr(item.client_key)}"><label class="recipe-editor-step-ingredient-label"><span class="ui-checkbox-label ui-checkbox-round"><input type="checkbox" data-step-ingredient="${escapeHtmlAttr(item.client_key)}"><span class="ui-checkbox-box" aria-hidden="true">${iconSvg('check')}</span></span><span>${escapeHtml(item.name || t('recipe.ingredient.name'))}<small class="recipe-editor-step-source">${escapeHtml(t('recipe.step.ingredients.sourceTotal', { quantity: item.quantity_text || formatQuantity(item.quantity_value, item.quantity_unit, getActiveLocale()) }))}</small></span></label><details class="recipe-editor-step-quantity" ${opened.has(item.client_key) ? 'open' : ''} hidden><summary data-recipe-editor-action="step-quantity-toggle"><span data-step-quantity-preview></span></summary><div class="recipe-editor-step-quantity-fields"><label>${text('recipe.step.ingredients.quantity')}<span class="recipe-editor-step-number"><input class="ui-field" type="number" min="0" step="any" data-step-quantity-value data-no-numeric="${!(Number.isFinite(item.quantity_value) && item.quantity_value > 0)}"><span>${escapeHtml(formatQuantityUnit(item.quantity_unit, getActiveLocale()))}</span></span></label><label>${text('common.quantityText')}<input class="ui-field" maxlength="500" data-step-quantity-text></label><button type="button" class="btn btn-secondary" data-recipe-editor-action="step-quantity-reset">${text('recipe.step.ingredients.full')}</button></div></details><small class="form-error recipe-editor-step-quantity-error" data-step-quantity-error hidden>${text('recipe.step.ingredients.invalidQuantity')}</small></div>`).join('')}</details>` : '').join('') || `<p class="recipe-step-hint">${text('recipe.step.ingredients.empty')}</p>`;
        stepPickerSignatures.set(container, signature);
      }
      for (const choice of container.querySelectorAll('[data-step-choice]')) {
        const key = choice.dataset.stepChoice, link = selected.get(key), ingredient = ingredients.get(key);
        choice.querySelector('[data-step-ingredient]').checked = Boolean(link);
        choice.querySelector('.recipe-editor-step-quantity').hidden = !link;
        const number = choice.querySelector('[data-step-quantity-value]'), free = choice.querySelector('[data-step-quantity-text]');
        if (root.activeElement !== number) number.value = link?.quantity_value ?? '';
        if (root.activeElement !== free) free.value = link?.quantity_text ?? '';
        if (Number.isFinite(ingredient.quantity_value)) number.max = String(ingredient.quantity_value); else number.removeAttribute('max');
        const invalid = link?.quantity_value != null && (!(Number.isFinite(link.quantity_value) && link.quantity_value > 0) || !Number.isFinite(ingredient.quantity_value) || link.quantity_value > ingredient.quantity_value);
        number.setCustomValidity(invalid ? t('recipe.step.ingredients.invalidQuantity') : '');
        choice.querySelector('[data-step-quantity-error]').hidden = !invalid;
        choice.querySelector('[data-step-quantity-preview]').textContent = link?.show_quantity === false ? t('recipe.step.ingredients.unspecified')
          : link && (link.quantity_value != null || link.quantity_text) ? formatRecipeStepIngredientAmount(ingredient, link, data.base_servings, data.base_servings, getActiveLocale()) : t('recipe.step.ingredients.quantity');
      }
      if (focus?.key && (focus.number || focus.free)) {
        const choice = Array.from(container.querySelectorAll('[data-step-choice]')).find(row => row.dataset.stepChoice === focus.key);
        const input = choice?.querySelector(focus.number ? '[data-step-quantity-value]' : '[data-step-quantity-text]');
        if (input && input !== root.activeElement) { input.value = focus.value; input.focus({ preventScroll: true }); if (focus.free) input.setSelectionRange(focus.start, focus.end); }
      }
      for (const group of container.querySelectorAll('[data-step-group]')) {
        const count = group.querySelectorAll('[data-step-ingredient]:checked').length;
        group.querySelector('[data-step-group-count]').textContent = count ? ` (${count})` : '';
      }
      node.querySelector('[data-step-selected-count]').textContent = step.ingredients.length ? ` (${step.ingredients.length})` : '';
    }
    refreshStepIngredientPermissions();
  }
  function updateStepQuantity(input) {
    if (!input.matches('[data-step-quantity-value],[data-step-quantity-text]') || !active() || !editable() || current()?.conflict || busy) return false;
    const choice = input.closest('[data-step-choice]'), step = model.steps.find(step => step.client_key === input.closest('.recipe-editor-step').dataset.key);
    const link = step?.ingredients?.find(link => link.ingredient_client_key === choice.dataset.stepChoice);
    if (!link) return false;
    link.show_quantity = true;
    link.quantity_value = input.hasAttribute('data-step-quantity-value') && input.value !== '' ? Number(input.value) : null;
    link.quantity_text = input.hasAttribute('data-step-quantity-text') ? input.value.trim() || null : null;
    choice.querySelector(input.hasAttribute('data-step-quantity-value') ? '[data-step-quantity-text]' : '[data-step-quantity-value]').value = '';
    refreshStepPickers(); modal.refreshSaveState(); return true;
  }
  function pruneStepIngredients() {
    const keys = new Set(model.ingredient_groups.flatMap(group => group.ingredients.map(item => item.client_key)));
    for (const step of model.steps) step.ingredients = (step.ingredients || []).filter(link => keys.has(link.ingredient_client_key));
  }
  function renderRows(focusKey = null, focusAction = null) {
    const openPickers = new Set(Array.from(el('editor-steps')?.querySelectorAll('.recipe-editor-step-ingredients[open]') || []).map(node => node.closest('.recipe-editor-step').dataset.key));
    const openGroups = new Set(Array.from(el('editor-steps')?.querySelectorAll('[data-step-group][open]') || []).map(node => JSON.stringify([node.closest('.recipe-editor-step').dataset.key, node.dataset.stepGroup])));
    pruneStepIngredients();
    const total = model.ingredient_groups.flatMap(group => group.ingredients).length;
    closeOpenDropdown('recipe-render');
    if (ingredientEdit && !model.ingredient_groups.some(group => group.ingredients.some(item => item.client_key === ingredientEdit.key))) ingredientEdit = null;
    el('editor-groups').innerHTML = model.ingredient_groups.map((group, index) => `<section class="recipe-editor-group" data-key="${escapeHtmlAttr(group.client_key)}"><div class="recipe-editor-row-heading"><input class="ui-field ui-detail-title-field ui-detail-section-title-field" data-field="group-name" maxlength="200" value="${escapeHtmlAttr(group.name)}" aria-label="${escapeHtmlAttr(t('recipe.group.name'))}" data-i18n-aria-label-key="recipe.group.name" placeholder="${escapeHtmlAttr(t('recipe.group.name'))}" data-i18n-placeholder-key="recipe.group.name">${orderButtons('group', group.client_key, index, model.ingredient_groups.length)}</div>
      <div class="recipe-editor-ingredients">${group.ingredients.map((item, itemIndex) => {
        const opened = ingredientEdit?.key === item.client_key;
        const mode = opened ? ingredientEdit.mode : item.quantity_text ? 'text' : 'number';
        const input = ([name, label, type, content, attributes]) => `<label class="recipe-ingredient-field-${name}">${text(label)}<input class="ui-field" data-field="${name}" type="${type}" value="${escapeHtmlAttr(content)}" ${attributes}></label>`;
        const attrs = `data-key="${escapeHtmlAttr(item.client_key)}" data-group-key="${escapeHtmlAttr(group.client_key)}"`;
        const editorId = `recipe-ingredient-editor-${item.client_key}`;
        return `<div class="recipe-editor-ingredient${opened ? ' is-editing' : ''}" data-key="${escapeHtmlAttr(item.client_key)}">
          <button type="button" class="ui-nav-pill recipe-editor-ingredient-summary" data-recipe-editor-action="ingredient-edit" ${attrs} aria-expanded="${opened}" aria-controls="${escapeHtmlAttr(editorId)}"><span class="recipe-editor-ingredient-copy">${ingredientSummary(item)}</span></button>
          <div id="${escapeHtmlAttr(editorId)}" class="recipe-editor-ingredient-editor" ${opened ? '' : 'hidden'}>
            <div class="form-group"><label for="recipe-quantity-mode-${escapeHtmlAttr(item.client_key)}">${text('recipe.quantityMode')}</label><select id="recipe-quantity-mode-${escapeHtmlAttr(item.client_key)}" data-field="quantity_mode" class="ui-field"><option value="number" ${mode === 'number' ? 'selected' : ''} data-i18n-key="recipe.quantityMode.number">${escapeHtml(t('recipe.quantityMode.number'))}</option><option value="text" ${mode === 'text' ? 'selected' : ''} data-i18n-key="recipe.quantityMode.text">${escapeHtml(t('recipe.quantityMode.text'))}</option></select></div>
            <div class="recipe-editor-ingredient-fields">
              ${[['name', 'recipe.ingredient.name', 'text', item.name, 'required maxlength="500"'], ['quantity_value', 'common.quantity', 'number', item.quantity_value ?? '', 'min="0" step="any"'], ['quantity_unit', 'common.unit', 'text', formatQuantityUnit(item.quantity_unit, getActiveLocale()), 'maxlength="40"'], ['quantity_text', 'common.quantityText', 'text', item.quantity_text, 'maxlength="500"'], ['note', 'common.note', 'text', item.note, 'maxlength="2000"']].map(input).join('')}
            </div><span class="form-error recipe-quantity-error" hidden>${text('recipe.validation.quantity')}</span>
            <div class="recipe-editor-ingredient-actions"><div class="recipe-editor-ingredient-confirm"><button type="button" class="btn btn-secondary" data-recipe-editor-action="ingredient-cancel" ${attrs}>${text('common.cancel')}</button><button type="button" class="btn btn-secondary" data-recipe-editor-action="ingredient-done" ${attrs}>${iconSvg('check')}${text('common.apply')}</button></div>${orderButtons('ingredient', item.client_key, itemIndex, group.ingredients.length, group.client_key)}</div>
          </div></div>`;
      }).join('')}</div>
      <button type="button" class="btn btn-secondary" data-recipe-editor-action="ingredient-add" data-group-key="${escapeHtmlAttr(group.client_key)}" ${total >= 500 ? 'disabled data-bound-disabled="true"' : ''}>${iconSvg('plus')}${text('recipe.ingredient.add')}</button></section>`).join('');
    el('editor-steps').innerHTML = model.steps.map((step, index) => `<div class="recipe-editor-step" data-key="${escapeHtmlAttr(step.client_key)}"><div class="recipe-editor-row-heading"><span data-recipe-step-label>${escapeHtml(t('recipe.step.number', { number: index + 1 }))}</span>${orderButtons('step', step.client_key, index, model.steps.length)}</div><div class="recipe-editor-step-fields"><label for="recipe-step-title-${escapeHtmlAttr(step.client_key)}">${text('recipe.step.title')}<input id="recipe-step-title-${escapeHtmlAttr(step.client_key)}" class="ui-field" data-field="step-title" maxlength="200" value="${escapeHtmlAttr(step.title)}" autocomplete="off"></label><label for="recipe-step-${escapeHtmlAttr(step.client_key)}">${text('recipe.step.text')}<textarea id="recipe-step-${escapeHtmlAttr(step.client_key)}" class="ui-field" rows="3" maxlength="8000" aria-describedby="recipe-step-hint">${escapeHtml(step.text)}</textarea></label></div><details class="recipe-editor-step-ingredients" ${openPickers.has(step.client_key) ? 'open' : ''}><summary data-recipe-editor-action="step-ingredients-toggle" data-key="${escapeHtmlAttr(step.client_key)}">${text('recipe.step.ingredients.assign')}<span data-step-selected-count></span></summary><p class="recipe-step-hint">${text('recipe.step.ingredients.hint')}</p><div data-step-picker-content role="group" aria-label="${escapeHtmlAttr(t('recipe.step.ingredients.label'))}" data-i18n-aria-label-key="recipe.step.ingredients.label"></div></details></div>`).join('');
    el('editor-tags').innerHTML = model.tags.map((tag, index) => `<div class="recipe-editor-tag"><input class="ui-field" value="${escapeHtmlAttr(tag)}" required maxlength="80" aria-label="${escapeHtmlAttr(t('recipe.tag'))}" data-i18n-aria-label-key="recipe.tag"><button type="button" class="btn btn-secondary btn-icon" data-recipe-editor-action="tag-remove" data-index="${index}" aria-label="${escapeHtmlAttr(t('common.delete'))}" data-i18n-aria-label-key="common.delete">${iconSvg('trash-2')}</button></div>`).join('');
    for (const [action, count, max] of [['group-add', model.ingredient_groups.length, 50], ['step-add', model.steps.length, 100], ['tag-add', model.tags.length, 40]]) {
      const node = el('form').querySelector(`[data-recipe-editor-action="${action}"]`); node.disabled = count >= max; node.dataset.boundDisabled = String(count >= max);
    }
    refreshStepPickers();
    for (const group of el('editor-steps').querySelectorAll('[data-step-group]')) group.open = openGroups.has(JSON.stringify([group.closest('.recipe-editor-step').dataset.key, group.dataset.stepGroup]));
    permissions();
    if (focusKey != null) {
      const row = Array.from(el('form').querySelectorAll('[data-key]')).find(node => node.dataset.key === focusKey);
      if (focusAction) {
        const opposite = focusAction === 'group-up' ? 'group-down' : 'group-up';
        (row?.querySelector(`button[data-recipe-editor-action="${focusAction}"]:not(:disabled)`)
          || row?.querySelector(`button[data-recipe-editor-action="${opposite}"]:not(:disabled)`))?.focus();
      } else {
        const name = row?.querySelector('input[data-field="name"]');
        (name && !name.disabled ? name : row?.querySelector('input[data-field="group-name"],textarea,button[data-recipe-editor-action="ingredient-edit"]'))?.focus();
      }
    }
    validateQuantities();
  }
  function validateQuantities() {
    for (const row of el('form')?.querySelectorAll('.recipe-editor-ingredient') || []) {
      const quantity = row.querySelector('[data-field="quantity_value"]'), free = row.querySelector('[data-field="quantity_text"]');
      const invalid = quantity.value !== '' && free.value.trim() !== '';
      quantity.setCustomValidity(invalid || (quantity.value !== '' && !(Number(quantity.value) > 0)) ? t('recipe.validation.quantity') : '');
      row.querySelector('.recipe-quantity-error').hidden = !invalid;
    }
    const base = el('base-servings'); base?.setCustomValidity(Number(base.value) > 0 ? '' : t('recipe.validation.servings'));
  }
  function renderImage() {
    const img = el('image-preview-img'), requested = ++imageGeneration, captured = generation;
    releaseRecipeImage(img);
    const recipe = openedRecipe || { cookbook_id: book()?.id, title: el('name')?.value || '' };
    el('image-preview').hidden = !hasImage(); imagePicker.refresh();
    if (!hasImage()) return;
    const isCurrent = () => requested === imageGeneration && captured === generation && active() && validSession() && Boolean(book());
    const item = imageData !== undefined ? { ...recipe, cookbook_id: book()?.id, image_url: imageData, image_data: imageData } : recipe;
    Promise.resolve(loadRecipeImage(img, item, { isCurrent, draft: imageData !== undefined })).then(ok => { if (isCurrent()) { el('image-preview').hidden = !ok; imagePicker.refresh(); } }).catch(err => { if (isCurrent()) { error(err.code || 'recipe.image.invalid'); onError(err); } });
  }
  function removeImage() {
    imageGeneration++; preparing = false; imageData = originalImage() ? null : undefined;
    el('image-file').value = ''; renderImage(); modal.refreshSaveState();
  }
  function open(recipe, cookbookId) {
    abortAI();
    openedBook = books().find(candidate => sameEntityId(candidate.id, cookbookId));
    if (!canEditRecipe(recipe, openedBook)) return false;
    generation++; session = getSessionIdentity(); el('cookbook-id').value = openedBook.id; openedRecipe = recipe; baselineRevision = recipe?.revision ?? null; busy = null;
    const ok = modal.open(recipe);
    // The shared shell activates after rendering; live-only controls must be
    // re-evaluated once this editor is actually active.
    permissions();
    baseline = readState();
    renderImage();
    return ok;
  }
  function showImport(draft, cookbookId, { warnings = [], reviewHint = 'recipe.import.reviewHint' } = {}) {
    // Keep the original empty-create baseline: an imported draft is immediately
    // saveable, but it still has no persisted recipe identity or revision.
    const content = draft && validateRecipeChanges(draft, true);
    if (active() || !content || !open(null, cookbookId)) return false;
    for (const group of content.ingredient_groups || []) {
      delete group.id;
      for (const ingredient of group.ingredients || []) delete ingredient.id;
    }
    for (const step of content.steps || []) delete step.id;
    renderContent(content);
    appearance.setValues({ name: content.title });
    imageData = content.image_data || undefined;
    importWarnings = [...new Set(warnings.filter(key => typeof key === 'string' && /^(?:recipe\.import\.|recipe\.ai\.)/u.test(key)))];
    reviewHintKey = reviewHint === 'recipe.ai.reviewHint' ? reviewHint : 'recipe.import.reviewHint';
    renderImportReview(); renderImage(); permissions(); modal.refreshSaveState();
    return true;
  }
  const aiErrors = new Set(['unavailable', 'notConfigured', 'invalidInput', 'failed', 'invalidResponse', 'tooLarge', 'busy', 'rateLimited', 'offline'].map(key => `recipe.ai.${key}`));
  function refreshAI() {
    const button = el('ai-refine-btn'), status = el('ai-status');
    if (button) {
      button.hidden = !getBrainDumpAccess() || !active() || !editable() || Boolean(current()?.conflict);
      button.disabled = !getBrainDumpAccess() || !editable() || Boolean(busy) || preparing || !isOnline() || !valid(readState());
    }
    if (status) { status.hidden = busy?.kind !== 'ai'; status.textContent = busy?.kind === 'ai' ? t('recipe.ai.refining') : ''; }
  }
  function abortAI() {
    if (busy?.kind !== 'ai') return;
    busy.controller?.abort(); busy = null;
  }
  async function refineWithBrainDump() {
    if (!active() || !editable() || current()?.conflict || busy || preparing) return false;
    if (!getBrainDumpAccess() || typeof api?.aiPreview !== 'function') { error('recipe.ai.unavailable'); return false; }
    if (!isOnline()) { error('recipe.ai.offline'); return false; }
    const before = readState(), submitted = validateRecipeChanges(before, true);
    if (!submitted || !activeIngredientValid() || !el('form').reportValidity()) { error('recipe.ai.invalidInput'); return false; }
    delete submitted.image_data;
    for (const group of submitted.ingredient_groups) {
      delete group.id;
      for (const ingredient of group.ingredients) delete ingredient.id;
    }
    for (const step of submitted.steps) delete step.id;
    const captured = generation, capturedSession = session, capturedId = el('id').value, capturedBook = book().id;
    const signature = JSON.stringify(comparable(before));
    const token = { kind: 'ai', controller: typeof AbortController === 'undefined' ? null : new AbortController() };
    const isCurrent = () => busy === token && captured === generation && capturedSession === getSessionIdentity()
      && active() && editable() && getBrainDumpAccess() && !current()?.conflict
      && el('id').value === capturedId && sameEntityId(book()?.id, capturedBook);
    busy = token; error(''); permissions();
    try {
      const response = await api.aiPreview({ draft: submitted }, { signal: token.controller?.signal });
      if (!isCurrent()) return false;
      if (JSON.stringify(comparable(readState())) !== signature) { error('recipe.ai.draftChanged'); return false; }
      const data = response?.draft && validateRecipeChanges(response.draft, true);
      if (!data) throw Object.assign(new Error('Invalid recipe response'), { code: 'recipe.ai.invalidResponse' });
      delete data.image_data;
      // Source attribution and the actual image are owned by the current editor,
      // never by model output. Stable client keys retain local child identities.
      for (const key of ['source_url', 'source_name', 'source_author', 'source_yield']) data[key] = before[key] || '';
      const groups = new Map(before.ingredient_groups.map(group => [group.client_key, group]));
      const ingredients = new Map(before.ingredient_groups.flatMap(group => group.ingredients).map(item => [item.client_key, item]));
      const steps = new Map(before.steps.map(step => [step.client_key, step]));
      for (const group of data.ingredient_groups) {
        delete group.id; if (groups.get(group.client_key)?.id != null) group.id = groups.get(group.client_key).id;
        for (const item of group.ingredients) { delete item.id; if (ingredients.get(item.client_key)?.id != null) item.id = ingredients.get(item.client_key).id; }
      }
      for (const step of data.steps) { delete step.id; if (steps.get(step.client_key)?.id != null) step.id = steps.get(step.client_key).id; }
      const retainedImage = imageData;
      renderContent({ ...data, cookbook_id: capturedBook });
      appearance.setValues({ name: data.title }); imageData = retainedImage;
      importWarnings = [...new Set((Array.isArray(response.warnings) ? response.warnings : []).filter(key => typeof key === 'string' && key.startsWith('recipe.ai.')))];
      reviewHintKey = 'recipe.ai.reviewHint';
      renderImportReview(); renderImage();
      return true;
    } catch (err) {
      if (!isCurrent()) return false;
      error(aiErrors.has(err.code || err.data?.detail?.code) ? (err.code || err.data.detail.code) : 'recipe.ai.failed');
      onError(err); return false;
    } finally { if (busy === token) { busy = null; permissions(); modal.refreshSaveState(); } }
  }
  function deactivate() {
    abortAI();
    generation++; imageGeneration++; busy = null; preparing = false; imageData = undefined;
    imagePicker.close(); closeOpenDropdown('recipe-deactivate'); ingredientEdit = null;
    releaseRecipeImage(el('image-preview-img')); openedRecipe = null; openedBook = null;
    if (!closeUiLayerNow('recipe-modal', { reason: 'module-deactivate' })) modal.close({ fromHistory: true });
  }
  function reconcile() {
    if (!active()) { abortAI(); return false; }
    if (!getBrainDumpAccess()) abortAI();
    if (!validSession() || !book() || (el('id').value && !current())) { deactivate(); return true; }
    if (current()?.conflict) el('editor-conflict').innerHTML = renderRecipeConflict(current());
    else el('editor-conflict').innerHTML = '';
    permissions();
    return false;
  }
  function remapRecipeId(from, to) {
    if (!sameEntityId(el('id')?.value, from)) return false;
    const recipe = recipeController.getRecipe(to);
    if (!recipe) return false;
    el('id').value = String(recipe.id); el('cookbook-id').value = String(recipe.cookbook_id);
    const remapChildren = content => ({ ...content,
      ingredient_groups: content.ingredient_groups.map(group => {
        const server = (recipe.ingredient_groups || []).find(candidate => candidate.client_key === group.client_key);
        return { ...group, ...(server?.id != null ? { id: server.id } : {}), ingredients: group.ingredients.map(item => {
          const canonical = server?.ingredients?.find(candidate => candidate.client_key === item.client_key);
          return { ...item, ...(canonical?.id != null ? { id: canonical.id } : {}) };
        }) };
      }), steps: content.steps.map(step => {
        const canonical = (recipe.steps || []).find(candidate => candidate.client_key === step.client_key);
        return { ...step, ...(canonical?.id != null ? { id: canonical.id } : {}) };
      }),
    });
    model = remapChildren(model); if (baseline) baseline = remapChildren(baseline);
    openedRecipe = recipe; modal.refreshSaveState(); return true;
  }
  async function save(event) {
    event?.preventDefault?.(); validateQuantities();
    if (!active() || busy || !modal.canSave() || !el('form').reportValidity()) return;
    const data = readState(); if (!valid(data)) return;
    const captured = generation, capturedSession = session, token = {}; busy = token; refreshStepIngredientPermissions(); modal.refreshSaveState();
    const isCurrent = () => captured === generation && capturedSession === getSessionIdentity() && active() && editable();
    try {
      const recipe = current();
      const content = comparable(data), original = comparable(baseline);
      const changes = Object.fromEntries(Object.entries(data).filter(([name]) => JSON.stringify(content[name]) !== JSON.stringify(original[name])));
      const saved = recipe ? await recipeController.update(recipe.id, changes, { isCurrent, expectedRevision: baselineRevision })
        : await recipeController.create(book().id, data, { isCurrent });
      if (!isCurrent()) return;
      if (!saved) { reconcile(); return; }
      if (saved.conflict) { reconcile(); return; }
      generation++; modal.close({ afterClose: () => { if (capturedSession === getSessionIdentity()) onSaved(saved); } });
    } catch (err) { if (isCurrent()) { error('recipe.error.saveFailed'); onError(err); } }
    finally { if (busy === token) { busy = null; refreshStepIngredientPermissions(); if (captured === generation) { imagePicker.refresh(); modal.refreshSaveState(); } } }
  }
  async function remove() {
    const recipe = current(); if (!recipe || busy || !editable() || recipe.conflict) return;
    const captured = generation, capturedSession = session, token = {}; busy = token; refreshStepIngredientPermissions(); modal.refreshSaveState();
    const isCurrent = () => captured === generation && capturedSession === getSessionIdentity() && active() && editable();
    try {
      if (!await confirmDanger({ title: t('recipe.delete.title'), message: t('recipe.delete.message', { title: recipe.title }), confirmText: t('common.delete') }) || !isCurrent()) return;
      const removed = await recipeController.remove(recipe.id, { isCurrent, expectedRevision: baselineRevision });
      if (capturedSession !== getSessionIdentity() || captured !== generation) return;
      if (!removed) { if (isCurrent()) reconcile(); return; }
      generation++; modal.close({ afterClose: () => { if (capturedSession === getSessionIdentity()) onDeleted(recipe); } });
    } catch (err) { if (isCurrent()) { error('recipe.error.deleteFailed'); onError(err); } }
    finally { if (busy === token) { busy = null; refreshStepIngredientPermissions(); if (captured === generation) { imagePicker.refresh(); modal.refreshSaveState(); } } }
  }
  async function action(event) {
    const target = event.target.closest?.('[data-recipe-editor-action],#recipe-editor-conflict [data-recipe-action]');
    if (!target || !el('form')?.contains(target)) return;
    event.preventDefault();
    const action = target.dataset.recipeEditorAction || target.dataset.recipeAction;
    if (action === 'brain-dump') { await refineWithBrainDump(); return; }
    if (['keep-local', 'use-server'].includes(action)) {
      const recipe = current(); if (!recipe?.conflict || busy || !editable()) return;
      const draft = readState(), original = comparable(baseline), content = comparable(draft);
      const unsaved = action === 'keep-local' ? Object.fromEntries(Object.entries(draft).filter(([name]) => JSON.stringify(content[name]) !== JSON.stringify(original[name]))) : {};
      const captured = generation, capturedSession = session, token = {}; busy = token; refreshStepIngredientPermissions();
      const isCurrent = () => generation === captured && getSessionIdentity() === capturedSession && active() && editable();
      try {
        const resolved = await resolveRecipeConflict({ recipe, keepLocal: action === 'keep-local', controller: recipeController, confirmDanger, isCurrent });
        if (!isCurrent()) return;
        const latest = recipeController.getRecipe(recipe.id);
        if (!latest) { deactivate(); onDeleted(recipe); }
        else if (resolved || !latest.conflict) {
          openedRecipe = latest; baselineRevision = latest.revision;
          modal.reconcile(latest); baseline = readState(); modal.resetSaveState();
          // Conflict resolution concerns the durable queued intent. Keep later
          // unsaved form edits as a separate dirty draft against that result.
          if (Object.keys(unsaved).length) {
            modal.reconcile({ ...latest, ...unsaved });
            if (Object.hasOwn(unsaved, 'image_data')) imageData = unsaved.image_data;
          }
          renderImage();
        }
      } catch (err) { if (isCurrent()) { error('recipe.error.saveFailed'); onError(err); } }
      finally { if (busy === token) { busy = null; refreshStepIngredientPermissions(); imagePicker.refresh(); modal.refreshSaveState(); } }
      return;
    }
    if (!editable() || current()?.conflict || busy || !active()) return;
    if (action === 'step-quantity-toggle' || action === 'step-quantity-reset') {
      const choice = target.closest('[data-step-choice]');
      const step = model.steps.find(step => step.client_key === target.closest('.recipe-editor-step').dataset.key);
      const link = step?.ingredients?.find(link => link.ingredient_client_key === choice.dataset.stepChoice);
      if (!link) return;
      if (action === 'step-quantity-toggle') { const details = target.closest('details'); details.open = !details.open; }
      else { link.show_quantity = true; link.quantity_value = link.quantity_text = null; choice.querySelector('[data-step-quantity-value]').value = ''; choice.querySelector('[data-step-quantity-text]').value = ''; refreshStepPickers(); modal.refreshSaveState(); }
      return;
    }
    if (action === 'step-ingredients-toggle') {
      const picker = target.closest('details'); picker.open = !picker.open;
      if (picker.open) refreshStepPickers();
      return;
    }
    const closingIngredient = action === 'ingredient-edit' && ingredientEdit?.key === target.dataset.key;
    if (!closingIngredient && ['ingredient-edit', 'ingredient-add', 'ingredient-done'].includes(action) && !activeIngredientValid()) return;
    const data = readState(); model = { tags: data.tags, ingredient_groups: data.ingredient_groups, steps: data.steps };
    if (action === 'ingredient-edit' || action === 'ingredient-done' || action === 'ingredient-cancel') {
      const group = model.ingredient_groups.find(group => group.client_key === target.dataset.groupKey);
      const index = group?.ingredients.findIndex(item => item.client_key === target.dataset.key) ?? -1;
      if (index < 0) return;
      if (action === 'ingredient-edit') {
        ingredientEdit = closingIngredient ? null : { key: target.dataset.key, original: { ...group.ingredients[index] }, mode: group.ingredients[index].quantity_text ? 'text' : 'number', isNew: false };
      } else {
        if (ingredientEdit?.key !== target.dataset.key) return;
        if (action === 'ingredient-cancel') {
          if (ingredientEdit.isNew) group.ingredients.splice(index, 1);
          else group.ingredients[index] = { ...group.ingredients[index], ...ingredientEdit.original };
        }
        ingredientEdit = null;
      }
      renderRows();
      const row = Array.from(el('editor-groups').querySelectorAll('.recipe-editor-ingredient')).find(node => node.dataset.key === target.dataset.key);
      (row?.querySelector('[data-recipe-editor-action="ingredient-edit"]') || Array.from(el('editor-groups').querySelectorAll('[data-recipe-editor-action="ingredient-add"]')).find(node => node.dataset.groupKey === group.client_key))?.focus({ preventScroll: true });
      modal.refreshSaveState(); return;
    }
    let focusKey;
    const [kind, operation] = action.split('-');
    if (action === 'group-add' && model.ingredient_groups.length < 50) { const group = { client_key: newKey(), name: '', ingredients: [] }; model.ingredient_groups.push(group); focusKey = group.client_key; }
    else if (action === 'step-add' && model.steps.length < 100) { const step = { client_key: newKey(), title: '', text: '', ingredients: [] }; model.steps.push(step); focusKey = step.client_key; }
    else if (action === 'tag-add' && model.tags.length < 40) model.tags.push('');
    else if (action === 'tag-remove') model.tags.splice(Number(target.dataset.index), 1);
    else {
      const group = model.ingredient_groups.find(group => group.client_key === target.dataset.groupKey);
      if (action === 'ingredient-add' && group && model.ingredient_groups.flatMap(group => group.ingredients).length < 500) { const item = { client_key: newKey(), name: '', quantity_value: null, quantity_unit: '', quantity_text: '', note: '' }; group.ingredients.push(item); ingredientEdit = { key: item.client_key, original: null, mode: 'number', isNew: true }; focusKey = item.client_key; }
      else {
        const array = kind === 'group' ? model.ingredient_groups : kind === 'ingredient' ? group?.ingredients : kind === 'step' ? model.steps : null;
        const index = array?.findIndex(item => item.client_key === target.dataset.key) ?? -1;
        if (index >= 0) {
          if (operation === 'remove') array.splice(index, 1);
          else { const next = index + (operation === 'up' ? -1 : 1); if (next >= 0 && next < array.length) { [array[index], array[next]] = [array[next], array[index]]; focusKey = array[next].client_key; } }
        }
      }
    }
    renderRows(focusKey, kind === 'group' && ['up', 'down'].includes(operation) ? action : null); modal.refreshSaveState();
  }
  function bind() {
    if (bound) return; bound = true; modal.bind(); imagePicker.bind(); root.addEventListener('click', action);
    const win = root.defaultView || globalThis.window;
    win?.addEventListener('online', refreshAI);
    win?.addEventListener('offline', () => { if (busy?.kind === 'ai') { abortAI(); error('recipe.ai.offline'); permissions(); } else refreshAI(); });
    if (win?.MutationObserver && el('modal')) new win.MutationObserver(() => {
      if (!active() && busy?.kind === 'ai') { abortAI(); permissions(); }
    }).observe(el('modal'), { attributes: true, attributeFilter: ['class'] });
    globalThis.window?.addEventListener('nia-language-change', () => {
      translatePage(el('modal'));
      renderImportReview(); refreshAI();
      imagePicker.refresh();
      const ingredients = new Map(readState().ingredient_groups.flatMap(group => group.ingredients).map(item => [item.client_key, item]));
      for (const row of el('editor-groups').querySelectorAll('.recipe-editor-ingredient')) {
        const item = ingredients.get(row.dataset.key);
        row.querySelector('.recipe-editor-ingredient-copy').innerHTML = ingredientSummary(item);
        refreshSelect(row.querySelector('select'));
      }
      el('editor-steps').querySelectorAll('[data-recipe-step-label]').forEach((node, index) => { node.textContent = t('recipe.step.number', { number: index + 1 }); });
      refreshStepPickers();
      validateQuantities(); if (errorKey) error(errorKey);
    });
    el('form').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && event.target.matches('[data-field="group-name"]')) {
        event.preventDefault(); event.target.blur();
      }
    });
    el('form').addEventListener('input', event => {
      if (updateStepQuantity(event.target)) return;
      const row = event.target.closest('.recipe-editor-ingredient');
      if (row) {
        const item = readState().ingredient_groups.flatMap(group => group.ingredients).find(item => item.client_key === row.dataset.key);
        row.querySelector('.recipe-editor-ingredient-copy').innerHTML = ingredientSummary(item);
      }
      if (row || event.target.matches('[data-field="group-name"]')) refreshStepPickers();
      validateQuantities(); if (new TextEncoder().encode(JSON.stringify(readState())).length > 512 * 1024) error('recipe.error.tooLarge'); refreshAI(); modal.refreshSaveState();
    });
    el('form').addEventListener('change', event => {
      if (updateStepQuantity(event.target)) return;
      if (event.target.matches('[data-step-ingredient]')) {
        if (!active() || !editable() || current()?.conflict || busy) { refreshStepPickers(); return; }
        const step = model.steps.find(value => value.client_key === event.target.closest('.recipe-editor-step')?.dataset.key);
        if (!step) return;
        const key = event.target.dataset.stepIngredient;
        step.ingredients = (step.ingredients || []).filter(link => link.ingredient_client_key !== key);
        if (event.target.checked) step.ingredients.push({ ingredient_client_key: key, show_quantity: true });
        refreshStepPickers(); modal.refreshSaveState(); return;
      }
      if (event.target.dataset.field === 'quantity_unit' && editable() && !current()?.conflict && !busy) {
        event.target.value = formatQuantityUnit(event.target.value, getActiveLocale());
        event.target.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (event.target.dataset.field !== 'quantity_mode' || !editable() || current()?.conflict || busy) return;
      const row = event.target.closest('.recipe-editor-ingredient');
      if (row.dataset.key !== ingredientEdit?.key) return;
      ingredientEdit.mode = event.target.value;
      const clear = event.target.value === 'text' ? ['quantity_value', 'quantity_unit'] : ['quantity_text'];
      for (const name of clear) row.querySelector(`[data-field="${name}"]`).value = '';
      permissions(); row.querySelector('[data-field="name"]').dispatchEvent(new Event('input', { bubbles: true }));
    });
    el('image-file').addEventListener('change', async event => {
      const file = event.target.files?.[0]; if (!file || !editable()) return;
      const requested = ++imageGeneration, captured = generation, capturedSession = session; preparing = true; modal.refreshSaveState();
      const isCurrent = () => requested === imageGeneration && captured === generation && capturedSession === getSessionIdentity() && active() && editable();
      try { const data = await prepareRecipeImage(file); if (isCurrent()) { imageData = data; error(''); preparing = false; renderImage(); modal.refreshSaveState(); } }
      catch (err) { if (isCurrent()) { preparing = false; error(err.code === 'recipe.image.tooLarge' ? err.code : 'recipe.image.invalid'); } }
      finally { if (requested === imageGeneration && captured === generation && capturedSession === getSessionIdentity()) { preparing = false; modal.refreshSaveState(); } }
    });
  }
  return { bind, showCreate: cookbookId => open(null, cookbookId), showImport, showEdit: id => { const recipe = recipeController.getRecipe(id); return recipe ? open(recipe, recipe.cookbook_id) : false; },
    reconcile, remapRecipeId, deactivate, save, refineWithBrainDump, deleteCurrentRecipe: remove, getDraft: readState };
}
