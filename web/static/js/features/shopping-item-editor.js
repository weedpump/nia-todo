import { normalizeQuantityUnit, formatQuantityUnit } from '../core/quantity-units.js';
import { t, translatePage, getActiveLocale } from '../i18n/index.js';
import { parseShoppingQuickAdd } from './shopping-quick-add.js';
import { createMultiAddFeature } from './multi-add.js';
import { renderQuickAddPreview, createQuickAddPreviewController } from './quick-add.js';
import { hydrateSelect, refreshSelect, isDropdownOpen } from '../ui/dropdowns.js';
import { shouldAutoFocusEntityEditorTitle } from './entity-editor-focus.js';
import { createFormSaveState } from './form-save-state.js';
import { bindShoppingStoreCreator } from './shopping-store-creator.js';
import { shoppingStoreOptionAction } from './shopping-store-option-action.js';
import { openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

export function resolveShoppingQuickAddState(state, parsed) {
  if (!parsed) return { ...state, unit: normalizeQuantityUnit(state.unit) || '' };
  const changes = parsed.changes || {};
  return {
    ...state,
    name: parsed.title,
    quantity: state.quantity !== '' && state.quantity != null ? state.quantity : (changes.quantity_value ?? ''),
    unit: normalizeQuantityUnit(state.unit || changes.quantity_unit) || '',
    sectionId: state.sectionId ?? changes.section_id ?? null,
    storeId: state.storeId ?? changes.store_ids?.[0] ?? null,
  };
}

export function resolveShoppingBulkQuickAddState(parsed, defaults = {}) {
  return resolveShoppingQuickAddState({ name: '', quantity: '', unit: '', sectionId: null, storeId: null }, {
    ...parsed,
    changes: {
      section_id: defaults.sectionId ?? null,
      store_ids: defaults.storeId != null ? [defaults.storeId] : [],
      ...parsed.changes,
    },
  });
}

export function createShoppingItemEditorFeature({
  document: doc = globalThis.document,
  eventTarget = globalThis.window,
  getLists = () => [],
  getActiveListId = () => null,
  getStores = () => [],
  storeController,
  itemController,
  routingMemory = null,
  confirmDanger = async () => false,
  onStoreEdit = () => {},
  showToast = () => {},
  onError = console.error,
} = {}) {
  let bound = false;
  let saveState = null;
  let submitting = false;
  let storeCreator = null;
  let bulkStoreCreator = null;
  let bulk = null;
  let restoreFocus = null;
  let mode = 'create';
  let editingListIdentity = null;
  let editingItemIdentity = null;
  let editorGeneration = 0;
  let bulkSubmissionScope = null;
  let quickAddController = null;
  let quickAddInput = null;
  let memoryReady = Promise.resolve();
  let memoryRenderPending = false;
  const routingTouched = new Set(), bulkRoutingTouched = new Set();

  function activeList() {
    const id = getActiveListId();
    return getLists().find(list => sameId(list.id, id)) || null;
  }

  function canMutate() {
    return activeList()?.can_edit === true;
  }

  function canMutateList(context) {
    return getLists().find(list => (
      sameId(list.id, context?.id)
      || sameId(list.client_mutation_id, context?.id)
      || sameId(list.id, context?.client_mutation_id)
      || sameId(list.client_mutation_id, context?.client_mutation_id)
    ))?.can_edit === true;
  }

  function resolveEditingItem() {
    const list = activeList();
    if (!list || editingListIdentity == null || editingItemIdentity == null) return null;
    if (!sameId(list.id, editingListIdentity) && !sameId(list.client_mutation_id, editingListIdentity)) return null;
    return (list.items || []).find(item => (
      sameId(item.id, editingItemIdentity)
      || sameId(item.client_mutation_id, editingItemIdentity)
    )) || null;
  }

  function trigger() {
    return doc?.querySelector?.('[data-shopping-item-action="open-create"]') || null;
  }

  function editTrigger(identity = editingItemIdentity) {
    const list = activeList();
    const item = (list?.items || []).find(candidate => (
      sameId(candidate.id, identity)
      || sameId(candidate.client_mutation_id, identity)
    ));
    const currentIdentity = item?.id ?? identity;
    return Array.from(doc?.querySelectorAll?.('[data-shopping-item-action="open-edit"]') || [])
      .find(element => sameId(element.dataset.shoppingItemId, currentIdentity)) || null;
  }

  function setMode(nextMode) {
    mode = nextMode === 'edit' ? 'edit' : 'create';
    const title = doc?.getElementById?.('shopping-item-modal-title');
    const menu = doc?.getElementById?.('shopping-item-detail-menu-toggle');
    if (title) {
      const key = mode === 'edit' ? 'shopping.item.modal.editTitle' : 'shopping.item.modal.title';
      title.dataset.i18nKey = key;
      title.textContent = t(key);
    }
    if (menu) {
      menu.hidden = mode !== 'edit';
      menu.removeAttribute('open');
    }
  }

  function modal() {
    return doc?.getElementById?.('shopping-item-modal') || null;
  }

  function form() {
    return doc?.getElementById?.('shopping-item-form') || null;
  }

  function setError(key = '') {
    const target = doc?.getElementById?.('shopping-item-error');
    if (target) target.textContent = key ? t(key) : '';
  }


  function setInvalid(element, invalid) {
    if (!element) return;
    if (invalid) element.setAttribute('aria-invalid', 'true');
    else element.removeAttribute('aria-invalid');
  }

  function appendOption(select, value, label) {
    const option = doc.createElement('option');
    option.value = value == null ? '' : String(value);
    option.textContent = label;
    select.appendChild(option);
  }

  function populateSections(selected = '', selectId = 'shopping-item-section') {
    const select = doc?.getElementById?.(selectId);
    if (!select) return;
    const list = activeList();
    select.innerHTML = '';
    appendOption(select, '', t('shopping.section.unsorted'));
    for (const section of [...(list?.sections || [])].sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0))) {
      appendOption(select, section.id, section.name || '');
    }
    const match = (list?.sections || []).find(section => sameId(section.id, selected) || sameId(section.client_mutation_id, selected));
    select.value = match == null ? '' : String(match.id);
    hydrateSelect(select);
    refreshSelect(select);
  }


  function populateStores(selected = '', selectId = 'shopping-item-store') {
    const select = doc?.getElementById?.(selectId);
    if (!select) return;
    const list = activeList();
    const stores = getStores().filter(store => (
      store?.active !== false
      && (sameId(store.shopping_list_id, list?.id) || sameId(store.shopping_list_id, list?.client_mutation_id))
    ));
    select.innerHTML = '';
    appendOption(select, '', t('shopping.item.store.none'));
    for (const store of [...stores].sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0))) {
      appendOption(select, store.id, store.name || '');
    }
    const match = stores.find(store => sameId(store.id, selected) || sameId(store.client_mutation_id, selected));
    select.value = match == null ? '' : String(match.id);
    hydrateSelect(select, {
      searchable: true,
      searchPlaceholder: t('shopping.item.store.search'),
      searchLabel: t('shopping.item.store.search'),
      emptyText: t('shopping.item.store.empty'),
      optionAction: option => shoppingStoreOptionAction({
        list,
        stores,
        option,
        onEdit: onStoreEdit,
      }),
      action: canMutate() ? {
        label: t('shopping.item.store.add'),
        ariaLabel: t('shopping.item.store.add'),
        icon: 'plus',
        onActivate: () => (selectId === 'shopping-item-multi-store' ? bulkStoreCreator : storeCreator)?.show?.(),
      } : null,
    });
    refreshSelect(select);
  }

  function readFormState() {
    return {
      name: doc?.getElementById?.('shopping-item-name')?.value?.trim?.() || '',
      quantity: doc?.getElementById?.('shopping-item-quantity')?.value ?? '',
      unit: doc?.getElementById?.('shopping-item-unit')?.value?.trim?.() || '',
      quantity_text: doc?.getElementById?.('shopping-item-quantity-text')?.value?.trim?.() || '',
      note: doc?.getElementById?.('shopping-item-note')?.value?.trim?.() || '',
      sectionId: doc?.getElementById?.('shopping-item-section')?.value || null,
      storeId: doc?.getElementById?.('shopping-item-store')?.value || null,
    };
  }

  function quickAddResult(raw = readFormState().name) {
    if (mode !== 'create') return null;
    return parseShoppingQuickAdd(raw, { list: activeList(), stores: getStores(), locale: getActiveLocale(), t });
  }

  function effectiveState(raw, parsed, defaults = null) {
    const state = defaults ? resolveShoppingBulkQuickAddState(parsed, defaults) : resolveShoppingQuickAddState(raw, parsed);
    if (!routingMemory) return state;
    if (mode === 'edit') {
      state.store_ids = routingTouched.has('stores') ? (raw.storeId == null ? [] : [raw.storeId]) : [...(resolveEditingItem()?.store_ids || [])];
      return state;
    }
    const changes = parsed?.changes || {}, touched = defaults ? bulkRoutingTouched : routingTouched;
    const remembered = routingMemory.suggest(state.name, activeList()?.id);
    const sectionExplicit = touched.has('section') || Object.hasOwn(changes, 'section_id');
    const storesExplicit = touched.has('stores') || Object.hasOwn(changes, 'store_ids');
    if (!defaults && touched.has('section')) state.sectionId = raw.sectionId;
    else if (Object.hasOwn(changes, 'section_id')) state.sectionId = changes.section_id;
    else if (defaults && touched.has('section')) state.sectionId = defaults.sectionId;
    else state.sectionId = remembered?.section_known ? remembered.section_id : null;
    if (!defaults && touched.has('stores')) state.store_ids = raw.storeId == null ? [] : [raw.storeId];
    else if (Object.hasOwn(changes, 'store_ids')) state.store_ids = [...changes.store_ids];
    else if (defaults && touched.has('stores')) state.store_ids = defaults.storeId == null ? [] : [defaults.storeId];
    else state.store_ids = remembered?.stores_known ? [...remembered.store_ids] : [];
    state.storeId = state.store_ids[0] ?? null;
    state.routing_fields = ['list', ...(sectionExplicit ? ['section'] : []), ...(storesExplicit ? ['stores'] : [])];
    return state;
  }

  function readState() {
    const raw = readFormState();
    return effectiveState(raw, quickAddResult(raw.name));
  }

  function withRoutingFeedback(state, source = routingMemory) {
    if (!source) return state;
    const { routing_fields = [], ...fields } = state;
    const feedback = source.feedback(routing_fields);
    return { ...fields, ...(feedback ? { routing_feedback: feedback } : {}) };
  }

  function routingPreview(result, state) {
    if (!routingMemory || !result) return result;
    const fields = new Set(state.routing_fields || []), matches = [...(result.matches || [])];
    const route = routingMemory.suggest(state.name, activeList()?.id);
    const storeNames = (state.store_ids || []).map(id => getStores().find(store => sameId(store.id, id))?.name).filter(Boolean);
    if (!fields.has('section') && route?.section_known) matches.push({ type: 'section', label: t('common.section'), value: (activeList()?.sections || []).find(section => sameId(section.id, state.sectionId))?.name || t('shopping.section.unsorted'), source: (route.memory_fields?.includes('section') ?? true) ? 'memory' : undefined });
    if (!fields.has('stores') && route?.stores_known) matches.push({ type: 'store', label: t('shopping.item.store'), value: storeNames.join(', ') || t('shopping.item.store.none'), source: (route.memory_fields?.includes('stores') ?? true) ? 'memory' : undefined });
    return { ...result, matches };
  }

  function renderEffectiveQuickAdd(result) {
    const target = doc?.getElementById?.('shopping-item-quick-add-preview');
    if (!result || !readFormState().name) {
      if (routingMemory && mode === 'create') for (const [field, id] of [['section', 'shopping-item-section'], ['stores', 'shopping-item-store']]) {
        const select = doc.getElementById(id);
        if (!routingTouched.has(field) && select?.value) { select.value = ''; refreshSelect(select); }
      }
      renderQuickAddPreview(target, null, t);
      return;
    }
    const state = effectiveState(readFormState(), result);
    if (routingMemory) {
      for (const [id, value] of [['shopping-item-section', state.sectionId], ['shopping-item-store', state.storeId]]) {
        const select = doc.getElementById(id), next = value == null ? '' : String(value);
        if (select && select.value !== next) { select.value = next; refreshSelect(select); }
      }
      result = routingPreview(result, state);
      ensureSaveState()?.refresh?.();
    }
    const list = activeList();
    const values = {
      quantity: state.quantity === '' ? '' : new Intl.NumberFormat(getActiveLocale(), { maximumFractionDigits: 20 }).format(Number(state.quantity)),
      unit: formatQuantityUnit(state.unit, getActiveLocale()),
      section: (list?.sections || []).find(section => sameId(section.id, state.sectionId))?.name || (routingMemory ? t('shopping.section.unsorted') : undefined),
      store: (state.store_ids || [state.storeId]).map(id => getStores().find(store => sameId(store.id, id))?.name).filter(Boolean).join(', ') || (routingMemory ? t('shopping.item.store.none') : undefined),
    };
    renderQuickAddPreview(target, {
      ...result,
      matches: result.matches.map(match => ({ ...match, value: values[match.type] ?? match.value })),
    }, t);
    setInvalid(doc?.getElementById?.('shopping-item-name'), result.errors.length > 0);
  }

  function ensureQuickAdd() {
    const input = doc?.getElementById?.('shopping-item-name');
    if (!input) return;
    if (quickAddInput !== input) {
      quickAddController?.destroy();
      quickAddInput = input;
      quickAddController = createQuickAddPreviewController({
        input,
        getContext: () => JSON.stringify([editorGeneration, getActiveListId(), getActiveLocale(), readFormState(), activeList()?.sections, getStores()]),
        isActive: () => mode === 'create' && !bulk?.isActive() && modal()?.classList.contains('active') && canMutate(),
        parse: quickAddResult,
        render: renderEffectiveQuickAdd,
        onError,
      });
    }
    quickAddController.invalidate();
    const hint = doc?.getElementById?.('shopping-item-quick-add-hint');
    if (hint) hint.hidden = mode !== 'create';
    if (mode === 'create') void quickAddController.refresh();
    else renderEffectiveQuickAdd(null);
  }

  function handleFormChange(event) {
    if (event.target?.closest?.('#shopping-item-form') == null || !modal()?.classList.contains('active')) return;
    const routeField = event.target.id === 'shopping-item-section' || event.target.id === 'shopping-item-multi-section' ? 'section'
      : event.target.id === 'shopping-item-store' || event.target.id === 'shopping-item-multi-store' ? 'stores' : null;
    if (routingMemory && routeField) (event.target.id.includes('-multi-') ? bulkRoutingTouched : routingTouched).add(routeField);
    if (event.type === 'change' && event.target.id === 'shopping-item-unit') {
      event.target.value = formatQuantityUnit(event.target.value, getActiveLocale());
    }
    if (event.target !== quickAddInput) void quickAddController?.refresh();
    setError();
  }

  function validState(state) {
    if (!state.name || state.name.length > 500 || state.unit.length > 40 || (state.quantity_text || '').length > 500 || (state.note || '').length > 2000) return false;
    if (state.quantity_text && state.quantity !== '') return false;
    if (state.quantity === '') return true;
    const quantity = Number(state.quantity);
    return Number.isFinite(quantity) && quantity >= 0;
  }

  function ensureSaveState() {
    const currentForm = form();
    const button = doc?.getElementById?.('shopping-item-save-btn');
    if (!currentForm || !button) return null;
    if (!saveState || saveState.form !== currentForm) {
      saveState?.destroy?.();
      saveState = createFormSaveState({
        form: currentForm,
        button,
        readState,
        isActive: () => !bulk?.isActive(),
        isValid: state => validState(state) && !(quickAddResult()?.errors.length),
        canSubmit: () => !submitting && canMutate(),
      });
      saveState.form = currentForm;
    }
    return saveState;
  }

  function invalidateEditor() {
    editorGeneration += 1;
    quickAddController?.invalidate();
  }

  function handleRoutingMemoryChange() {
    if (!routingMemory || mode !== 'create' || !modal()?.classList.contains('active') || !canMutate()) return;
    if (submitting || modal().getAttribute('aria-busy') === 'true') { memoryRenderPending = true; return; }
    memoryRenderPending = false;
    if (bulk?.isActive()) bulk.refresh();
    else { void quickAddController?.refresh(); ensureSaveState()?.refresh?.(); }
  }

  function handleCloseRequest(event) {
    // Observe shell-owned controls before their asynchronous History close.
    // Only invalidate pending work here; do not run a second close lifecycle.
    if (modal()?.classList.contains('active')
      && event.target?.closest?.('[data-close-modal]')?.dataset.closeModal === 'shopping-item-modal') invalidateEditor();
  }

  function hideModal() {
    invalidateEditor();
    memoryRenderPending = false;
    bulk?.reset({ editing: true });
    renderEffectiveQuickAdd(null);
    const target = modal();
    target?.classList?.remove?.('active');
    target?.setAttribute?.('aria-hidden', 'true');
    storeCreator?.hide?.();
    bulkStoreCreator?.hide?.();
    const targetFocus = restoreFocus?.();
    restoreFocus = null;
    editingListIdentity = null;
    editingItemIdentity = null;
    setMode('create');
    targetFocus?.focus?.();
  }

  function closeModal(afterClose = null) {
    invalidateEditor();
    const callback = typeof afterClose === 'function' ? afterClose : null;
    if (requestCloseUiLayer('shopping-item-modal', { reason: 'ui' }, { afterClose: callback })) return;
    hideModal();
    callback?.();
  }

  function openModal(target, currentForm) {
    const generation = ++editorGeneration;
    memoryRenderPending = false;
    routingTouched.clear(); bulkRoutingTouched.clear();
    memoryReady = routingMemory ? Promise.resolve(routingMemory.refresh()).catch(onError) : Promise.resolve();
    bulkSubmissionScope = {};
    translatePage(target);
    setMode(mode);
    target.classList.add('active');
    target.setAttribute('aria-hidden', 'false');
    openUiLayer('shopping-item-modal');
    bulk?.reset({ editing: mode === 'edit' });
    ensureSaveState()?.reset();
    ensureQuickAdd();
    if (routingMemory) void memoryReady.then(() => {
      if (generation !== editorGeneration || !target.classList.contains('active') || !canMutate()) return;
      if (bulk?.isActive()) bulk.refresh();
      else if (mode === 'create') void quickAddController?.refresh();
    });
    if (shouldAutoFocusEntityEditorTitle(mode)) {
      globalThis.setTimeout?.(() => {
        if (generation === editorGeneration && mode === 'create' && target.classList.contains('active')) doc?.getElementById?.('shopping-item-name')?.focus?.();
      }, 0);
    }
    return true;
  }

  function showCreate() {
    if (!canMutate() || submitting || modal()?.getAttribute?.('aria-busy') === 'true') return false;
    const target = modal();
    const currentForm = form();
    if (!target || !currentForm) return false;
    mode = 'create';
    editingListIdentity = activeList()?.client_mutation_id ?? activeList()?.id;
    editingItemIdentity = null;
    currentForm.reset?.();
    const extras = currentForm.querySelector('.shopping-item-additional-details'); if (extras) extras.open = false;
    setError();
    storeCreator?.hide?.();
    populateSections();
    populateStores();
    populateSections('', 'shopping-item-multi-section');
    populateStores('', 'shopping-item-multi-store');
    restoreFocus = () => trigger();
    return openModal(target, currentForm);
  }

  function showEdit(listId, itemId, triggerElement = null) {
    const list = activeList();
    if (list?.can_edit !== true || submitting || modal()?.getAttribute?.('aria-busy') === 'true') return false;
    if (!sameId(list.id, listId) && !sameId(list.client_mutation_id, listId)) return false;
    const item = (list.items || []).find(candidate => sameId(candidate.id, itemId) || sameId(candidate.client_mutation_id, itemId));
    const target = modal();
    const currentForm = form();
    if (!item || !target || !currentForm) return false;
    mode = 'edit';
    editingListIdentity = list.client_mutation_id ?? list.id;
    editingItemIdentity = item.client_mutation_id ?? item.id;
    currentForm.reset?.();
    setError();
    storeCreator?.hide?.();
    const storeId = item.store_ids?.[0] ?? item.stores?.[0]?.id ?? null;
    populateSections(item.section_id ?? '');
    populateStores(storeId ?? '');
    doc.getElementById('shopping-item-name').value = item.name || '';
    doc.getElementById('shopping-item-quantity').value = item.quantity_value ?? '';
    doc.getElementById('shopping-item-unit').value = formatQuantityUnit(item.quantity_unit, getActiveLocale());
    if (doc.getElementById('shopping-item-quantity-text')) doc.getElementById('shopping-item-quantity-text').value = item.quantity_text || '';
    if (doc.getElementById('shopping-item-note')) doc.getElementById('shopping-item-note').value = item.note || '';
    const extras = currentForm.querySelector('.shopping-item-additional-details');
    if (extras) extras.open = Boolean(item.quantity_text || item.note);
    restoreFocus = () => editTrigger(editingItemIdentity) || (triggerElement?.isConnected ? triggerElement : null) || trigger();
    return openModal(target, currentForm);
  }

  function validateForSubmit(state) {
    const nameInput = doc?.getElementById?.('shopping-item-name');
    const quantityInput = doc?.getElementById?.('shopping-item-quantity');
    const unitInput = doc?.getElementById?.('shopping-item-unit');
    const invalidName = !state.name || state.name.length > 500;
    const quantity = state.quantity === '' ? null : Number(state.quantity);
    const invalidQuantity = (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) || Boolean(state.quantity_text && quantity !== null) || (state.quantity_text || '').length > 500;
    const invalidUnit = state.unit.length > 40;
    setInvalid(nameInput, invalidName);
    setInvalid(quantityInput, invalidQuantity);
    setInvalid(unitInput, invalidUnit);
    if (invalidName) setError('shopping.item.error.invalidName');
    else if (invalidQuantity) setError('shopping.item.error.invalidQuantity');
    else if (invalidUnit) setError('shopping.item.error.invalidUnit');
    else setError();
    return !(invalidName || invalidQuantity || invalidUnit);
  }

  async function save(event) {
    event?.preventDefault?.();
    if (submitting || !modal()?.classList.contains('active')) return;
    if (bulk?.isActive()) {
      try { await bulk.save(); }
      finally { if (memoryRenderPending) handleRoutingMemoryChange(); }
      return;
    }
    const feedbackSource = routingMemory?.capture?.() || routingMemory;
    const startingGeneration = editorGeneration;
    if (routingMemory && mode === 'create') await memoryReady;
    if (startingGeneration !== editorGeneration || submitting || !modal()?.classList.contains('active')) return;
    const list = activeList();
    if (!canMutate() || (!sameId(list?.id, editingListIdentity) && !sameId(list?.client_mutation_id, editingListIdentity)) || (mode === 'edit' && !resolveEditingItem())) {
      closeModal();
      return;
    }
    const raw = readFormState();
    const parsed = quickAddResult(raw.name);
    const state = effectiveState(raw, parsed);
    if (mode === 'edit' && routingMemory) {
      const item = resolveEditingItem();
      state.routing_fields = [
        ...(routingTouched.has('section') && !sameId(item?.section_id, state.sectionId) && !(item?.section_id == null && state.sectionId == null) ? ['section'] : []),
        ...(routingTouched.has('stores') && JSON.stringify([...(item?.store_ids || [])].map(String).sort()) !== JSON.stringify([...state.store_ids].map(String).sort()) ? ['stores'] : []),
      ];
    }
    if (parsed?.errors.length) {
      renderEffectiveQuickAdd(parsed);
      setError(parsed.errors[0]);
      doc?.getElementById?.('shopping-item-name')?.focus?.();
      return;
    }
    if (!validateForSubmit(state)) return;
    const controller = ensureSaveState();
    controller?.refresh?.();
    if (!controller?.canSave?.()) return;
    submitting = true;
    const generation = editorGeneration;
    form()?.setAttribute('inert', '');
    modal()?.setAttribute('aria-busy', 'true');
    controller.button.disabled = true;
    try {
      const saved = mode === 'edit'
        ? await itemController?.update?.(activeList()?.id, editingItemIdentity, withRoutingFeedback(state, feedbackSource))
        : await itemController?.create?.(withRoutingFeedback(state, feedbackSource));
      if (!saved) {
        if (!canMutate()) closeModal();
        return;
      }
      if (generation === editorGeneration) closeModal();
    } catch (error) {
      onError(error);
      if (generation !== editorGeneration) return;
      setError('shopping.item.error.saveFailed');
      controller.refresh();
      doc?.getElementById?.('shopping-item-name')?.focus?.();
    } finally {
      submitting = false;
      form()?.removeAttribute('inert');
      modal()?.removeAttribute('aria-busy');
      controller?.refresh?.();
      if (memoryRenderPending) handleRoutingMemoryChange();
    }
  }

  async function deleteCurrentItem() {
    if (mode !== 'edit' || submitting) return;
    const item = resolveEditingItem();
    if (!item || !canMutate()) {
      closeModal();
      return;
    }
    const confirmed = await confirmDanger({
      title: t('shopping.item.delete.title'),
      message: t('shopping.item.delete.message', { name: item.name || '' }),
      confirmText: t('shopping.item.delete.confirm'),
      returnFocus: () => doc?.querySelector?.('[data-shopping-item-editor-action="delete"]'),
    });
    if (!confirmed) return;
    submitting = true;
    const controller = ensureSaveState();
    if (controller?.button) controller.button.disabled = true;
    try {
      const deleted = await itemController?.remove?.(activeList()?.id, editingItemIdentity);
      if (!deleted) {
        if (!canMutate() || !resolveEditingItem()) closeModal();
        return;
      }
      closeModal();
    } catch (error) {
      onError(error);
      setError('shopping.item.error.deleteFailed');
    } finally {
      submitting = false;
      controller?.refresh?.();
    }
  }

  function handleSubmit(event) {
    if (event.target?.id !== 'shopping-item-form') return;
    void save(event);
  }

  function reconcile() {
    const allowed = canMutate();
    if (!modal()?.classList?.contains?.('active')) return;
    const list = activeList();
    if (!allowed || (!sameId(list?.id, editingListIdentity) && !sameId(list?.client_mutation_id, editingListIdentity))) {
      closeModal();
      return;
    }
    if (mode === 'edit' && !resolveEditingItem()) {
      closeModal();
      return;
    }
    const sectionValue = doc?.getElementById?.('shopping-item-section')?.value || '';
    const storeValue = doc?.getElementById?.('shopping-item-store')?.value || '';
    populateSections(sectionValue);
    populateStores(storeValue);
    populateSections(doc?.getElementById?.('shopping-item-multi-section')?.value || '', 'shopping-item-multi-section');
    populateStores(doc?.getElementById?.('shopping-item-multi-store')?.value || '', 'shopping-item-multi-store');
    if (bulk?.isActive()) bulk.refresh();
    else {
      void quickAddController?.refresh();
      ensureSaveState()?.refresh?.();
    }
  }

  function handleClick(event) {
    const open = event.target?.closest?.('[data-shopping-item-action="open-create"]');
    if (open) {
      event.preventDefault?.();
      showCreate();
      return;
    }
    const editorAction = event.target?.closest?.('[data-shopping-item-editor-action]');
    if (editorAction) {
      event.preventDefault?.();
      doc?.getElementById?.('shopping-item-detail-menu-toggle')?.removeAttribute?.('open');
      if (editorAction.dataset.shoppingItemEditorAction === 'delete') void deleteCurrentItem();
      return;
    }
  }

  function focusableElements() {
    return Array.from(modal()?.querySelectorAll?.('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])') || [])
      .filter(element => !element.closest('[hidden]') && element.offsetParent !== null);
  }

  function handleKeydown(event) {
    if (!modal()?.classList?.contains?.('active') || modal()?.getAttribute?.('aria-hidden') === 'true') return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      form()?.requestSubmit?.();
      return;
    }
    if (event.key === 'Escape') {
      if (event.defaultPrevented || isDropdownOpen()) return;
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleLanguageChange() {
    if (!modal()?.classList?.contains?.('active')) return;
    const sectionValue = doc?.getElementById?.('shopping-item-section')?.value || '';
    const storeValue = doc?.getElementById?.('shopping-item-store')?.value || '';
    translatePage(modal());
    if (!bulk?.isActive()) setMode(mode);
    populateSections(sectionValue);
    populateStores(storeValue);
    populateSections(doc?.getElementById?.('shopping-item-multi-section')?.value || '', 'shopping-item-multi-section');
    populateStores(doc?.getElementById?.('shopping-item-multi-store')?.value || '', 'shopping-item-multi-store');
    if (bulk?.isActive()) bulk.refresh();
    else void quickAddController?.refresh();
  }

  function readBulkDefaults() {
    const sectionValue = doc?.getElementById?.('shopping-item-multi-section')?.value || null;
    const storeValue = doc?.getElementById?.('shopping-item-multi-store')?.value || null;
    const section = (activeList()?.sections || []).find(candidate => sameId(candidate.id, sectionValue));
    const store = getStores().find(candidate => sameId(candidate.id, storeValue));
    return {
      sectionId: section?.client_mutation_id ?? section?.id ?? null,
      storeId: store?.client_mutation_id ?? store?.id ?? null,
    };
  }

  function bindBulk() {
    bulk = createMultiAddFeature({
      prefix: 'shopping-item', document: doc, t, showToast,
      copy: {
        count: 'shopping.multiAdd.count', create: 'shopping.multiAdd.create',
        title: 'shopping.multiAdd.title', subtitle: 'shopping.multiAdd.subtitle',
        singleTitle: 'shopping.item.modal.title', singleSubtitle: 'shopping.item.modal.subtitle',
      },
      getSingleFields: () => Array.from(form()?.querySelectorAll('.ui-multi-add-single input, .ui-multi-add-single select') || []),
      readDefaults: readBulkDefaults,
      getContext: () => ({ identity: editingListIdentity, activeIdentity: activeList()?.client_mutation_id ?? activeList()?.id ?? null, generation: editorGeneration, locale: getActiveLocale(), canEdit: canMutate() }),
      parse: async (raw, defaults) => {
        if (routingMemory) await memoryReady;
        const parsed = quickAddResult(raw);
        const fields = effectiveState({ name: '', quantity: '', unit: '', sectionId: null, storeId: null }, parsed, defaults);
        return { ...routingPreview(parsed, fields), fields };
      },
      validate: parsed => parsed.errors?.[0] || (!validState(parsed.fields) ? 'shopping.item.error.invalidName' : null),
      onModeChange: nextMode => {
        storeCreator?.hide?.();
        bulkStoreCreator?.hide?.();
        quickAddController?.invalidate();
        setError();
        if (nextMode === 'single') {
          ensureSaveState()?.refresh?.();
          if (mode === 'create') void quickAddController?.refresh();
        }
      },
      onSave: (results, { isCurrent, context }) => itemController?.createMany?.(results.map(result => withRoutingFeedback(result.fields)), { listId: context.identity, isCurrent, submissionScope: bulkSubmissionScope }),
      onSaved: created => {
        closeModal();
        showToast(t(`shopping.multiAdd.created.${created.length === 1 ? 'one' : 'many'}`, { count: created.length }));
      },
      onError: error => {
        onError(error);
        setError('shopping.item.error.saveFailed');
      },
    });
    bulk.bind();
  }

  function bindStoreCreator(prefix, selectId) {
    return bindShoppingStoreCreator({
      document: doc, prefix, selectId, storeController,
      authorize: canMutateList,
      getContext: () => ({ id: activeList()?.id, client_mutation_id: activeList()?.client_mutation_id, editorGeneration }),
      onCreated: (store, context) => {
        if (context.editorGeneration !== editorGeneration || !modal()?.classList.contains('active')) return;
        if (routingMemory) (selectId.includes('-multi-') ? bulkRoutingTouched : routingTouched).add('stores');
        populateStores(store.client_mutation_id ?? store.id, selectId);
        if (bulk?.isActive()) bulk.refresh();
        else {
          void quickAddController?.refresh();
          ensureSaveState()?.refresh?.();
        }
      },
      onError,
    });
  }

  function handleQuantityModeInput(event) {
      if (!modal()?.classList.contains('active') || !canMutate()) return;
      if (event.target.id === 'shopping-item-quantity-text' && event.target.value.trim()) {
        doc.getElementById('shopping-item-quantity').value = ''; doc.getElementById('shopping-item-unit').value = '';
      } else if (['shopping-item-quantity', 'shopping-item-unit'].includes(event.target.id) && event.target.value.trim()) {
        const free = doc.getElementById('shopping-item-quantity-text'); if (free) free.value = '';
      }
  }

  function bind() {
    if (bound) return;
    bound = true;
    doc?.addEventListener?.('input', handleQuantityModeInput, true);
    storeCreator = bindStoreCreator('shopping-item', 'shopping-item-store');
    bulkStoreCreator = bindStoreCreator('shopping-item-multi', 'shopping-item-multi-store');
    bindBulk();
    doc?.addEventListener?.('click', handleCloseRequest, true);
    doc?.addEventListener?.('input', handleFormChange);
    doc?.addEventListener?.('change', handleFormChange);
    doc?.addEventListener?.('submit', handleSubmit);
    doc?.addEventListener?.('click', handleClick);
    doc?.addEventListener?.('keydown', handleKeydown);
    eventTarget?.addEventListener?.('nia-language-change', handleLanguageChange);
    eventTarget?.addEventListener?.('nia-routing-memory-changed', handleRoutingMemoryChange);
    registerUiLayer('shopping-item-modal', hideModal);
    reconcile();
  }

  return {
    bind,
    show: showCreate,
    showCreate,
    showEdit,
    close: closeModal,
    reconcile,
    createStore: () => storeCreator?.save?.(),
    destroy() {
      if (!bound) return;
      bound = false;
      doc?.removeEventListener?.('input', handleQuantityModeInput, true);
      bulk?.destroy();
      bulk = null;
      bulkStoreCreator?.destroy?.();
      bulkStoreCreator = null;
      quickAddController?.destroy();
      quickAddController = null;
      quickAddInput = null;
      doc?.removeEventListener?.('click', handleCloseRequest, true);
      doc?.removeEventListener?.('input', handleFormChange);
      doc?.removeEventListener?.('change', handleFormChange);
      doc?.removeEventListener?.('submit', handleSubmit);
      doc?.removeEventListener?.('click', handleClick);
      doc?.removeEventListener?.('keydown', handleKeydown);
      eventTarget?.removeEventListener?.('nia-language-change', handleLanguageChange);
      eventTarget?.removeEventListener?.('nia-routing-memory-changed', handleRoutingMemoryChange);
      storeCreator?.destroy?.();
      storeCreator = null;
      saveState?.destroy?.();
      saveState = null;
    },
  };
}
