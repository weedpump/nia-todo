import { t, translatePage } from '../i18n/index.js';
import { escapeHtml, escapeHtmlAttr } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { renderDetailModalFrame } from '../ui/detail-modal.js';
import { renderEntityDetailHeader } from './entity-detail-header.js';
import { createEntityEditorModalController } from './entity-editor-modal.js';
import { closeUiLayerNow } from './ui-history.js';
import { sameEntityId } from './entity-metadata.js';
import { validateRecipeChanges } from './recipe-pending.js';
import { canEditRecipe, renderRecipeConflict, resolveRecipeConflict } from './recipe-view.js';

const text = key => `<span data-i18n-key="${escapeHtmlAttr(key)}">${escapeHtmlAttr(t(key))}</span>`;
const field = (id, key, type = 'text', attrs = '') => `<div class="form-group"><label for="recipe-${id}">${text(key)}</label><input id="recipe-${id}" class="ui-field" type="${type}" ${attrs}></div>`;
export function renderRecipeEditorModal() {
  return renderDetailModalFrame({ id: 'recipe-modal', contentClasses: ['modal-content', 'entity-modal-content', 'ui-detail-modal-content', 'recipe-editor-content'],
    rootAttributes: { role: 'dialog', 'aria-modal': 'true', 'aria-hidden': 'true', 'aria-labelledby': 'recipe-modal-title' },
    headerHtml: renderEntityDetailHeader({ icon: 'book-open', title: { id: 'recipe-modal-title', key: 'recipe.new' }, subtitle: { key: 'recipe.editor.subtitle' },
      actionsHtml: `<button type="submit" form="recipe-form" id="recipe-save-btn" class="btn btn-primary" data-i18n-key="common.save">${text('common.save')}</button>
      <details class="ui-detail-header-menu-toggle" id="recipe-detail-header-menu" hidden><summary id="recipe-detail-header-menu-trigger" aria-label="${escapeHtmlAttr(t('common.more'))}" data-i18n-aria-label-key="common.more">${iconSvg('menu')}</summary><div class="ui-detail-header-menu ui-menu" role="menu"><button type="button" id="recipe-delete-btn" class="ui-menu-item danger" role="menuitem">${iconSvg('trash-2')}${text('common.delete')}</button></div></details>
      <button type="button" class="modal-close-x" data-close-modal="recipe-modal" aria-label="${escapeHtmlAttr(t('common.close'))}" data-i18n-aria-label-key="common.close">${iconSvg('x')}</button>` }),
    bodyHtml: `<form id="recipe-form" class="entity-modal-form ui-detail-shell">
      <input type="hidden" id="recipe-id"><input type="hidden" id="recipe-cookbook-id">
      <div id="recipe-editor-conflict"></div>
      <section class="ui-section-card ui-detail-section ui-detail-title-section"><div class="form-group ui-detail-title-group"><label for="recipe-name">${text('recipe.title')}</label><input id="recipe-name" class="ui-field ui-detail-title-field" required maxlength="200" autocomplete="off"></div></section>
      <section class="ui-section-card ui-detail-section"><div class="form-group"><label for="recipe-description">${text('entity.description')}</label><textarea id="recipe-description" class="ui-field" rows="3" maxlength="4000"></textarea></div>
        <div class="recipe-editor-meta">${field('base-servings', 'recipe.baseServings', 'number', 'required min="0" max="100000" step="any"')}${field('prep-minutes', 'recipe.prepLabel', 'number', 'min="0" max="100000" step="1"')}${field('cook-minutes', 'recipe.cookLabel', 'number', 'min="0" max="100000" step="1"')}</div>
        <div class="recipe-section-heading"><h3>${text('recipe.tags')}</h3><button type="button" class="btn btn-secondary" data-recipe-editor-action="tag-add">${text('recipe.tag.add')}</button></div><div id="recipe-editor-tags" class="recipe-editor-tags"></div>
      </section>
      <section class="ui-section-card ui-detail-section"><h3>${text('recipe.image.title')}</h3><div id="recipe-image-preview" class="recipe-editor-image" hidden><img id="recipe-image-preview-img" alt="${escapeHtmlAttr(t('recipe.image.title'))}" data-i18n-alt-key="recipe.image.title"></div>
        <div class="form-group"><label for="recipe-image-file">${text('recipe.image.choose')}</label><input id="recipe-image-file" type="file" class="ui-field" accept="image/jpeg,image/png,image/webp"></div>
        <button type="button" class="btn btn-secondary" id="recipe-image-remove" data-recipe-editor-action="image-remove" hidden>${text('recipe.image.remove')}</button>
      </section>
      <section class="ui-section-card ui-detail-section"><div class="recipe-section-heading"><h3>${text('recipe.ingredients')}</h3><button type="button" class="btn btn-secondary" data-recipe-editor-action="group-add">${text('recipe.group.add')}</button></div><div id="recipe-editor-groups"></div></section>
      <section class="ui-section-card ui-detail-section"><div class="recipe-section-heading"><h3>${text('recipe.steps')}</h3><button type="button" class="btn btn-secondary" data-recipe-editor-action="step-add">${text('recipe.step.add')}</button></div><p id="recipe-step-hint" class="recipe-step-hint">${text('recipe.steps.hint')}</p><div id="recipe-editor-steps"></div></section>
      <p id="recipe-error" class="form-error" role="alert"></p></form>` });
}
let nextKey = 0;
const newKey = () => globalThis.crypto?.randomUUID?.() || `recipe-row-${Date.now()}-${++nextKey}`;
const identity = value => ({ ...(value.id != null ? { id: value.id } : {}), client_key: value.client_key || newKey() });
const cloneContent = recipe => ({
  tags: [...(recipe?.tags || [])],
  ingredient_groups: (recipe?.ingredient_groups || []).map(group => ({ ...identity(group), name: group.name || '', ingredients: (group.ingredients || []).map(item => ({ ...identity(item), name: item.name || '', quantity_value: item.quantity_value ?? null, quantity_unit: item.quantity_unit || '', quantity_text: item.quantity_text || '', note: item.note || '' })) })),
  steps: (recipe?.steps || []).map(step => ({ ...identity(step), text: step.text || '' })),
});
function orderButtons(kind, key, index, length, groupKey = '') {
  const attributes = `data-key="${escapeHtmlAttr(key)}"${groupKey ? ` data-group-key="${escapeHtmlAttr(groupKey)}"` : ''}`;
  return `<div class="recipe-row-actions">${[['up', 'chevron-up', index === 0, 'recipe.moveUp'], ['down', 'chevron-down', index === length - 1, 'recipe.moveDown'], ['remove', 'x', false, 'common.delete']].map(([action, icon, disabled, label]) => `<button type="button" class="btn btn-secondary btn-icon" data-recipe-editor-action="${kind}-${action}" ${attributes} ${disabled ? 'disabled data-bound-disabled="true"' : ''} aria-label="${escapeHtmlAttr(t(label))}" title="${escapeHtmlAttr(t(label))}" data-i18n-aria-label-key="${label}" data-i18n-title-key="${label}">${iconSvg(icon)}</button>`).join('')}</div>`;
}
export function createRecipeEditorFeature({ getCookbooks = () => [], recipeController,
  getSessionIdentity = () => 'embedded', root = globalThis.document, confirmDanger = async () => false,
  prepareRecipeImage = async () => { throw Object.assign(new Error('Image preparation unavailable'), { code: 'recipe.image.invalid' }); },
  loadRecipeImage = async () => false, releaseRecipeImage = () => {},
  onSaved = () => {}, onDeleted = () => {}, onError = console.error,
} = {}) {
  let model = cloneContent(null), baseline = null, openedRecipe = null, openedBook = null, baselineRevision = null;
  let session, generation = 0, imageGeneration = 0, imageData, preparing = false, busy = null, bound = false, errorKey = '';
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
          quantity_unit: value(row, 'quantity_unit').trim(), quantity_text: value(row, 'quantity_text').trim(), note: value(row, 'note').trim() };
      }) };
    });
    const steps = Array.from(el('editor-steps')?.querySelectorAll('.recipe-editor-step') || []).map(node => ({ ...identity(model.steps.find(step => step.client_key === node.dataset.key) || { client_key: node.dataset.key }), text: node.querySelector('textarea').value.trim() }));
    return { title: el('name')?.value.trim() || '', description: el('description')?.value.trim() || '',
      base_servings: el('base-servings') ? Number(el('base-servings').value) : 2,
      prep_minutes: el('prep-minutes') ? optionalNumber(el('prep-minutes')) : null, cook_minutes: el('cook-minutes') ? optionalNumber(el('cook-minutes')) : null,
      tags: Array.from(el('editor-tags')?.querySelectorAll('input') || []).map(input => input.value.trim()), ingredient_groups: groups, steps,
      ...(imageData !== undefined ? { image_data: imageData } : {}),
    };
  }
  const valid = data => Boolean(validateRecipeChanges(data, true));
  const comparable = data => ({ ...data,
    ingredient_groups: data.ingredient_groups.map(({ id, ingredients, ...group }) => ({ ...group, ingredients: ingredients.map(({ id, ...item }) => item) })),
    steps: data.steps.map(({ id, ...step }) => step),
  });
  let modal;
  function permissions() {
    const disabled = !editable() || Boolean(current()?.conflict);
    for (const field of el('form')?.querySelectorAll('input:not([type="hidden"]),textarea,select,button[data-recipe-editor-action]') || []) field.disabled = disabled;
    if (!disabled) {
      for (const node of el('form').querySelectorAll('[data-bound-disabled="true"]')) node.disabled = true;
    }
    for (const control of el('editor-conflict')?.querySelectorAll('button') || []) control.disabled = !editable() || Boolean(busy);
    modal?.syncDeleteMenu(Boolean(el('id')?.value && editable() && !current()?.conflict));
    modal?.refreshSaveState();
  }
  const appearance = { setValues: ({ name = '' }, { editable: canEdit = true } = {}) => { el('name').value = name; el('name').disabled = !canEdit; }, focusName: () => el('name')?.focus() };
  modal = createEntityEditorModalController({ prefix: 'recipe', document: root, appearanceController: appearance,
    readState: () => comparable(readState()), isValid: valid, canSubmit: () => editable() && !busy && !preparing && !current()?.conflict,
    resolveView: ({ entity }) => ({ mode: entity ? 'edit' : 'create', titleKey: entity ? 'recipe.edit' : 'recipe.new', appearance: { name: entity?.title || '' },
      appearanceEditable: canEditRecipe(entity, book()), ownershipCanManage: false, canDelete: Boolean(entity && canEditRecipe(entity, book()) && !entity.conflict), readOnly: !canEditRecipe(entity, book()),
      restoreFocus: () => root.querySelector('[data-recipe-action="edit"]') || root.querySelector('[data-recipe-action="create"]'),
    }),
    renderDomain: ({ entity }) => {
      model = cloneContent(entity); imageData = undefined; imageGeneration++; preparing = false;
      el('cookbook-id').value = entity?.cookbook_id ?? openedBook?.id ?? '';
      el('description').value = entity?.description || ''; el('base-servings').value = entity?.base_servings ?? 2;
      el('prep-minutes').value = entity?.prep_minutes ?? ''; el('cook-minutes').value = entity?.cook_minutes ?? '';
      el('image-file').value = ''; renderRows(); el('editor-conflict').innerHTML = renderRecipeConflict(entity);
      renderImage();
    }, applyDomainPermissions: permissions, clearError: () => error(''), onSubmit: save, onDelete: remove, onError,
  });
  function renderRows(focusKey = null) {
    const total = model.ingredient_groups.flatMap(group => group.ingredients).length;
    el('editor-groups').innerHTML = model.ingredient_groups.map((group, index) => `<section class="recipe-editor-group" data-key="${escapeHtmlAttr(group.client_key)}"><div class="recipe-editor-row-heading"><label>${text('recipe.group.name')}<input class="ui-field" data-field="group-name" maxlength="200" value="${escapeHtmlAttr(group.name)}"></label>${orderButtons('group', group.client_key, index, model.ingredient_groups.length)}</div>
      <div class="recipe-editor-ingredients">${group.ingredients.map((item, itemIndex) => `<div class="recipe-editor-ingredient" data-key="${escapeHtmlAttr(item.client_key)}"><div class="recipe-editor-ingredient-fields">
        ${[['quantity_value', 'common.quantity', 'number', item.quantity_value ?? '', 'min="0" step="any"'], ['quantity_unit', 'common.unit', 'text', item.quantity_unit, 'maxlength="40"'], ['name', 'recipe.ingredient.name', 'text', item.name, 'required maxlength="500"'], ['quantity_text', 'recipe.quantityText', 'text', item.quantity_text, 'maxlength="500"'], ['note', 'recipe.ingredient.note', 'text', item.note, 'maxlength="2000"']].map(([name, label, type, content, attributes]) => `<label>${text(label)}<input class="ui-field" data-field="${name}" type="${type}" value="${escapeHtmlAttr(content)}" ${attributes}></label>`).join('')}</div>
        <span class="form-error recipe-quantity-error" hidden>${text('recipe.validation.quantity')}</span>${orderButtons('ingredient', item.client_key, itemIndex, group.ingredients.length, group.client_key)}</div>`).join('')}</div>
      <button type="button" class="btn btn-secondary" data-recipe-editor-action="ingredient-add" data-group-key="${escapeHtmlAttr(group.client_key)}" ${total >= 500 ? 'disabled data-bound-disabled="true"' : ''}>${text('recipe.ingredient.add')}</button></section>`).join('');
    el('editor-steps').innerHTML = model.steps.map((step, index) => `<div class="recipe-editor-step" data-key="${escapeHtmlAttr(step.client_key)}"><label><span data-recipe-step-label>${escapeHtml(t('recipe.step.number', { number: index + 1 }))}</span><textarea class="ui-field" rows="4" required maxlength="8000" aria-describedby="recipe-step-hint">${escapeHtml(step.text)}</textarea></label>${orderButtons('step', step.client_key, index, model.steps.length)}</div>`).join('');
    el('editor-tags').innerHTML = model.tags.map((tag, index) => `<div class="recipe-editor-tag"><input class="ui-field" value="${escapeHtmlAttr(tag)}" required maxlength="80" aria-label="${escapeHtmlAttr(t('recipe.tag'))}" data-i18n-aria-label-key="recipe.tag"><button type="button" class="btn btn-secondary btn-icon" data-recipe-editor-action="tag-remove" data-index="${index}" aria-label="${escapeHtmlAttr(t('common.delete'))}" data-i18n-aria-label-key="common.delete">${iconSvg('x')}</button></div>`).join('');
    for (const [action, count, max] of [['group-add', model.ingredient_groups.length, 50], ['step-add', model.steps.length, 100], ['tag-add', model.tags.length, 40]]) {
      const node = el('form').querySelector(`[data-recipe-editor-action="${action}"]`); node.disabled = count >= max; node.dataset.boundDisabled = String(count >= max);
    }
    permissions();
    if (focusKey != null) {
      const row = Array.from(el('form').querySelectorAll('[data-key]')).find(node => node.dataset.key === focusKey);
      row?.querySelector('input[data-field="name"],input[data-field="group-name"],textarea')?.focus();
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
    const hasImage = imageData === null ? false : imageData !== undefined || Boolean(recipe.image_url || recipe.image_data);
    el('image-preview').hidden = !hasImage; el('image-remove').hidden = !hasImage;
    if (!hasImage) return;
    const isCurrent = () => requested === imageGeneration && captured === generation && active() && validSession() && Boolean(book());
    const item = imageData !== undefined ? { ...recipe, cookbook_id: book()?.id, image_url: imageData, image_data: imageData } : recipe;
    Promise.resolve(loadRecipeImage(img, item, { isCurrent, draft: imageData !== undefined })).then(ok => { if (isCurrent()) el('image-preview').hidden = !ok; }).catch(err => { if (isCurrent()) { error(err.code || 'recipe.image.invalid'); onError(err); } });
  }
  function open(recipe, cookbookId) {
    openedBook = books().find(candidate => sameEntityId(candidate.id, cookbookId));
    if (!canEditRecipe(recipe, openedBook)) return false;
    generation++; session = getSessionIdentity(); el('cookbook-id').value = openedBook.id; openedRecipe = recipe; baselineRevision = recipe?.revision ?? null; busy = null;
    const ok = modal.open(recipe);
    baseline = readState();
    renderImage();
    return ok;
  }
  function deactivate() {
    generation++; imageGeneration++; busy = null; preparing = false; imageData = undefined;
    releaseRecipeImage(el('image-preview-img')); openedRecipe = null; openedBook = null;
    if (!closeUiLayerNow('recipe-modal', { reason: 'module-deactivate' })) modal.close({ fromHistory: true });
  }
  function reconcile() {
    if (!active()) return false;
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
    const captured = generation, capturedSession = session, token = {}; busy = token; modal.refreshSaveState();
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
    finally { if (busy === token) { busy = null; if (captured === generation) modal.refreshSaveState(); } }
  }
  async function remove() {
    const recipe = current(); if (!recipe || busy || !editable() || recipe.conflict) return;
    const captured = generation, capturedSession = session, token = {}; busy = token; modal.refreshSaveState();
    const isCurrent = () => captured === generation && capturedSession === getSessionIdentity() && active() && editable();
    try {
      if (!await confirmDanger({ title: t('recipe.delete.title'), message: t('recipe.delete.message', { title: recipe.title }), confirmText: t('common.delete') }) || !isCurrent()) return;
      const removed = await recipeController.remove(recipe.id, { isCurrent, expectedRevision: baselineRevision });
      if (capturedSession !== getSessionIdentity() || captured !== generation) return;
      if (!removed) { if (isCurrent()) reconcile(); return; }
      generation++; modal.close({ afterClose: () => { if (capturedSession === getSessionIdentity()) onDeleted(recipe); } });
    } catch (err) { if (isCurrent()) { error('recipe.error.deleteFailed'); onError(err); } }
    finally { if (busy === token) { busy = null; if (captured === generation) modal.refreshSaveState(); } }
  }
  async function action(event) {
    const target = event.target.closest?.('[data-recipe-editor-action],#recipe-editor-conflict [data-recipe-action]');
    if (!target || !el('form')?.contains(target)) return;
    event.preventDefault();
    const action = target.dataset.recipeEditorAction || target.dataset.recipeAction;
    if (['keep-local', 'use-server'].includes(action)) {
      const recipe = current(); if (!recipe?.conflict || busy || !editable()) return;
      const draft = readState(), original = comparable(baseline), content = comparable(draft);
      const unsaved = action === 'keep-local' ? Object.fromEntries(Object.entries(draft).filter(([name]) => JSON.stringify(content[name]) !== JSON.stringify(original[name]))) : {};
      const captured = generation, capturedSession = session, token = {}; busy = token;
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
      finally { if (busy === token) { busy = null; modal.refreshSaveState(); } }
      return;
    }
    if (!editable() || current()?.conflict || busy) return;
    if (action === 'image-remove') { imageGeneration++; preparing = false; imageData = openedRecipe?.image_url || openedRecipe?.image_data ? null : undefined; el('image-file').value = ''; renderImage(); modal.refreshSaveState(); return; }
    const data = readState(); model = { tags: data.tags, ingredient_groups: data.ingredient_groups, steps: data.steps };
    let focusKey;
    const [kind, operation] = action.split('-');
    if (action === 'group-add' && model.ingredient_groups.length < 50) { const group = { client_key: newKey(), name: '', ingredients: [] }; model.ingredient_groups.push(group); focusKey = group.client_key; }
    else if (action === 'step-add' && model.steps.length < 100) { const step = { client_key: newKey(), text: '' }; model.steps.push(step); focusKey = step.client_key; }
    else if (action === 'tag-add' && model.tags.length < 40) model.tags.push('');
    else if (action === 'tag-remove') model.tags.splice(Number(target.dataset.index), 1);
    else {
      const group = model.ingredient_groups.find(group => group.client_key === target.dataset.groupKey);
      if (action === 'ingredient-add' && group && model.ingredient_groups.flatMap(group => group.ingredients).length < 500) { const item = { client_key: newKey(), name: '', quantity_value: null, quantity_unit: '', quantity_text: '', note: '' }; group.ingredients.push(item); focusKey = item.client_key; }
      else {
        const array = kind === 'group' ? model.ingredient_groups : kind === 'ingredient' ? group?.ingredients : kind === 'step' ? model.steps : null;
        const index = array?.findIndex(item => item.client_key === target.dataset.key) ?? -1;
        if (index >= 0) {
          if (operation === 'remove') array.splice(index, 1);
          else { const next = index + (operation === 'up' ? -1 : 1); if (next >= 0 && next < array.length) { [array[index], array[next]] = [array[next], array[index]]; focusKey = array[next].client_key; } }
        }
      }
    }
    renderRows(focusKey); modal.refreshSaveState();
  }
  function bind() {
    if (bound) return; bound = true; modal.bind(); root.addEventListener('click', action);
    globalThis.window?.addEventListener('nia-language-change', () => {
      translatePage(el('modal'));
      el('editor-steps').querySelectorAll('[data-recipe-step-label]').forEach((node, index) => { node.textContent = t('recipe.step.number', { number: index + 1 }); });
      validateQuantities(); if (errorKey) error(errorKey);
    });
    el('form').addEventListener('input', () => { validateQuantities(); if (new TextEncoder().encode(JSON.stringify(readState())).length > 512 * 1024) error('recipe.error.tooLarge'); modal.refreshSaveState(); });
    el('image-file').addEventListener('change', async event => {
      const file = event.target.files?.[0]; if (!file || !editable()) return;
      const requested = ++imageGeneration, captured = generation, capturedSession = session; preparing = true; modal.refreshSaveState();
      const isCurrent = () => requested === imageGeneration && captured === generation && capturedSession === getSessionIdentity() && active() && editable();
      try { const data = await prepareRecipeImage(file); if (isCurrent()) { imageData = data; error(''); preparing = false; renderImage(); modal.refreshSaveState(); } }
      catch (err) { if (isCurrent()) { preparing = false; error(err.code === 'recipe.image.tooLarge' ? err.code : 'recipe.image.invalid'); } }
      finally { if (requested === imageGeneration && captured === generation && capturedSession === getSessionIdentity()) { preparing = false; modal.refreshSaveState(); } }
    });
  }
  return { bind, showCreate: cookbookId => open(null, cookbookId), showEdit: id => { const recipe = recipeController.getRecipe(id); return recipe ? open(recipe, recipe.cookbook_id) : false; },
    reconcile, remapRecipeId, deactivate, save, deleteCurrentRecipe: remove, getDraft: readState };
}
