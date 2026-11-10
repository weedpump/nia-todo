import { t, translatePage, getActiveLocale } from '../i18n/index.js';
import { escapeHtmlAttr } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { renderDetailModalFrame } from '../ui/detail-modal.js';
import { hydrateSelect, refreshSelect, closeOpenDropdown } from '../ui/dropdowns.js';
import { renderEntityDetailHeader } from './entity-detail-header.js';
import { createEntityEditorModalController } from './entity-editor-modal.js';
import { closeUiLayerNow } from './ui-history.js';
import { sameEntityId } from './entity-metadata.js';
import { ingredientAmount } from './recipe-view.js';
import { renderServingsControl, refreshServingsControl, stepServings } from '../ui/servings-control.js';
import { formatQuantity } from '../core/recipe-quantities.js';
import { buildRecipeShoppingPreview } from './recipe-shopping-preview.js';

const prefix = 'recipe-transfer';
const text = key => `<span data-i18n-key="${escapeHtmlAttr(key)}">${escapeHtmlAttr(t(key))}</span>`;
const field = (id, key) => `<label for="${prefix}-${id}">${text(key)}</label><select id="${prefix}-${id}" class="ui-field"></select>`;
export function renderRecipeShoppingTransferModal() {
  return renderDetailModalFrame({ id: `${prefix}-modal`,
    rootAttributes: { role: 'dialog', 'aria-modal': 'true', 'aria-hidden': 'true', 'aria-labelledby': `${prefix}-modal-title` },
    contentClasses: ['modal-content', 'entity-modal-content', 'ui-detail-modal-content', 'recipe-transfer-content'],
    headerHtml: renderEntityDetailHeader({ icon: 'shopping-cart', title: { id: `${prefix}-modal-title`, key: 'recipe.transfer.title' },
      actionsHtml: `<button type="submit" form="${prefix}-form" id="${prefix}-save-btn" class="btn btn-primary">${text('common.apply')}</button><button type="button" class="modal-close-x" data-close-modal="${prefix}-modal" aria-label="${escapeHtmlAttr(t('common.close'))}" data-i18n-aria-label-key="common.close">${iconSvg('x')}</button>` }),
    bodyHtml: `<form id="${prefix}-form" class="entity-modal-form ui-detail-shell">
      <div class="recipe-transfer-heading"><p id="${prefix}-recipe" class="recipe-transfer-title"></p>${renderServingsControl({ id: `${prefix}-servings`, required: true })}</div>
      <div class="form-group">${field('list', 'recipe.transfer.list')}</div>
      <details id="${prefix}-defaults" class="recipe-transfer-defaults"><summary>${text('recipe.transfer.defaults')}</summary><div class="recipe-transfer-targets"><div class="form-group">${field('section', 'common.section')}</div><div class="form-group">${field('store', 'shopping.item.store')}</div></div></details>
      <section class="recipe-transfer-summary" aria-labelledby="${prefix}-summary-title"><div class="recipe-transfer-selection"><h4 id="${prefix}-summary-title">${text('recipe.ingredients')}</h4><button type="button" id="${prefix}-select-all" class="btn btn-secondary">${text('recipe.transfer.selectNone')}</button></div><div id="${prefix}-preview"><div id="${prefix}-ingredients"></div></div></section><div id="${prefix}-pending" class="recipe-transfer-pending" role="status"></div>
      <p id="${prefix}-status" class="form-error" role="status"></p>
    </form>`,
    footerHtml: `<div class="modal-actions"><button type="button" class="btn btn-secondary" data-close-modal="${prefix}-modal">${text('common.cancel')}</button></div>`,
  });
}

const reference = (entity, actor = null) => entity ? { id: entity.id, mutation: entity.client_mutation_id,
  actor: entity.created_by_user_id ?? entity.user_id
    ?? (entity.is_pending && String(entity.id).startsWith('temp-') ? actor : null) } : null;
