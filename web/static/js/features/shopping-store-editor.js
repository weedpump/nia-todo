import { t } from '../i18n/index.js';
import { isDropdownOpen } from '../ui/dropdowns.js';
import { createFormSaveState } from './form-save-state.js';
import { openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';
import { validShoppingStoreName } from './shopping-stores.js';

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

export function createShoppingStoreEditorFeature({
  document: doc = globalThis.document,
  getLists = () => [],
  getStores = () => [],
  storeController,
  confirmDanger = async () => false,
  onError = console.error,
} = {}) {
  let bound = false;
  let submitting = false;
  let saveState = null;
  let restoreFocus = null;
  let coveredModal = null;

  function listById(id) {
    return getLists().find(list => sameId(list.id, id) || sameId(list.client_mutation_id, id)) || null;
  }

  function storeById(id) {
    return getStores().find(store => sameId(store.id, id) || sameId(store.client_mutation_id, id)) || null;
  }

  function canManage(listId, store = null) {
    const list = listById(listId);
    return Boolean(list?.can_manage === true && (!store || sameId(store.shopping_list_id, list.id) || sameId(store.shopping_list_id, list.client_mutation_id)));
  }

  function readState() {
    return { name: String(doc?.getElementById?.('shopping-store-name')?.value || '').trim() };
  }

  function ensureSaveState() {
    const form = doc?.getElementById?.('shopping-store-form');
    const button = doc?.getElementById?.('shopping-store-save-btn');
    if (!form || !button) return null;
    if (!saveState || saveState.form !== form) {
      saveState?.destroy?.();
      saveState = createFormSaveState({
        form,
        button,
        readState,
        isValid: state => Boolean(validShoppingStoreName(state.name)),
        canSubmit: () => {
          const listId = doc?.getElementById?.('shopping-store-list-id')?.value;
          const store = storeById(doc?.getElementById?.('shopping-store-id')?.value);
          return Boolean(store && canManage(listId, store));
        },
      });
      saveState.form = form;
    }
    return saveState;
  }

  function setError(key = '') {
    const target = doc?.getElementById?.('shopping-store-edit-error');
    if (target) target.textContent = key ? t(key) : '';
  }

  function hideModal() {
    const modal = doc?.getElementById?.('shopping-store-modal');
    modal?.classList?.remove?.('active');
    modal?.setAttribute?.('aria-hidden', 'true');
    if (coveredModal) {
      coveredModal.classList?.remove?.('ui-modal-underlay');
      coveredModal.removeAttribute?.('inert');
      if (coveredModal.classList?.contains?.('active')) coveredModal.setAttribute?.('aria-hidden', 'false');
      coveredModal = null;
    }
    const target = restoreFocus;
    restoreFocus = null;
    const focusTarget = target?.isConnected
      ? target
      : doc?.querySelector?.('#shopping-item-modal.active [data-select-id="shopping-item-store"] .ui-select-trigger')
        || doc?.querySelector?.('[data-select-id="shopping-store-filter"] .ui-select-trigger');
    focusTarget?.focus?.();
  }

  function closeModal() {
    if (requestCloseUiLayer('shopping-store-modal', { reason: 'ui' }, { afterClose: hideModal })) return;
    hideModal();
  }

  function showEdit(listId, storeId, trigger = null) {
    const modal = doc?.getElementById?.('shopping-store-modal');
    const store = storeById(storeId);
    if (!modal || !store || store.active === false || !canManage(listId, store)) return false;
    const listInput = doc.getElementById('shopping-store-list-id');
    const storeInput = doc.getElementById('shopping-store-id');
    const nameInput = doc.getElementById('shopping-store-name');
    if (!listInput || !storeInput || !nameInput) return false;
    listInput.value = listId;
    storeInput.value = store.id;
    nameInput.value = store.name || '';
    setError();
    restoreFocus = trigger;
    coveredModal = Array.from(doc?.querySelectorAll?.('.modal.active') || [])
      .find(candidate => candidate !== modal && candidate.id !== 'confirm-modal') || null;
    if (coveredModal) {
      coveredModal.classList.add('ui-modal-underlay');
      coveredModal.setAttribute('inert', '');
      coveredModal.setAttribute('aria-hidden', 'true');
    }
    doc?.getElementById?.('shopping-store-detail-menu-toggle')?.removeAttribute?.('open');
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    openUiLayer('shopping-store-modal');
    ensureSaveState()?.reset();
    globalThis.setTimeout?.(() => nameInput.focus?.(), 0);
    return true;
  }

  async function save() {
    if (submitting) return null;
    const listId = doc?.getElementById?.('shopping-store-list-id')?.value;
    const storeId = doc?.getElementById?.('shopping-store-id')?.value;
    const store = storeById(storeId);
    const name = validShoppingStoreName(readState().name);
    const input = doc?.getElementById?.('shopping-store-name');
    if (!store || !name || !canManage(listId, store)) {
      input?.setAttribute?.('aria-invalid', 'true');
      setError(!name ? 'shopping.store.error.invalidName' : 'shopping.store.error.saveFailed');
      input?.focus?.();
      return null;
    }
    input?.removeAttribute?.('aria-invalid');
    setError();
    submitting = true;
    const button = doc?.getElementById?.('shopping-store-save-btn');
    if (button) button.disabled = true;
    try {
      const updated = await storeController?.update?.(store.id, name, {
        authorize: latestStore => canManage(listId, latestStore),
      });
      if (!updated) {
        setError('shopping.store.error.saveFailed');
        input?.focus?.();
        return null;
      }
      closeModal();
      return updated;
    } catch (error) {
      onError(error);
      setError('shopping.store.error.saveFailed');
      input?.focus?.();
      return null;
    } finally {
      submitting = false;
      ensureSaveState()?.refresh?.();
    }
  }

  function handleSubmit(event) {
    if (event.target?.id !== 'shopping-store-form') return;
    event.preventDefault();
    void save();
  }

  function handleClick(event) {
    const editorAction = event.target?.closest?.('[data-shopping-store-editor-action]');
    if (editorAction) {
      event.preventDefault?.();
      doc?.getElementById?.('shopping-store-detail-menu-toggle')?.removeAttribute?.('open');
      if (editorAction.dataset.shoppingStoreEditorAction === 'delete') void deleteCurrentStore();
      return;
    }
    if (!event.target?.closest?.('[data-close-modal="shopping-store-modal"]')) return;
    event.preventDefault?.();
    closeModal();
  }

  async function deleteCurrentStore() {
    if (submitting) return null;
    const listId = doc?.getElementById?.('shopping-store-list-id')?.value;
    const store = storeById(doc?.getElementById?.('shopping-store-id')?.value);
    if (!store || !canManage(listId, store)) {
      closeModal();
      return null;
    }
    const confirmed = await confirmDanger({
      title: t('shopping.store.delete'),
      message: t('shopping.store.delete.message', { name: store.name || '' }),
      confirmText: t('shopping.store.delete'),
      returnFocus: () => doc?.getElementById?.('shopping-store-detail-menu-trigger'),
    });
    if (!confirmed) return null;
    submitting = true;
    const button = doc?.getElementById?.('shopping-store-save-btn');
    if (button) button.disabled = true;
    try {
      const deleted = await storeController?.remove?.(store.id, {
        authorize: latestStore => canManage(listId, latestStore),
      });
      if (!deleted) {
        if (!canManage(listId, storeById(store.id))) {
          closeModal();
        } else {
          setError('shopping.store.error.deleteFailed');
          doc?.getElementById?.('shopping-store-detail-menu-trigger')?.focus?.();
        }
        return null;
      }
      closeModal();
      return deleted;
    } catch (error) {
      onError(error);
      setError('shopping.store.error.deleteFailed');
      doc?.getElementById?.('shopping-store-detail-menu-trigger')?.focus?.();
      return null;
    } finally {
      submitting = false;
      ensureSaveState()?.refresh?.();
    }
  }

  function focusableElements() {
    return Array.from(doc?.getElementById?.('shopping-store-modal')?.querySelectorAll?.('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), summary, [tabindex]:not([tabindex="-1"])') || [])
      .filter(element => !element.closest('[hidden]') && element.offsetParent !== null);
  }

  function handleKeydown(event) {
    const modal = doc?.getElementById?.('shopping-store-modal');
    if (!modal?.classList?.contains?.('active')) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      doc?.getElementById?.('shopping-store-form')?.requestSubmit?.();
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

  function bind() {
    if (bound) return;
    bound = true;
    doc?.addEventListener?.('submit', handleSubmit);
    doc?.addEventListener?.('click', handleClick);
    doc?.addEventListener?.('keydown', handleKeydown);
    registerUiLayer('shopping-store-modal', () => hideModal());
  }

  return {
    bind,
    showEdit,
    save,
    deleteCurrentStore,
    closeModal,
    destroy() {
      if (!bound) return;
      bound = false;
      doc?.removeEventListener?.('submit', handleSubmit);
      doc?.removeEventListener?.('click', handleClick);
      doc?.removeEventListener?.('keydown', handleKeydown);
      saveState?.destroy?.();
      saveState = null;
    },
  };
}
