import { t } from '../i18n/index.js';
import { createOptimisticMetadataEntity, updateMetadataProjection } from './entity-metadata.js';
import { safeColor, safeIconName } from '../icons/lucide-icons.js';
import { createEntityAppearanceController } from './entity-appearance.js';
import { createEntityDirectSharingFeature } from './entity-direct-sharing.js';
import { createEntityEditorModalController } from './entity-editor-modal.js';
import { createEntityOwnershipField, isHouseholdOwnedEntity } from './entity-ownership-field.js';

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
  household = null,
  householdManager = false,
} = {}) {
  return {
    ...createOptimisticMetadataEntity({ id, name, color, icon, sort_order, createdAt, household, householdManager }),
    sections: [], items: [], preferences: { hide_empty_sections: false },
  };
}

export function updateShoppingListProjection(list, changes = {}, updatedAt = new Date().toISOString()) {
  const metadata = Object.fromEntries(['name', 'color', 'icon'].filter(key => Object.hasOwn(changes, key)).map(key => [key, changes[key]]));
  return updateMetadataProjection(list, metadata, updatedAt);
}

export function mergeShoppingListMetadata(list, metadata) {
  if (!list || !metadata) return null;
  return {
    ...list,
    ...metadata,
    sections: list.sections || [],
    items: list.items || [],
    preferences: list.preferences || {},
  };
}

