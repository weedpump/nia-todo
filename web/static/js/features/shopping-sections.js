function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function createShoppingSectionsAdapter({
  getLists = () => [],
  setLists = () => {},
  getActiveListId = () => null,
  getRoot = () => null,
  commitMutation,
  render = () => {},
  isOnlineForSync = () => false,
  syncWithServer = async () => {},
  onError = () => {},
  labels = {},
  itemDrag = null,
  now = () => new Date().toISOString(),
  createTempId = () => `temp-shopping-section-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  function currentList() {
    const activeId = getActiveListId();
    return getLists().find(list => sameId(list.id, activeId)) || null;
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
    if (currentList()?.can_manage !== true) return null;
    const mutation = await commitMutation(() => {
      const live = currentList();
      if (live?.can_manage !== true) return null;
      return build(live);
    });
    return publish(mutation);
  }

  const adapter = {
    getRoot,
    labels,
    getSections: () => currentList()?.sections || [],
    getItems: () => currentList()?.items || [],
    canManage: () => currentList()?.can_manage === true,
    newInputId: () => 'shopping-new-section-name',
    editInputId: id => `shopping-edit-section-name-${id}`,
    resolveSectionId(id) {
      return this.getSections().find(section => sameId(section.id, id))?.id ?? id;
    },
    itemDrag,
    render,
    onError,
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
        const section = (live.sections || []).find(candidate => sameId(candidate.id, id));
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
        const section = (live.sections || []).find(candidate => sameId(candidate.id, id));
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
    async reorderSections(orderedIds) {
      if (!Array.isArray(orderedIds)) return null;
      return commit((live) => {
        const sections = live.sections || [];
        if (orderedIds.length !== sections.length) return null;
        if (new Set(orderedIds.map(id => String(id))).size !== sections.length) return null;
        const byId = new Map(sections.map(section => [String(section.id), section]));
        if (orderedIds.some(id => !byId.has(String(id)))) return null;
        const reordered = orderedIds.map((id, index) => ({ ...clone(byId.get(String(id))), sort_order: index }));
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
