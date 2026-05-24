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
}) {
  async function saveNewSection() {
    const name = document.getElementById('new-section-name')?.value?.trim();
    const currentProjectId = getCurrentProjectId();
    if (!name || !currentProjectId) return;

    const sections = getSections();
    const now = new Date().toISOString();
    const tempId = 'temp-section-' + Date.now();
    const sectionData = {
      id: tempId,
      name,
      project_id: currentProjectId,
      sort_order: sections.length,
      created_at: now,
      updated_at: now,
    };

    await dbPut('sections', sectionData);
    setSections([...sections, sectionData]);
    renderTodos();

    await addToSyncQueue('CREATE_SECTION', { ...sectionData, _tempId: tempId });
    if (isOnlineForSync()) await syncWithServer();
  }

  async function saveSectionEdit(id) {
    const name = document.getElementById(`edit-section-name-${id}`)?.value?.trim();
    if (!name) return;

    const sections = getSections();
    const section = sections.find(s => s.id === id);
    if (!section) return;

    const updated = { ...section, name, updated_at: new Date().toISOString() };
    await dbPut('sections', updated);
    setSections(sections.map(s => s.id === id ? updated : s));
    renderTodos();

    await addToSyncQueue('UPDATE_SECTION', { id, changes: { name } });
    if (isOnlineForSync()) await syncWithServer();
  }

  async function deleteSection(id) {
    const confirmed = await confirmDanger({
      title: t('section.deleteTitle'),
      message: t('section.deleteMessage'),
      confirmText: t('section.deleteConfirm'),
    });
    if (!confirmed) return;

    const sections = getSections();
    const section = sections.find(s => s.id === id);
    if (!section) return;

    setSections(sections.filter(s => s.id !== id));
    await deleteFromDB('sections', id);

    const nextTodos = getTodos().map(todo => {
      if (todo.section_id !== id) return todo;
      return { ...todo, section_id: null, updated_at: new Date().toISOString() };
    });
    for (const todo of nextTodos) {
      if (todo.section_id === null && getTodos().find(t => t.id === todo.id)?.section_id === id) {
        await dbPut('todos', todo);
      }
    }
    setTodos(nextTodos);
    renderTodos();

    await addToSyncQueue('DELETE_SECTION', { id });
    if (isOnlineForSync()) await syncWithServer();
  }

  return {
    renderSectionHeader: sectionsFeature.renderSectionHeader,
    showAddSectionForm: sectionsFeature.showAddSectionForm,
    editSectionInline: sectionsFeature.editSectionInline,
    saveNewSection,
    saveSectionEdit,
    deleteSection,
  };
}
