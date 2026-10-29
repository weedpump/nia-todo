import { createSectionController } from './section-ui.js';
import { t } from '../i18n/index.js';

export function createSectionActionsFeature({
  getTodos,
  setTodos,
  getSections,
  setSections,
  getCurrentProjectId,
  dbPut,
  deleteFromDB,
  addToSyncQueue,
  isOnlineForSync,
  syncWithServer,
  renderTodos,
  confirmDanger,
  sectionsFeature,
  sectionRegistry,
}) {
  function resolveSectionId(id) {
    const section = getSections().find(candidate => String(candidate.id) === String(id));
    return section ? section.id : id;
  }

  const adapter = {
    getRoot: () => document.getElementById('todo-list'),
    getSections,
    canManage: () => Boolean(getCurrentProjectId()),
    newInputId: () => 'new-section-name',
    editInputId: id => `edit-section-name-${id}`,
    resolveSectionId,
    render: renderTodos,
    async createSection(name) {
      const currentProjectId = getCurrentProjectId();
      if (!name || !currentProjectId) return null;
      const currentSections = getSections();
      const now = new Date().toISOString();
      const tempId = `temp-section-${Date.now()}`;
      const section = {
        id: tempId,
        name,
        project_id: currentProjectId,
        sort_order: currentSections.length,
        created_at: now,
        updated_at: now,
      };
      await dbPut('sections', section);
      await addToSyncQueue('CREATE_SECTION', { ...section, _tempId: tempId });
      setSections([...currentSections, section]);
      renderTodos();
      if (isOnlineForSync()) await syncWithServer();
      return section;
    },
    async renameSection(id, name) {
      const sectionId = resolveSectionId(id);
      const currentSections = getSections();
      const current = currentSections.find(section => String(section.id) === String(sectionId));
      if (!current || !name) return null;
      const updated = { ...current, name, updated_at: new Date().toISOString() };
      await dbPut('sections', updated);
      await addToSyncQueue('UPDATE_SECTION', { id: sectionId, changes: { name } });
      setSections(currentSections.map(section => String(section.id) === String(sectionId) ? updated : section));
      renderTodos();
      if (isOnlineForSync()) await syncWithServer();
      return updated;
    },
    async deleteSection(id) {
      const sectionId = resolveSectionId(id);
      const currentSections = getSections();
      if (!currentSections.some(section => String(section.id) === String(sectionId))) return null;
      const previousTodos = getTodos();
      const now = new Date().toISOString();
      const nextTodos = previousTodos.map(todo => String(todo.section_id) === String(sectionId)
        ? { ...todo, section_id: null, updated_at: now }
        : todo);
      await deleteFromDB('sections', sectionId);
      for (const todo of nextTodos) {
        const previous = previousTodos.find(candidate => String(candidate.id) === String(todo.id));
        if (todo.section_id === null && String(previous?.section_id) === String(sectionId)) await dbPut('todos', todo);
      }
      await addToSyncQueue('DELETE_SECTION', { id: sectionId });
      setSections(currentSections.filter(section => String(section.id) !== String(sectionId)));
      setTodos(nextTodos);
      renderTodos();
      if (isOnlineForSync()) await syncWithServer();
      return { id: sectionId };
    },
  };

  const controller = createSectionController({
    registry: sectionRegistry,
    confirmDanger,
    labels: {
      namePlaceholder: () => t('section.namePlaceholder'),
      save: () => t('common.save'),
      cancel: () => t('common.cancel'),
      deleteTitle: () => t('section.deleteTitle'),
      deleteMessage: () => t('section.deleteMessage'),
      deleteConfirm: () => t('section.deleteConfirm'),
    },
  });

  let registeredRoot = null;
  function registerRoot() {
    const nextRoot = adapter.getRoot();
    if (!nextRoot || nextRoot === registeredRoot) return;
    if (registeredRoot) sectionRegistry.unregister(registeredRoot);
    nextRoot.dataset.sectionRoot = 'tasks';
    sectionRegistry.register(nextRoot, adapter);
    registeredRoot = nextRoot;
  }

  function bindSectionActions() {
    registerRoot();
    controller.bind();
  }

  return {
    renderSectionHeader: sectionsFeature.renderSectionHeader,
    bindSectionActions,
    registerRoot,
    adapter,
  };
}
