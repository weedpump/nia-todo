import { resolveEntityIdentity, entityIdentity } from '../core/entity-identity.js';
function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function createShoppingSectionsAdapter({
  getLists = () => [],
  getActorId = () => null,
  setLists = () => {},
  getActiveListId = () => null,
  getRoot = () => null,
  commitMutation,
  render = () => {},
  isOnlineForSync = () => false,
  syncWithServer = async () => {},
  onError = () => {},
  onCompletedEmpty = () => {},
  onCompletedSuccess = () => {},
  labels = {},
  itemDrag = null,
  enqueueListMutation = null,
  canReorder = () => true,
  now = () => new Date().toISOString(),
  createTempId = () => `temp-shopping-section-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  const resolve = (records, identity, parentId) => resolveEntityIdentity(records, identity, { actorId: getActorId(), ...(parentId === undefined ? {} : { parentId, parentField: 'shopping_list_id' }) });
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

  function currentList(identity = getActiveListId()) {
    return resolve(getLists(), identity);
  }

  function visibleSections(list = currentList()) {
    const sections = list?.sections || [];
    if (list?.preferences?.hide_empty_sections !== true) return sections;
    const items = list?.items || [];
    return sections.filter(section => items.some(item => sameId(item.section_id, section.id)));
  }

  function publish(mutation) {
    if (!mutation?.list) return null;
    const nextLists = getLists().map(list => sameId(list.id, mutation.list.id) ? mutation.list : list);
    setLists(nextLists);
    render();
    if (isOnlineForSync()) syncWithServer().catch(onError);
    return mutation.result || null;
  }

  async function commit(build) {
    const initial = currentList();
    if (initial?.can_edit !== true) return null;
    const stableIdentity = entityIdentity(initial, getActorId());
    return runListMutation(stableIdentity, async () => {
      const mutation = await commitMutation(() => {
        const live = currentList(stableIdentity);
        if (live?.can_edit !== true) return null;
        return build(live);
      });
      return publish(mutation);
    });
  }

  const adapter = {
    getRoot,
    labels,
    getSections: () => visibleSections(),
    getItems: () => currentList()?.items || [],
    canManage: () => currentList()?.can_edit === true,
    canReorder: () => currentList()?.can_edit === true && canReorder(currentList()) === true,
    canCreate: () => currentList()?.can_edit === true,
    canCleanup: () => currentList()?.can_edit === true,
    completedCount: () => (currentList()?.items || []).filter(item => item.completed === true).length,
    newInputId: () => 'shopping-new-section-name',
    editInputId: id => `shopping-edit-section-name-${id}`,
    resolveSectionId(id) {
      return resolve(this.getSections(), id)?.id ?? id;
    },
    itemDrag,
    render,
    onError,
    onCompletedEmpty,
    onCompletedSuccess,
    async createSection(name) {
      const cleanName = name?.trim();
      if (!cleanName) return null;
      const tempId = createTempId();
      const createdAt = now();
      return commit((live) => {
        const section = {
          id: tempId,
          shopping_list_id: live.id,
          name: cleanName,
          sort_order: (live.sections || []).length,
          client_mutation_id: tempId,
          created_by_user_id: getActorId(),
          created_at: createdAt,
          updated_at: createdAt,
          is_pending: true,
        };
        const list = { ...clone(live), sections: [...(live.sections || []).map(clone), section] };
        return {
          list,
          action: 'CREATE_SHOPPING_SECTION',
          data: {
            shopping_list_id: live.id,
            temp_id: tempId,
            section: { name: cleanName, sort_order: section.sort_order },
            client_mutation_id: tempId,
          },
          result: section,
        };
      });
    },
    async renameSection(id, name) {
      const cleanName = name?.trim();
      if (!cleanName) return null;
      return commit((live) => {
        const section = resolve(live.sections || [], id);
        if (!section) return null;
        const updated = { ...section, name: cleanName, updated_at: now(), is_pending: true };
        return {
          list: { ...clone(live), sections: live.sections.map(candidate => sameId(candidate.id, section.id) ? updated : clone(candidate)) },
          action: 'UPDATE_SHOPPING_SECTION',
          data: { shopping_list_id: live.id, section_id: section.id, changes: { name: cleanName } },
          result: updated,
        };
      });
    },
    async deleteSection(id) {
      return commit((live) => {
        const section = resolve(live.sections || [], id);
        if (!section) return null;
        const list = {
          ...clone(live),
          sections: live.sections.filter(candidate => !sameId(candidate.id, section.id)).map(clone),
          items: (live.items || []).map(item => sameId(item.section_id, section.id) ? { ...clone(item), section_id: null } : clone(item)),
        };
        return {
          list,
          action: 'DELETE_SHOPPING_SECTION',
          data: { shopping_list_id: live.id, section_id: section.id },
          result: { id: section.id },
        };
      });
    },
    async clearCompleted() {
      return commit((live) => {
        const completed = (live.items || []).filter(item => item.completed === true);
        if (!completed.length) return null;
        return {
          list: { ...clone(live), items: live.items.filter(item => item.completed !== true).map(clone) },
          action: 'DELETE_COMPLETED_SHOPPING_ITEMS',
          data: { shopping_list_id: live.id },
          result: { deleted_count: completed.length, deleted_ids: completed.map(item => item.id) },
        };
      });
    },
    async reorderSections(orderedIds) {
      if (!Array.isArray(orderedIds)) return null;
      return commit((live) => {
        const sections = live.sections || [];
        const visible = visibleSections(live);
        if (orderedIds.length !== visible.length) return null;
        const canonicalIds = orderedIds.map(id => resolve(visible, id)?.id);
        if (canonicalIds.some(id => id == null) || new Set(canonicalIds.map(String)).size !== visible.length) return null;
        const byId = new Map(visible.map(section => [String(section.id), section]));
        let visibleIndex = 0;
        const visibleIds = new Set(visible.map(section => String(section.id)));
        const reordered = sections.map((section, index) => {
          const next = visibleIds.has(String(section.id))
            ? byId.get(String(canonicalIds[visibleIndex++]))
            : section;
          return { ...clone(next), sort_order: index };
        });
        const changedIds = new Set(reordered
          .filter((section, index) => !sameId(sections[index]?.id, section.id) || Number(sections[index]?.sort_order) !== index)
          .map(section => String(section.id)));
        if (!changedIds.size) return null;
        const projected = reordered.map(section => changedIds.has(String(section.id)) ? { ...section, is_pending: true } : section);
        const changed = projected.filter(section => changedIds.has(String(section.id)));
        return {
          list: { ...clone(live), sections: projected },
          mutations: changed.map(section => ({
            action: 'UPDATE_SHOPPING_SECTION',
            data: { shopping_list_id: live.id, section_id: section.id, changes: { sort_order: section.sort_order } },
          })),
          result: projected,
        };
      });
    },
  };
  return adapter;
}
