import { t } from '../i18n/index.js';
import { updateTopbarToggle } from '../ui/topbar-toggle.js';

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function createShoppingViewPreferencesFeature({
  getLists = () => [],
  setLists = () => {},
  getActiveListId = () => null,
  commitMutation,
  render = () => {},
  isOnlineForSync = () => false,
  syncWithServer = async () => {},
  onError = () => {},
} = {}) {
  let bound = false;
  const listQueues = new Map();

  function currentList(identity = getActiveListId()) {
    return getLists().find(list => sameId(list.id, identity) || sameId(list.client_mutation_id, identity)) || null;
  }

  function enqueueForList(identity, task) {
    const key = String(identity);
    const previous = listQueues.get(key);
    const ready = previous ? previous.catch(() => null) : Promise.resolve();
    const operation = ready.then(task);
    listQueues.set(key, operation);
    operation.finally(() => {
      if (listQueues.get(key) === operation) listQueues.delete(key);
    }).catch(() => {});
    return operation;
  }

  function updateButton() {
    const button = globalThis.document?.getElementById?.('shopping-hide-empty-sections-btn');
    if (!button) return false;
    const hidden = currentList()?.preferences?.hide_empty_sections === true;
    return updateTopbarToggle(button, {
      pressed: hidden,
      label: hidden ? t('shopping.preferences.hideEmpty.on') : t('shopping.preferences.hideEmpty.short'),
      title: hidden ? t('shopping.preferences.hideEmpty.disable') : t('shopping.preferences.hideEmpty.enable'),
    });
  }

  async function toggleHideEmptySections() {
    const initial = currentList();
    if (!initial) return null;
    const stableIdentity = initial.client_mutation_id ?? initial.id;
    return enqueueForList(stableIdentity, async () => {
      const mutation = await commitMutation(() => {
        const live = currentList(stableIdentity);
        if (!live) return null;
        const preferences = live.preferences || {};
        const changes = {
          selected_store_id: preferences.selected_store_id ?? null,
          hide_empty_sections: preferences.hide_empty_sections !== true,
        };
        return {
          list: {
            ...clone(live),
            preferences: { ...clone(preferences), ...changes },
          },
          action: 'UPDATE_SHOPPING_PREFERENCES',
          data: { shopping_list_id: live.id, changes },
        };
      });
      if (!mutation?.list) return null;
      setLists(getLists().map(list => (
        sameId(list.id, mutation.list.id) || sameId(list.client_mutation_id, mutation.list.client_mutation_id)
          ? mutation.list
          : list
      )));
      render();
      updateButton();
      if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
      return mutation.list;
    });
  }

  function bind() {
    if (bound) return;
    bound = true;
    document.getElementById('shopping-hide-empty-sections-btn')?.addEventListener('click', () => {
      toggleHideEmptySections().catch(onError);
    });
  }

  return { bind, updateButton, toggleHideEmptySections };
}
