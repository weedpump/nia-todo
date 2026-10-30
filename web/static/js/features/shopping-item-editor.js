import { t, translatePage } from '../i18n/index.js';
import { hydrateSelect, refreshSelect, isDropdownOpen } from '../ui/dropdowns.js';
import { createFormSaveState } from './form-save-state.js';
import { openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function nextSortOrder(records = []) {
  return records.reduce((maximum, record) => {
    const value = Number(record?.sort_order);
    return Number.isFinite(value) ? Math.max(maximum, value) : maximum;
  }, -1) + 1;
}

export function createShoppingItemEditorFeature({
  document: doc = globalThis.document,
  eventTarget = globalThis.window,
  getLists = () => [],
  getActiveListId = () => null,
  getStores = () => [],
  setStores = () => {},
  commitMutation,
  itemController,
  confirmDanger = async () => false,
  isOnlineForSync = () => false,
  syncWithServer = async () => {},
  onError = console.error,
  createStoreTempId = () => `temp-shopping-store-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  let bound = false;
  let saveState = null;
  let submitting = false;
  let submittingStore = false;
  let restoreFocus = null;
  let mode = 'create';
  let editingListIdentity = null;
  let editingItemIdentity = null;

  function activeList() {
    const id = getActiveListId();
    return getLists().find(list => sameId(list.id, id)) || null;
  }

  function canMutate() {
    return activeList()?.can_edit === true;
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

  function setStoreError(key = '') {
    const target = doc?.getElementById?.('shopping-item-store-error');
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

  function populateSections(selected = '') {
    const select = doc?.getElementById?.('shopping-item-section');
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

  function showStoreCreator() {
    const container = doc?.getElementById?.('shopping-item-new-store');
    const input = doc?.getElementById?.('shopping-item-new-store-name');
    if (!container || !input) return;
    container.hidden = false;
    input.value = '';
    setStoreError();
    input.focus?.();
  }

  function hideStoreCreator({ focusSelect = false } = {}) {
    const container = doc?.getElementById?.('shopping-item-new-store');
    const input = doc?.getElementById?.('shopping-item-new-store-name');
    if (container) container.hidden = true;
    if (input) {
      input.value = '';
      input.removeAttribute('aria-invalid');
    }
    setStoreError();
    if (focusSelect) doc?.querySelector?.('[data-select-id="shopping-item-store"] .ui-select-trigger')?.focus?.();
  }

  function populateStores(selected = '') {
    const select = doc?.getElementById?.('shopping-item-store');
    if (!select) return;
    const stores = getStores().filter(store => store?.active !== false);
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
      action: {
        label: t('shopping.item.store.add'),
        ariaLabel: t('shopping.item.store.add'),
        icon: 'plus',
        onActivate: showStoreCreator,
      },
    });
    refreshSelect(select);
  }

  function readState() {
    return {
      name: doc?.getElementById?.('shopping-item-name')?.value?.trim?.() || '',
      quantity: doc?.getElementById?.('shopping-item-quantity')?.value ?? '',
      unit: doc?.getElementById?.('shopping-item-unit')?.value?.trim?.() || '',
      sectionId: doc?.getElementById?.('shopping-item-section')?.value || null,
      storeId: doc?.getElementById?.('shopping-item-store')?.value || null,
    };
  }

  function validState(state) {
    if (!state.name || state.name.length > 500 || state.unit.length > 40) return false;
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
        isValid: validState,
        canSubmit: canMutate,
      });
      saveState.form = currentForm;
    }
    return saveState;
  }

  function hideModal() {
    const target = modal();
    target?.classList?.remove?.('active');
    target?.setAttribute?.('aria-hidden', 'true');
    hideStoreCreator();
    const targetFocus = restoreFocus?.();
    restoreFocus = null;
    editingListIdentity = null;
    editingItemIdentity = null;
    setMode('create');
    targetFocus?.focus?.();
  }

  function closeModal(afterClose = null) {
    const callback = typeof afterClose === 'function' ? afterClose : null;
    if (requestCloseUiLayer('shopping-item-modal', { reason: 'ui' }, { afterClose: callback })) return;
    hideModal();
    callback?.();
  }

  function openModal(target, currentForm) {
    translatePage(target);
    setMode(mode);
    target.classList.add('active');
    target.setAttribute('aria-hidden', 'false');
    openUiLayer('shopping-item-modal');
    ensureSaveState()?.reset();
    globalThis.setTimeout?.(() => doc?.getElementById?.('shopping-item-name')?.focus?.(), 0);
    return true;
  }

  function showCreate() {
    if (!canMutate() || submitting) return false;
    const target = modal();
    const currentForm = form();
    if (!target || !currentForm) return false;
    mode = 'create';
    editingListIdentity = null;
    editingItemIdentity = null;
    currentForm.reset?.();
    setError();
    setStoreError();
    hideStoreCreator();
    populateSections();
    populateStores();
    restoreFocus = () => trigger();
    return openModal(target, currentForm);
  }

  function showEdit(listId, itemId, triggerElement = null) {
    const list = activeList();
    if (list?.can_edit !== true || submitting) return false;
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
    setStoreError();
    hideStoreCreator();
    const storeId = item.store_ids?.[0] ?? item.stores?.[0]?.id ?? null;
    populateSections(item.section_id ?? '');
    populateStores(storeId ?? '');
    doc.getElementById('shopping-item-name').value = item.name || '';
    doc.getElementById('shopping-item-quantity').value = item.quantity_value ?? '';
    doc.getElementById('shopping-item-unit').value = item.quantity_unit || '';
    restoreFocus = () => editTrigger(editingItemIdentity) || (triggerElement?.isConnected ? triggerElement : null) || trigger();
    return openModal(target, currentForm);
  }

  async function createStore() {
    if (submittingStore) return null;
    const input = doc?.getElementById?.('shopping-item-new-store-name');
    const name = input?.value?.trim?.() || '';
    if (!name || name.length > 120) {
      setInvalid(input, true);
      setStoreError('shopping.store.error.invalidName');
      input?.focus?.();
      return null;
    }
    setInvalid(input, false);
    setStoreError();
    const duplicate = getStores().find(store => (
      String(store.name || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase()
      && store.active !== false
    ));
    if (duplicate) {
      populateStores(duplicate.client_mutation_id ?? duplicate.id);
      hideStoreCreator();
      ensureSaveState()?.refresh?.();
      return duplicate;
    }
    const tempId = createStoreTempId();
    submittingStore = true;
    const buttons = Array.from(doc?.querySelectorAll?.('[data-shopping-item-create-action="save-store"], [data-shopping-item-create-action="cancel-store"]') || []);
    buttons.forEach(button => { button.disabled = true; });
    try {
      const mutation = await commitMutation(() => {
        if (!canMutate()) return null;
        const store = {
          id: tempId,
          name,
          owner_user_id: null,
          owner_household_id: null,
          ownership_type: 'user',
          active: true,
          sort_order: nextSortOrder(getStores()),
          client_mutation_id: tempId,
          is_pending: true,
        };
        return {
          store,
          action: 'CREATE_SHOPPING_STORE',
          data: {
            temp_id: tempId,
            store: clone(store),
            name,
            household_id: null,
            sort_order: store.sort_order,
            client_mutation_id: tempId,
          },
          result: store,
        };
      });
      const store = mutation?.result || mutation?.store;
      if (!store) return null;
      if (mutation.store) setStores([...getStores().filter(candidate => !sameId(candidate.id, store.id)), store]);
      populateStores(store.client_mutation_id ?? store.id);
      hideStoreCreator();
      ensureSaveState()?.refresh?.();
      if (mutation.store && isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
      return store;
    } catch (error) {
      onError(error);
      setStoreError('shopping.store.error.saveFailed');
      input?.focus?.();
      return null;
    } finally {
      submittingStore = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  function validateForSubmit(state) {
    const nameInput = doc?.getElementById?.('shopping-item-name');
    const quantityInput = doc?.getElementById?.('shopping-item-quantity');
    const unitInput = doc?.getElementById?.('shopping-item-unit');
    const invalidName = !state.name || state.name.length > 500;
    const quantity = state.quantity === '' ? null : Number(state.quantity);
    const invalidQuantity = quantity !== null && (!Number.isFinite(quantity) || quantity < 0);
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
    if (submitting) return;
    const state = readState();
    if (!validateForSubmit(state)) return;
    const controller = ensureSaveState();
    controller?.refresh?.();
    if (!controller?.canSave?.()) return;
    submitting = true;
    controller.button.disabled = true;
    try {
      const saved = mode === 'edit'
        ? await itemController?.update?.(activeList()?.id, editingItemIdentity, state)
        : await itemController?.create?.(state);
      if (!saved) {
        if (!canMutate()) closeModal();
        return;
      }
      closeModal();
    } catch (error) {
      onError(error);
      setError('shopping.item.error.saveFailed');
      controller.refresh();
      doc?.getElementById?.('shopping-item-name')?.focus?.();
    } finally {
      submitting = false;
      controller?.refresh?.();
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
    if (!allowed) {
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
    ensureSaveState()?.refresh?.();
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
    const action = event.target?.closest?.('[data-shopping-item-create-action]');
    if (!action) return;
    event.preventDefault?.();
    if (action.dataset.shoppingItemCreateAction === 'save-store') void createStore();
    if (action.dataset.shoppingItemCreateAction === 'cancel-store') hideStoreCreator({ focusSelect: true });
  }

  function focusableElements() {
    return Array.from(modal()?.querySelectorAll?.('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])') || [])
      .filter(element => !element.closest('[hidden]') && element.offsetParent !== null);
  }

  function handleKeydown(event) {
    if (!modal()?.classList?.contains?.('active')) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
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
    setMode(mode);
    populateSections(sectionValue);
    populateStores(storeValue);
  }

  function bind() {
    if (bound) return;
    bound = true;
    doc?.addEventListener?.('submit', handleSubmit);
    doc?.addEventListener?.('click', handleClick);
    doc?.addEventListener?.('keydown', handleKeydown);
    eventTarget?.addEventListener?.('nia-language-change', handleLanguageChange);
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
    createStore,
    destroy() {
      if (!bound) return;
      bound = false;
      doc?.removeEventListener?.('submit', handleSubmit);
      doc?.removeEventListener?.('click', handleClick);
      doc?.removeEventListener?.('keydown', handleKeydown);
      eventTarget?.removeEventListener?.('nia-language-change', handleLanguageChange);
      saveState?.destroy?.();
      saveState = null;
    },
  };
}