export function createShoppingListDetailsFeature({
  document: doc = globalThis.document,
  eventTarget = globalThis.window,
  getLists = () => [],
  setLists = () => {},
  commitMutation = async () => {},
  enqueueListMutation = null,
  isOnlineForSync = () => false,
  syncWithServer = async () => {},
  selectList = () => false,
  confirmDanger = async () => false,
  normalizeActiveListNavigation = () => {},
  focusActiveListAction = () => false,
  getAccessSnapshot = () => globalThis.window?.niaAccessSnapshot || null,
  shoppingApi = null,
  createTempListId = () => `temp-shopping-list-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
  onError = console.error,
} = {}) {
  let bound = false;
  let appearance = null;
  let directSharing = null;
  let modalController = null;
  let ownershipField = null;
  let submitting = false;
  let deleting = false;
  let modalGeneration = 0;
  const listQueues = new Map();

  function enqueueLocallyForList(identity, task) {
    const key = String(identity);
    const previous = listQueues.get(key);
    const operation = (previous ? previous.catch(() => null) : Promise.resolve()).then(task);
    listQueues.set(key, operation);
    operation.finally(() => {
      if (listQueues.get(key) === operation) listQueues.delete(key);
    }).catch(() => {});
    return operation;
  }
  const runListMutation = enqueueListMutation || enqueueLocallyForList;

  function listById(id) {
    return getLists().find(list => String(list.id) === String(id)) || null;
  }

  function editingList() {
    return listById(doc?.getElementById?.('shopping-list-id')?.value);
  }

  function listByIdentity(identity) {
    return getLists().find(list => String(list.client_mutation_id ?? list.id) === String(identity)) || null;
  }

  function currentHousehold() {
    return getAccessSnapshot?.()?.household || null;
  }

  function isHouseholdManager() {
    return currentHousehold()?.role === 'owner';
  }

  function readState() {
    return {
      ...appearanceController().readState(),
      household_id: ownershipController().value(),
    };
  }

  function canSubmit() {
    const id = doc?.getElementById?.('shopping-list-id')?.value || '';
    if (!id) return true;
    const current = listById(id);
    return Boolean(current && canManageShoppingListMetadata(current));
  }

  function appearanceController() {
    if (!appearance) {
      appearance = createEntityAppearanceController({
        prefix: 'shopping-list',
        document: doc,
        defaultColor: DEFAULT_COLOR,
        defaultIcon: DEFAULT_ICON,
        onChange: () => modalController?.refreshSaveState?.(),
      });
    }
    return appearance;
  }

  function applyOwnershipMode(list = editingList()) {
    const householdSelected = Boolean(ownershipController().value());
    const transferMode = Boolean(list && !isHouseholdOwnedEntity(list) && canManageShoppingListMetadata(list) && householdSelected);
    if (list) {
      appearanceController().setValues({
        name: list.name || '',
        color: list.color || DEFAULT_COLOR,
        icon: list.icon || '',
      }, { editable: canManageShoppingListMetadata(list) && !transferMode });
    }
    modalController?.refreshSaveState?.();
  }

  function ownershipController() {
    if (!ownershipField) {
      ownershipField = createEntityOwnershipField({
        document: doc,
        prefix: 'shopping-list',
        getHousehold: currentHousehold,
        onChange: () => applyOwnershipMode(),
      });
    }
    return ownershipField;
  }

  function sharingController() {
    if (!directSharing) {
      directSharing = createEntityDirectSharingFeature({
        document: doc,
        prefix: 'shopping-list',
        listMembers: listId => shoppingApi?.listMembers?.(listId) || { members: [] },
        grantMember: (listId, identifier) => shoppingApi?.shareList?.(listId, { identifier }),
        revokeMember: (listId, userId) => shoppingApi?.revokeMember?.(listId, userId),
        leaveEntity: listId => shoppingApi?.leaveList?.(listId),
        confirmDanger,
        onMemberAdded: (_member, list) => {
          list.has_sharing_activity = true;
        },
        onLeft: list => {
          setLists(getLists().filter(candidate => String(candidate.id) !== String(list.id)));
          closeAfterDeletedList({ sync: false });
        },
        onError,
      });
    }
    return directSharing;
  }

  function setError(key = '') {
    const error = doc?.getElementById?.('shopping-list-error');
    if (error) error.textContent = key ? t(key) : '';
  }

  function syncDeleteMenu(list = editingList()) {
    const visible = Boolean(list && canManageShoppingListMetadata(list));
    ensureModalController().syncDeleteMenu(visible);
    const button = doc?.getElementById?.('shopping-list-delete-btn');
    if (button) button.disabled = deleting || !visible;
  }

  function closeModal(afterClose = null) {
    modalGeneration += 1;
    return ensureModalController().close({ afterClose: typeof afterClose === 'function' ? afterClose : null });
  }

  function detailButton(id) {
    return Array.from(doc?.querySelectorAll?.('[data-entity-sidebar-action="detail"][data-entity-type="shopping-list"]') || [])
      .find(button => String(button.dataset.entityId) === String(id)) || null;
  }

  function addButton() {
    return doc?.querySelector?.('[data-entity-sidebar-action="add"][data-entity-type="shopping-list"]') || null;
  }

  function ensureModalController() {
    if (modalController) return modalController;
    modalController = createEntityEditorModalController({
      prefix: 'shopping-list',
      document: doc,
      appearanceController: appearanceController(),
      ownershipController: ownershipController(),
      sharingController: sharingController(),
      readState,
      isValid: state => Boolean(state.name) && state.name.length <= 200,
      canSubmit,
      resolveView({ entity: list }) {
        const canManage = !list || canManageShoppingListMetadata(list);
        return {
          mode: list ? 'edit' : 'create',
          titleKey: list ? 'shopping.list.modal.editTitle' : 'shopping.list.modal.createTitle',
          appearance: {
            name: list?.name || '',
            color: list?.color || DEFAULT_COLOR,
            icon: list ? (list.icon || '') : DEFAULT_ICON,
          },
          appearanceEditable: canManage,
          ownershipCanManage: canManage,
          canDelete: Boolean(list && canManage),
          readOnly: Boolean(list && !canManage),
          restoreFocus: list
            ? () => detailButton(doc?.getElementById?.('shopping-list-id')?.value || list.id)
            : addButton,
        };
      },
      clearError: setError,
      onSubmit: save,
      onDelete: deleteCurrentList,
      onError,
    });
    return modalController;
  }

  function showListModal(list = null) {
    modalGeneration += 1;
    return ensureModalController().open(list);
  }

  async function persistCreate(state) {
    const id = createTempListId();
    const household = state.household_id ? currentHousehold() : null;
    const created = createOptimisticShoppingList({
      id,
      name: state.name,
      color: state.color,
      icon: state.icon,
      sort_order: getLists().length,
      household,
      householdManager: isHouseholdManager(),
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
        household_id: household?.id ?? null,
        client_mutation_id: id,
      },
    }));
    setLists([...getLists(), created]);
    return created;
  }

  async function persistUpdate(current, state) {
    const stableIdentity = current.client_mutation_id ?? current.id;
    return runListMutation(stableIdentity, async () => {
      const committed = await commitMutation(() => {
        const latest = listByIdentity(stableIdentity);
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
    });
  }

  function resetCancelledTransfer(current) {
    ownershipController().render(current, { canManage: canManageShoppingListMetadata(current) });
    appearanceController().setValues({
      name: current.name || '',
      color: current.color || DEFAULT_COLOR,
      icon: current.icon || '',
    }, { editable: canManageShoppingListMetadata(current) });
    ensureModalController().resetSaveState();
  }

  async function persistHouseholdTransfer(current, state) {
    const household = currentHousehold();
    const householdId = Number(state.household_id);
    if (!household || !Number.isInteger(householdId) || householdId !== Number(household.id)) return null;
    if (String(current.id).startsWith('temp-') || !isOnlineForSync() || !shoppingApi?.transferToHousehold) {
      setError('shopping.list.error.transferRequiresOnline');
      return null;
    }
    const confirmed = await confirmDanger({
      title: t('shopping.list.transferHousehold.title'),
      message: t('shopping.list.transferHousehold.message', { list: current.name || '', household: household.name || '' }),
      confirmText: t('shopping.list.transferHousehold.confirm'),
      cancelText: t('shopping.list.transferHousehold.cancel'),
      returnFocus: () => doc?.querySelector?.('[data-select-id="shopping-list-household-id"] .ui-select-trigger'),
    });
    if (!confirmed) {
      resetCancelledTransfer(current);
      return null;
    }
    const stableIdentity = current.client_mutation_id ?? current.id;
    return runListMutation(stableIdentity, async () => {
      const latest = listById(current.id);
      if (!latest || !canManageShoppingListMetadata(latest)) return null;
      const transferred = await shoppingApi.transferToHousehold(latest.id, householdId);
      if (!transferred?.id) throw new Error('Household transfer did not return the shopping list');
      const projected = mergeShoppingListMetadata(latest, transferred);
      setLists(getLists().map(list => String(list.id) === String(latest.id) ? projected : list));
      return projected;
    });
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
    ensureModalController().resetSaveState();
    syncDeleteMenu(latest);
    doc?.getElementById?.('shopping-list-modal')?.querySelector?.('.modal-close-x')?.focus?.();
  }

  function closeAfterDeletedList({ sync = true } = {}) {
    closeModal(() => {
      normalizeActiveListNavigation();
      focusActiveListAction();
      if (sync && isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
    });
  }

  function reconcileListsChanged() {
    const modal = doc?.getElementById?.('shopping-list-modal');
    if (!modal?.classList?.contains?.('active')) return false;
    const id = doc?.getElementById?.('shopping-list-id')?.value || '';
    if (!id) return false;
    const latest = editingList();
    if (latest) {
      if (!canManageShoppingListMetadata(latest)) reconcileBlockedUpdate();
      return false;
    }
    if (doc?.getElementById?.('confirm-modal')?.classList?.contains?.('active')) return true;
    closeAfterDeletedList({ sync: false });
    return true;
  }

  async function deleteCurrentList() {
    if (deleting || submitting) return;
    const current = editingList();
    if (!current || !canManageShoppingListMetadata(current)) {
      syncDeleteMenu(current);
      return;
    }
    const stableIdentity = current.client_mutation_id ?? current.id;
    const generation = modalGeneration;
    doc?.getElementById?.('shopping-list-detail-header-menu')?.removeAttribute?.('open');
    deleting = true;
    syncDeleteMenu(current);
    try {
      const confirmed = await confirmDanger({
        title: t('shopping.list.delete.title'),
        message: t('shopping.list.delete.message'),
        confirmText: t('shopping.list.delete.confirm'),
        returnFocus: () => doc?.getElementById?.('shopping-list-detail-header-menu-trigger'),
      });
      if (!confirmed) {
        if (generation === modalGeneration && !editingList()) closeAfterDeletedList();
        return;
      }
      const committed = await runListMutation(stableIdentity, async () => {
        const mutation = await commitMutation(() => {
          const latest = listByIdentity(stableIdentity);
          if (!latest || !canManageShoppingListMetadata(latest)) return null;
          return {
            deleteListId: latest.id,
            action: 'DELETE_SHOPPING_LIST',
            data: { id: latest.id },
          };
        });
        if (mutation) setLists(getLists().filter(list => String(list.id) !== String(mutation.data.id)));
        return mutation;
      });
      if (generation !== modalGeneration) {
        if (committed && isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
        return;
      }
      if (!committed) {
        const latest = editingList();
        if (latest) reconcileBlockedUpdate();
        else closeAfterDeletedList();
        return;
      }
      closeAfterDeletedList();
    } catch (error) {
      onError(error);
      if (generation !== modalGeneration) return;
      setError('shopping.list.error.deleteFailed');
      globalThis.setTimeout?.(() => {
        if (generation === modalGeneration) doc?.getElementById?.('shopping-list-detail-header-menu-trigger')?.focus?.();
      }, 0);
    } finally {
      deleting = false;
      syncDeleteMenu();
    }
  }

  async function save(event) {
    event?.preventDefault?.();
    if (submitting || deleting) return;
    const state = {
      id: doc?.getElementById?.('shopping-list-id')?.value || '',
      ...readState(),
    };
    if (!state.name || state.name.length > 200) {
      setError('shopping.list.error.invalidName');
      return;
    }
    const current = state.id ? listById(state.id) : null;
    if (state.id && !current) {
      closeAfterDeletedList({ sync: false });
      return;
    }
    if (current && !canManageShoppingListMetadata(current)) return;
    const generation = modalGeneration;
    const controller = ensureModalController();
    controller.refreshSaveState();
    if (!controller.canSave()) return;
    submitting = true;
    const saveButton = doc?.getElementById?.('shopping-list-save-btn');
    if (saveButton) saveButton.disabled = true;
    let transferRequested = false;
    try {
      transferRequested = Boolean(current && !isHouseholdOwnedEntity(current) && state.household_id);
      const saved = transferRequested
        ? await persistHouseholdTransfer(current, state)
        : (current ? await persistUpdate(current, state) : await persistCreate(state));
      if (generation !== modalGeneration) {
        if (saved && isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
        return;
      }
      if (!saved) {
        if (current && !transferRequested) reconcileBlockedUpdate();
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
      if (generation !== modalGeneration) return;
      setError('shopping.list.error.saveFailed');
      controller.refreshSaveState();
      if (transferRequested) {
        globalThis.setTimeout?.(() => doc?.querySelector?.('[data-select-id="shopping-list-household-id"] .ui-select-trigger')?.focus?.(), 0);
      }
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
    ensureModalController().bind();
    sharingController().bind();
    eventTarget?.addEventListener?.('nia:shopping-list-add-request', handleAddRequest);
    eventTarget?.addEventListener?.('nia:shopping-list-detail-request', handleDetailRequest);
  }

  return {
    bind,
    showListModal,
    save,
    closeModal,
    deleteCurrentList,
    reconcileListsChanged,
    remapListId,
  };
}