function resolveReference(values, ref) {
  if (!ref) return null;
  const exact = values.find(value => sameEntityId(value.id, ref.id));
  if (exact) return exact;
  if (!String(ref.id).startsWith('temp-') || ref.mutation == null || ref.actor == null) return null;
  return values.find(value => sameEntityId(value.client_mutation_id, ref.mutation)
    && sameEntityId(value.created_by_user_id ?? value.user_id, ref.actor)) || null;
}
const ingredientsOf = recipe => (recipe?.ingredient_groups || []).flatMap(group => group.ingredients || []);
const fingerprint = recipe => JSON.stringify([recipe.revision, recipe.pending, recipe.conflict,
  recipe.title, recipe.base_servings, (recipe.ingredient_groups || []).map(group => [group.client_key, group.name,
    (group.ingredients || []).map(item => [item.client_key, item.name, item.quantity_value, item.quantity_unit, item.quantity_text, item.note])])]);

export function createRecipeShoppingTransferFeature({ getCookbooks = () => [], getLists = () => [], getStores = () => [],
  getSessionIdentity = () => null, getCurrentUser = () => null, canUseShopping = () => true,
  transfer, readPendingTransfers = async () => [], cancelTransfer = async () => false,
  onQueued = () => {}, onError = console.error, root = globalThis.document } = {}) {
  const el = name => root.getElementById(`${prefix}-${name}`);
  let source = null, sourceRef = null, bookRef = null, initialFingerprint = '', session, actor;
  let generation = 0, pendingRead = 0, busy = null, bound = false, sourceChanged = false, pendingReady = false;
  let listRef = null, defaultSection = null, defaultStore = null, pending = [], errorKey = '';
  const captureReference = entity => reference(entity, actor);
  const selected = new Set(), overrides = new Map();
  const separated = new Set();
  let previewHtml = null, preview = { families: [], mergeGroups: new Map() };
  const selectOptions = new WeakMap(), selectDisabled = new WeakMap();
  let pendingHtml = null;
  const active = () => el('modal')?.classList.contains('active');
  const sessionCurrent = () => session != null && actor != null && getSessionIdentity() === session && sameEntityId(getCurrentUser()?.id, actor);
  const currentSource = () => {
    const book = resolveReference(getCookbooks(), bookRef);
    return book ? resolveReference(book.recipes || [], sourceRef) : null;
  };
  const editableLists = () => getLists().filter(list => list.can_edit === true || list.can_edit === 1);
  const currentList = () => resolveReference(editableLists(), listRef);
  const sections = () => currentList()?.sections || [];
  const stores = () => getStores().filter(store => store.active !== false && sameEntityId(store.shopping_list_id, currentList()?.id));
  const fieldValue = (ref, values) => ref == null ? null : resolveReference(values, ref)?.id;
  function sourceSelections({ all = false } = {}) {
    return ingredientsOf(source).filter(item => all || selected.has(item.client_key)).map(item => {
      const override = overrides.get(item.client_key) || {};
      const section_id = fieldValue(override.section === undefined ? defaultSection : override.section, sections());
      const store = fieldValue(override.store === undefined ? defaultStore : override.store, stores());
      return { ingredient_client_key: item.client_key, section_id, store_ids: store === null ? [] : [store] };
    });
  }
  function draft() {
    const recipe = currentSource(), list = currentList(), servings = Number(el('servings')?.value);
    if (!recipe || !list || !Number.isFinite(servings) || servings <= 0 || servings > 100000 || !selected.size) return null;
    const ingredients = sourceSelections();
    if (ingredients.some(item => item.section_id === undefined || item.store_ids.includes(undefined))) return null;
    const { mergeGroups } = buildRecipeShoppingPreview(source, ingredients, { servings, separated });
    return { recipeId: recipe.id, shoppingListId: list.id, servings,
      ingredients: ingredients.map(row => mergeGroups.has(row.ingredient_client_key) ? { ...row, merge_group: mergeGroups.get(row.ingredient_client_key) } : row) };
  }
  function renderPreview() {
    const previousPreview = preview;
    const servings = Number(el('servings').value), allSelections = sourceSelections({ all: true });
    preview = buildRecipeShoppingPreview(source, allSelections, { servings, separated });
    const checkbox = (keys, id, content) => `<label for="${id}" class="recipe-transfer-ingredient"><span class="ui-checkbox-label ui-checkbox-round"><input type="checkbox" id="${id}" ${keys.length === 1 ? `data-transfer-ingredient="${escapeHtmlAttr(keys[0])}"` : `data-transfer-keys="${escapeHtmlAttr(JSON.stringify(keys))}"`} ${keys.every(key => selected.has(key)) ? 'checked' : ''}><span class="ui-checkbox-box" aria-hidden="true">${iconSvg('check')}</span></span>${content}</label>`;
    const targets = (keys, id) => `<details class="recipe-transfer-corrections" data-key="${escapeHtmlAttr(keys[0])}" data-transfer-target-keys="${escapeHtmlAttr(JSON.stringify(keys))}" data-transfer-details="${escapeHtmlAttr(JSON.stringify(['target', ...keys]))}"><summary>${text('recipe.transfer.customize')}</summary><div class="recipe-transfer-targets"><div class="form-group"><label for="${id}-section">${text('common.section')}</label><select class="ui-field" id="${id}-section" data-target="section"></select></div><div class="form-group"><label for="${id}-store">${text('shopping.item.store')}</label><select class="ui-field" id="${id}-store" data-target="store"></select></div></div></details>`;
    const html = preview.families.map((family, index) => `<section class="recipe-transfer-product" data-transfer-product="${index}">${family.groups.map((group, position) => {
      const keys = group.sourceKeys, id = `${prefix}-ingredient-${index}-${position}`;
      const selections = allSelections.filter(row => keys.includes(row.ingredient_client_key) && selected.has(row.ingredient_client_key));
      const selectedGroup = buildRecipeShoppingPreview(source, selections, { servings, separated }).families[0]?.groups[0];
      const total = selectedGroup || group, amount = total.quantityText || formatQuantity(total.amount, total.unit, getActiveLocale(), { kitchen: true });
      const section = sections().find(section => sameEntityId(section.id, group.sectionId));
      const destinations = [section?.name, ...group.storeIds.map(id => stores().find(store => sameEntityId(store.id, id))?.name)].filter(Boolean);
      const single = keys.length === 1, notes = total.notes;
      const content = `<span class="recipe-transfer-copy"><span class="recipe-transfer-summary-title"><strong>${escapeHtmlAttr(group.name)}</strong><span class="ui-badge recipe-transfer-summary-amount" ${single ? `data-transfer-amount="${escapeHtmlAttr(keys[0])}"` : ''}>${escapeHtmlAttr(amount)}</span></span>${single ? notes.map(note => `<small>${escapeHtmlAttr(note)}</small>`).join('') : ''}${destinations.length ? `<small>${escapeHtmlAttr(destinations.join(' · '))}</small>` : ''}</span>`;
      return `<div class="recipe-transfer-row recipe-transfer-summary-row${selections.length ? '' : ' is-unselected'}" ${single ? `data-key="${escapeHtmlAttr(keys[0])}"` : ''}>${checkbox(keys, id, content)}${single ? targets(keys, id) : `<details class="recipe-transfer-sources" data-transfer-details="${escapeHtmlAttr(JSON.stringify(['sources', ...keys]))}"><summary>${text('recipe.transfer.sources')} <span class="recipe-transfer-source-count">${escapeHtmlAttr(t('recipe.transfer.sourceCount', { count: keys.length }))}</span></summary><div class="recipe-transfer-source-rows">${keys.map((key, sourceIndex) => {
        const sourceGroup = source.ingredient_groups.find(group => group.ingredients.some(item => item.client_key === key));
        const item = sourceGroup.ingredients.find(item => item.client_key === key), sourceId = `${id}-source-${sourceIndex}`;
        return `<div class="recipe-transfer-source-row" data-key="${escapeHtmlAttr(key)}">${checkbox([key], sourceId, `<span class="recipe-transfer-copy"><strong>${escapeHtmlAttr(sourceGroup.name || item.name)}</strong><span>${escapeHtmlAttr(ingredientAmount(item, servings, source.base_servings))}</span>${item.note ? `<small>${escapeHtmlAttr(item.note)}</small>` : ''}</span>`)}</div>`;
      }).join('')}</div>${targets(keys, id)}</details>`}</div>`;
    }).join('')}${family.canCombine ? `<div class="recipe-transfer-combine"><button type="button" class="btn btn-secondary" ${family.combined ? 'data-transfer-separate' : 'data-transfer-combine'}="${index}">${text(family.combined ? 'recipe.transfer.keepSeparate' : 'recipe.transfer.combine')}</button></div>` : ''}</section>`).join('') || `<p class="recipe-transfer-preview-empty">${text('recipe.transfer.empty')}</p>`;
    if (html !== previewHtml) {
      const opened = new Set([...el('ingredients').querySelectorAll('details[open]')].map(node => node.dataset.transferDetails));
      const openDropdown = el('ingredients').querySelector('.ui-select.is-open');
      const focused = el('ingredients').contains(root.activeElement) ? root.activeElement : openDropdown?.querySelector('.ui-select-trigger');
      const focusedSelect = root.getElementById(focused?.closest('.ui-select')?.dataset.selectId || '');
      const focus = focused && { key: focused.dataset.transferIngredient, keys: focused.dataset.transferKeys,
        target: focused.dataset.target || focusedSelect?.dataset.target, source: focused.closest('.recipe-transfer-corrections')?.dataset.key,
        details: focused.closest('details')?.dataset.transferDetails,
        family: focused.matches('[data-transfer-combine],[data-transfer-separate]') && previousPreview.families[Number(focused.closest('[data-transfer-product]').dataset.transferProduct)]?.id };
      if (openDropdown) closeOpenDropdown('recipe-transfer-render');
      previewHtml = html; el('ingredients').innerHTML = html;
      for (const details of el('ingredients').querySelectorAll('details')) details.open = opened.has(details.dataset.transferDetails);
      for (const details of el('ingredients').querySelectorAll('.recipe-transfer-corrections[open]')) populateRow(details);
      if (focus) {
        const field = [...el('ingredients').querySelectorAll('input,select,button,summary')].find(node =>
          focus.key ? node.dataset.transferIngredient === focus.key : focus.keys ? node.dataset.transferKeys === focus.keys : focus.target ? node.dataset.target === focus.target && JSON.parse(node.closest('details')?.dataset.transferTargetKeys || '[]').includes(focus.source) : focused.tagName === 'SUMMARY' ? node.tagName === 'SUMMARY' && node.closest('details')?.dataset.transferDetails === focus.details : focus.family && node.matches('[data-transfer-combine],[data-transfer-separate]') && preview.families[Number(node.closest('[data-transfer-product]').dataset.transferProduct)]?.id === focus.family);
        // Hydrated selects expose their trigger, not the hidden native select.
        (field?.matches('select') ? hydrateSelect(field).trigger : field)?.focus({ preventScroll: true });
      }
    }
    for (const checkbox of el('ingredients').querySelectorAll('[data-transfer-keys]')) {
      const keys = JSON.parse(checkbox.dataset.transferKeys);
      checkbox.indeterminate = keys.some(key => selected.has(key)) && !keys.every(key => selected.has(key));
    }
  }
  function setOptions(select, values, selectedRef, emptyKey, { inherit = false } = {}) {
    const choices = [];
    if (inherit) choices.push([t('recipe.transfer.useDefaults'), '__default__', false]);
    choices.push([t(emptyKey), '', false]);
    for (const value of values) choices.push([value.name || '', String(value.id), false]);
    const value = selectedRef === undefined && inherit ? '__default__' : selectedRef == null ? '' : resolveReference(values, selectedRef)?.id;
    if (value === undefined) choices.push([t('recipe.transfer.targetInvalid'), '__invalid__', true]);
    const desiredValue = value === undefined ? '__invalid__' : String(value);
    const signature = JSON.stringify([choices, values.length > 8]);
    if (selectOptions.get(select) === signature && select.value === desiredValue) return;
    selectOptions.set(select, signature);
    select.replaceChildren(...choices.map(([label, value, disabled]) => { const option = new Option(label, value); option.disabled = disabled; return option; }));
    select.value = desiredValue;
    hydrateSelect(select, { searchable: values.length > 8 });
    selectDisabled.set(select, select.disabled);
  }
  function populateTargets() {
    setOptions(el('list'), editableLists(), listRef, 'recipe.transfer.chooseList');
    setOptions(el('section'), sections(), defaultSection, 'shopping.section.unsorted');
    setOptions(el('store'), stores(), defaultStore, 'shopping.item.store.none');
    for (const details of el('ingredients').querySelectorAll('.recipe-transfer-corrections[open]')) populateRow(details);
  }
  function populateRow(details) {
    const override = overrides.get(details.dataset.key) || {};
    setOptions(details.querySelector('[data-target="section"]'), sections(), override.section, 'shopping.section.unsorted', { inherit: true });
    setOptions(details.querySelector('[data-target="store"]'), stores(), override.store, 'shopping.item.store.none', { inherit: true });
  }
  function refresh() {
    if (!el('form')) return;
    renderPreview();
    const allowed = active() && sessionCurrent() && canUseShopping() && !sourceChanged && !busy && pendingReady && !pending.length;
    el('form').setAttribute('aria-busy', String(Boolean(busy || (!pendingReady && !errorKey))));
    for (const input of el('form').querySelectorAll('input,select,button:not([data-cancel-transfer])')) input.disabled = !allowed;
    el('section').disabled = el('store').disabled = !allowed || !currentList();
    for (const select of el('ingredients').querySelectorAll('select')) select.disabled = !allowed || !currentList();
    refreshServingsControl(el('servings'));
    for (const select of el('form').querySelectorAll('select')) {
      if (selectDisabled.get(select) !== select.disabled) refreshSelect(select);
      selectDisabled.set(select, select.disabled);
    }
    el('select-all').textContent = t(selected.size === ingredientsOf(source).length ? 'recipe.transfer.selectNone' : 'recipe.transfer.selectAll');
    el('select-all').hidden = !ingredientsOf(source).length;
    for (const button of el('pending').querySelectorAll('button')) button.disabled = Boolean(busy) || !sessionCurrent();
    const servings = Number(el('servings').value);
    const invalidTargets = currentList() && selected.size && servings > 0 && servings <= 100000 && !draft();
    el('status').textContent = busy ? t('recipe.transfer.submitting') : sourceChanged ? t('recipe.transfer.sourceChanged')
      : !pendingReady ? t(errorKey || 'common.loading') : !editableLists().length ? t('recipe.transfer.noLists') : errorKey ? t(errorKey)
        : invalidTargets ? t('recipe.transfer.targetInvalid') : !ingredientsOf(source).length ? t('recipe.transfer.empty') : '';
    modal.refreshSaveState();
  }
  const modal = createEntityEditorModalController({ prefix, document: root, requireChanges: false,
    readState: draft, isValid: state => Boolean(state), canSubmit: () => active() && sessionCurrent() && canUseShopping() && !busy && !sourceChanged && pendingReady && !pending.length,
    resolveView: () => ({ mode: 'action', titleKey: 'recipe.transfer.title', canDelete: false,
      restoreFocus: () => root.querySelector('[data-recipe-action="transfer"]') }),
    renderDomain: () => {}, onSubmit: submit, onError,
  });
  function renderPending() {
    const html = pending.map((entry, index) => `<div class="recipe-transfer-pending-row"><p>${text(entry.status === 'blocked' ? 'recipe.transfer.blocked' : 'recipe.transfer.pending')}</p>${entry.can_cancel ? `<button type="button" class="btn btn-secondary" data-cancel-transfer="${index}">${text(entry.status === 'blocked' ? 'recipe.transfer.removePending' : 'common.cancel')}</button>` : ''}</div>`).join('');
    if (pendingHtml !== html) { pendingHtml = html; el('pending').innerHTML = html; }
  }
  async function loadPending() {
    const requested = ++pendingRead, captured = generation;
    const initial = !pendingReady;
    if (initial) refresh();
    try {
      const entries = await readPendingTransfers();
      if (captured !== generation || requested !== pendingRead || !sessionCurrent() || !active()) return;
      const recipe = currentSource();
      pending = entries.filter(entry => sameEntityId(entry.recipe_id, recipe?.id) || sameEntityId(entry.recipe_id, sourceRef?.id));
      pendingReady = true; renderPending(); refresh();
      if (initial && !el('modal').contains(root.activeElement)) (el('list').disabled
        ? el('pending').querySelector('button:not(:disabled)') || el('modal').querySelector('.modal-close-x') : el('list')).focus();
    } catch (error) {
      if (captured === generation && requested === pendingRead && sessionCurrent() && active()) { errorKey = 'recipe.transfer.failed'; refresh(); onError(error); }
    }
  }
  function show(recipe, { servings = recipe.base_servings } = {}) {
    const book = getCookbooks().find(book => (book.recipes || []).some(item => sameEntityId(item.id, recipe.id)));
    if (!book || !canUseShopping() || getCurrentUser()?.id == null || getSessionIdentity() == null) return false;
    generation++; pendingRead++; busy = null; session = getSessionIdentity(); actor = getCurrentUser().id;
    source = structuredClone(recipe); sourceRef = captureReference(recipe); bookRef = captureReference(book); initialFingerprint = fingerprint(recipe);
    sourceChanged = false; pendingReady = false; pending = []; errorKey = ''; overrides.clear(); selected.clear(); separated.clear();
    for (const item of ingredientsOf(source)) selected.add(item.client_key);
    listRef = editableLists().length === 1 ? captureReference(editableLists()[0]) : null; defaultSection = defaultStore = null;
    modal.open(); el('recipe').textContent = recipe.title; el('servings').value = Number(servings) > 0 ? servings : recipe.base_servings;
    el('defaults')?.removeAttribute('open');
    previewHtml = null; el('ingredients').replaceChildren();
    populateTargets(); renderPending(); refresh(); void loadPending();
    el('list').focus(); return true;
  }
  function deactivate() {
    generation++; pendingRead++; busy = null; closeOwnedDropdown();
    if (!closeUiLayerNow(`${prefix}-modal`)) modal.close({ fromHistory: true });
  }
  function closeOwnedDropdown() {
    if (el('form')?.querySelector('.ui-select.is-open')) closeOpenDropdown('recipe-transfer-close');
  }
  function reconcile() {
    if (!active()) return;
    if (!sessionCurrent() || !canUseShopping() || !currentSource()) { deactivate(); return; }
    sourceChanged ||= fingerprint(currentSource()) !== initialFingerprint;
    if (listRef && !currentList()) { listRef = null; defaultSection = defaultStore = null; overrides.clear(); separated.clear(); }
    populateTargets(); refresh(); void loadPending();
  }
  async function submit(event) {
    event?.preventDefault?.();
    reconcileSource(); const payload = draft();
    if (!modal.canSave() || !payload || !el('form').reportValidity()) return;
    const captured = generation, token = {}; busy = token; errorKey = ''; refresh();
    const isCurrent = () => captured === generation && sessionCurrent() && active() && canUseShopping()
      && fingerprint(currentSource() || {}) === initialFingerprint && Boolean(draft());
    try {
      const result = await transfer(payload, { isCurrent });
      if (!isCurrent()) return;
      if (!result) throw new Error('Transfer was not queued');
      if (result.status === 'blocked') { await loadPending(); return; }
      generation++; closeOwnedDropdown();
      modal.close({ afterClose: () => { if (sessionCurrent()) onQueued(result); } });
    } catch (error) { if (isCurrent()) { errorKey = 'recipe.transfer.failed'; onError(error); } }
    finally { if (busy === token) { busy = null; if (captured === generation && active()) refresh(); } }
  }
  function reconcileSource() { sourceChanged ||= !currentSource() || fingerprint(currentSource()) !== initialFingerprint; refresh(); }
  function bind() {
    if (bound) return; bound = true; modal.bind();
    el('servings').addEventListener('input', refresh);
    el('form').addEventListener('click', event => {
      const combine = event.target.closest('[data-transfer-combine],[data-transfer-separate]');
      if (combine && !combine.disabled && !busy && sessionCurrent()) {
        const merge = combine.hasAttribute('data-transfer-combine');
        const family = preview.families[Number(combine.getAttribute(merge ? 'data-transfer-combine' : 'data-transfer-separate'))];
        if (family?.canCombine) { if (merge) separated.delete(family.id); else separated.add(family.id); refresh(); }
        return;
      }
      const button = event.target.closest('[data-servings-step]');
      if (!button || button.disabled || el('servings').disabled) return;
      const next = stepServings(el('servings').value, Number(button.dataset.servingsStep));
      if (next == null) return;
      el('servings').value = String(next); refresh();
    });
    el('list').addEventListener('change', () => {
      if (busy) return;
      listRef = captureReference(editableLists().find(list => sameEntityId(list.id, el('list').value)));
      defaultSection = defaultStore = null; overrides.clear(); separated.clear(); errorKey = ''; populateTargets(); refresh();
    });
    el('form').addEventListener('change', event => {
      if (busy || !sessionCurrent()) return;
      const target = event.target;
      const changedTarget = target.matches('[data-target]') ? { key: target.closest('details').dataset.key, field: target.dataset.target } : null;
      if (target.matches('[data-target]') || target === el('section') || target === el('store')) separated.clear();
      if (target.matches('[data-transfer-ingredient],[data-transfer-keys]')) {
        const keys = target.dataset.transferKeys ? JSON.parse(target.dataset.transferKeys) : [target.dataset.transferIngredient];
        for (const key of keys) { if (target.checked) selected.add(key); else selected.delete(key); }
      }
      if (target === el('section')) defaultSection = captureReference(sections().find(section => sameEntityId(section.id, target.value)));
      if (target === el('store')) defaultStore = captureReference(stores().find(store => sameEntityId(store.id, target.value)));
      if (target.matches('[data-target]') && target.value !== '__invalid__') {
        const keys = JSON.parse(target.closest('details').dataset.transferTargetKeys), field = target.dataset.target;
        const value = target.value === '__default__' ? undefined : captureReference((field === 'section' ? sections() : stores()).find(item => sameEntityId(item.id, target.value)));
        for (const key of keys) overrides.set(key, { ...(overrides.get(key) || {}), [field]: value });
      }
      refresh();
      if (changedTarget) {
        const details = [...el('ingredients').querySelectorAll('.recipe-transfer-corrections')].find(node => JSON.parse(node.dataset.transferTargetKeys).includes(changedTarget.key));
        if (details) {
          // Changing a route may split/regroup this source into another product.
          for (let node = details; node && node !== el('ingredients'); node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
          populateRow(details);
          const select = details.querySelector(`[data-target="${changedTarget.field}"]`);
          if (select) hydrateSelect(select).trigger.focus({ preventScroll: true });
        }
      }
    });
    el('select-all').addEventListener('click', () => {
      if (busy || !sessionCurrent()) return;
      if (selected.size === ingredientsOf(source).length) selected.clear(); else for (const item of ingredientsOf(source)) selected.add(item.client_key);
      refresh();
    });
    el('ingredients').addEventListener('toggle', event => { if (event.target.matches('.recipe-transfer-corrections[open]')) { populateRow(event.target); refresh(); } }, true);
    el('pending').addEventListener('click', async event => {
      const button = event.target.closest('[data-cancel-transfer]'), entry = button && pending[Number(button.dataset.cancelTransfer)];
      if (!entry?.can_cancel || busy || !sessionCurrent()) return;
      const captured = generation, token = {}; busy = token; errorKey = ''; refresh();
      try { if (!await cancelTransfer(entry.client_mutation_id)) throw new Error('Transfer was not canceled'); }
      catch (error) { if (captured === generation && sessionCurrent()) { errorKey = 'recipe.transfer.failed'; onError(error); } }
      finally { if (busy === token) { busy = null; if (captured === generation && sessionCurrent() && active()) void loadPending(); } }
    });
    root.defaultView?.addEventListener('nia-language-change', () => { if (active()) { translatePage(el('modal')); populateTargets(); renderPending(); refresh(); } });
  }
  return { bind, show, reconcile, deactivate, getDraft: draft };
}
