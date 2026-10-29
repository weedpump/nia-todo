import { t } from '../i18n/index.js';
import { safeColor, safeIconName } from '../icons/lucide-icons.js';
import { createEntityAppearanceController } from './entity-appearance.js';
import { createFormSaveState } from './form-save-state.js';
import { openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';

const DEFAULT_COLOR = '#6366f1';
const DEFAULT_ICON = 'shopping-cart';

function booleanFlag(value) {
  return value === true || value === 1 || value === '1';
}

export function canManageShoppingListMetadata(list) {
  return Boolean(list && Object.prototype.hasOwnProperty.call(list, 'can_manage') && booleanFlag(list.can_manage));
}

export function createOptimisticShoppingList({
  id,
  name,
  color = DEFAULT_COLOR,
  icon = DEFAULT_ICON,
  sort_order = 0,
  createdAt = new Date().toISOString(),
} = {}) {
  return {
    id,
    name: String(name || '').trim(),
    color: safeColor(color, DEFAULT_COLOR),
    icon: safeIconName(icon) || null,
    sort_order,
    created_at: createdAt,
    updated_at: createdAt,
    owner_user_id: null,
    owner_household_id: null,
    ownership_type: 'user',
    can_edit: true,
    can_manage: true,
    is_owner: true,
    is_shared: false,
    sections: [],
    items: [],
    preferences: { selected_store_id: null, hide_empty_sections: false },
    is_pending: true,
    client_mutation_id: id,
  };
}

export function updateShoppingListProjection(list, changes = {}, updatedAt = new Date().toISOString()) {
  if (!list) return null;
  return {
    ...list,
    ...(Object.prototype.hasOwnProperty.call(changes, 'name') ? { name: String(changes.name || '').trim() } : {}),
    ...(Object.prototype.hasOwnProperty.call(changes, 'color') ? { color: safeColor(changes.color, list.color || DEFAULT_COLOR) } : {}),
    ...(Object.prototype.hasOwnProperty.call(changes, 'icon') ? { icon: safeIconName(changes.icon) || null } : {}),
    updated_at: updatedAt,
    is_pending: true,
  };
}

export function createShoppingListDetailsFeature({
  document: doc = globalThis.document,
  eventTarget = globalThis.window,
  getLists = () => [],
  setLists = () => {},
  commitMutation = async () => {},
  isOnlineForSync = () => false,
  syncWithServer = async () => {},
  selectList = () => false,
  onError = console.error,
} = {}) {
  let bound = false;
  let appearance = null;
  let saveState = null;
  let submitting = false;
  let restoreFocus = null;

  function listById(id) {
    return getLists().find(list => String(list.id) === String(id)) || null;
  }

  function editingList() {
    return listById(doc?.getElementById?.('shopping-list-id')?.value);
  }

  function readState() {
    return appearanceController().readState();
  }

  function canSubmit() {
    const current = editingList();
    return !current || canManageShoppingListMetadata(current);
  }

  function appearanceController() {
    if (!appearance) {
      appearance = createEntityAppearanceController({
        prefix: 'shopping-list',
        document: doc,
        defaultColor: DEFAULT_COLOR,
        defaultIcon: DEFAULT_ICON,
        onChange: () => saveState?.refresh?.(),
      });
    }
    return appearance;
  }

  function ensureSaveState() {
    const form = doc?.getElementById?.('shopping-list-form');
    const button = doc?.getElementById?.('shopping-list-save-btn');
    if (!form || !button) return null;
    if (!saveState || saveState.form !== form) {
      saveState?.destroy?.();
      saveState = createFormSaveState({
        form,
        button,
        readState,
        isValid: state => Boolean(state.name) && state.name.length <= 200,
        canSubmit,
      });
      saveState.form = form;
    }
    return saveState;
  }

  function setError(key = '') {
    const error = doc?.getElementById?.('shopping-list-error');
    if (error) error.textContent = key ? t(key) : '';
  }

  function hideModal() {
    const modal = doc?.getElementById?.('shopping-list-modal');
    modal?.classList?.remove?.('active');
    modal?.setAttribute?.('aria-hidden', 'true');
    const focusTarget = restoreFocus?.();
    restoreFocus = null;
    focusTarget?.focus?.();
  }

  function closeModal(afterClose = null) {
    const callback = typeof afterClose === 'function' ? afterClose : null;
    if (requestCloseUiLayer('shopping-list-modal', { reason: 'ui' }, { afterClose: callback })) return;
    hideModal();
    callback?.();
  }

  function detailButton(id) {
    return Array.from(doc?.querySelectorAll?.('[data-entity-sidebar-action="detail"][data-entity-type="shopping-list"]') || [])
      .find(button => String(button.dataset.entityId) === String(id)) || null;
  }

  function addButton() {
    return doc?.querySelector?.('[data-entity-sidebar-action="add"][data-entity-type="shopping-list"]') || null;
  }

  function showListModal(list = null) {
    const modal = doc?.getElementById?.('shopping-list-modal');
    const form = doc?.getElementById?.('shopping-list-form');
    if (!modal || !form) return false;
    form.reset?.();
    doc.getElementById('shopping-list-id').value = list?.id ?? '';
    const canManage = !list || canManageShoppingListMetadata(list);
    appearanceController().setValues({
      name: list?.name || '',
      color: list?.color || DEFAULT_COLOR,
      icon: list ? (list.icon || '') : DEFAULT_ICON,
    }, { editable: canManage });
    const title = doc.getElementById('shopping-list-modal-title');
    if (title) {
      title.dataset.i18nKey = list ? 'shopping.list.modal.editTitle' : 'shopping.list.modal.createTitle';
      title.textContent = t(title.dataset.i18nKey);
    }
    setError();
    restoreFocus = list
      ? () => detailButton(doc?.getElementById?.('shopping-list-id')?.value || list.id)
      : addButton;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    openUiLayer('shopping-list-modal');
    ensureSaveState()?.reset();
    globalThis.setTimeout?.(() => {
      if (canManage) appearanceController().focusName();
      else modal.querySelector?.('.modal-close-x')?.focus?.();
    }, 0);
    return true;
  }

  function createTempListId() {
    const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `temp-shopping-list-${suffix}`;
  }

  async function persistCreate(state) {
    const id = createTempListId();
    const created = createOptimisticShoppingList({
      id,
      name: state.name,
      color: state.color,
      icon: state.icon,
      sort_order: getLists().length,
    });
    await commitMutation(() => ({
      list: created,
      action: 'CREATE_SHOPPING_LIST',
      data: {
        temp_id: id,
        list: created,
        name: created.name,
        color: created.color,
        icon: created.icon,
        sort_order: created.sort_order,
        household_id: null,
        client_mutation_id: id,
      },
    }));
    setLists([...getLists(), created]);
    return created;
  }

  async function persistUpdate(current, state) {
    const committed = await commitMutation(() => {
      const currentId = doc?.getElementById?.('shopping-list-id')?.value || current.id;
      const latest = listById(currentId);
      if (!latest || !canManageShoppingListMetadata(latest)) return null;
      const changes = { name: state.name, color: state.color, icon: state.icon };
      return {
        list: updateShoppingListProjection(latest, changes),
        action: 'UPDATE_SHOPPING_LIST',
        data: { id: latest.id, changes },
      };
    });
    if (!committed) return null;
    setLists(getLists().map(list => String(list.id) === String(committed.data.id) ? committed.list : list));
    return committed.list;
  }

  function reconcileBlockedUpdate() {
    const currentId = doc?.getElementById?.('shopping-list-id')?.value || '';
    const latest = currentId ? listById(currentId) : null;
    if (!latest) {
      closeModal();
      return;
    }
    appearanceController().setValues({
      name: latest.name,
      color: latest.color,
      icon: latest.icon || '',
    }, { editable: false });
    ensureSaveState()?.reset();
    doc?.getElementById?.('shopping-list-modal')?.querySelector?.('.modal-close-x')?.focus?.();
  }

  async function save(event) {
    event?.preventDefault?.();
    if (submitting) return;
    const state = {
      id: doc?.getElementById?.('shopping-list-id')?.value || '',
      ...readState(),
    };
    if (!state.name || state.name.length > 200) {
      setError('shopping.list.error.invalidName');
      return;
    }
    const current = state.id ? listById(state.id) : null;
    if (current && !canManageShoppingListMetadata(current)) return;
    const controller = ensureSaveState();
    controller?.refresh?.();
    if (!controller?.canSave?.()) return;
    submitting = true;
    controller.button.disabled = true;
    try {
      const saved = current ? await persistUpdate(current, state) : await persistCreate(state);
      if (!saved) {
        if (current) reconcileBlockedUpdate();
        return;
      }
      closeModal(() => {
        if (!current) {
          selectList(saved.id);
          detailButton(saved.id)?.focus?.();
        }
        if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
      });
    } catch (error) {
      onError(error);
      setError('shopping.list.error.saveFailed');
      controller.refresh();
    } finally {
      submitting = false;
    }
  }

  function handleAddRequest() {
    showListModal(null);
  }

  function handleDetailRequest(event) {
    const list = listById(event?.detail?.id);
    if (list) showListModal(list);
  }

  function remapListId(fromId, toId) {
    const idInput = doc?.getElementById?.('shopping-list-id');
    if (!idInput || String(idInput.value) !== String(fromId)) return false;
    idInput.value = String(toId);
    return true;
  }

  function bind() {
    if (bound) return;
    bound = true;
    const form = doc?.getElementById?.('shopping-list-form');
    form?.addEventListener?.('submit', save);
    eventTarget?.addEventListener?.('nia:shopping-list-add-request', handleAddRequest);
    eventTarget?.addEventListener?.('nia:shopping-list-detail-request', handleDetailRequest);
    registerUiLayer('shopping-list-modal', hideModal);
  }

  return {
    bind,
    showListModal,
    save,
    closeModal,
    remapListId,
  };
}
