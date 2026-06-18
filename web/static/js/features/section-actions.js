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

  function resolveSectionId(id) {
    const section = getSections().find(s => String(s.id) === String(id));
    return section ? section.id : id;
  }

  async function saveSectionEdit(id) {
    const sectionId = resolveSectionId(id);
    const editInput = document.getElementById(`edit-section-name-${id}`)
      || Array.from(document.querySelectorAll('[data-section-input="edit"][data-section-id]')).find(input => String(input.dataset.sectionId) === String(id));
    const name = editInput?.value?.trim();
    if (!name) return;

    const sections = getSections();
    const section = sections.find(s => String(s.id) === String(sectionId));
    if (!section) return;

    const updated = { ...section, name, updated_at: new Date().toISOString() };
    await dbPut('sections', updated);
    setSections(sections.map(s => String(s.id) === String(sectionId) ? updated : s));
    renderTodos();

    await addToSyncQueue('UPDATE_SECTION', { id: sectionId, changes: { name } });
    if (isOnlineForSync()) await syncWithServer();
  }

  async function deleteSection(id) {
    const sectionId = resolveSectionId(id);
    const confirmed = await confirmDanger({
      title: t('section.deleteTitle'),
      message: t('section.deleteMessage'),
      confirmText: t('section.deleteConfirm'),
    });
    if (!confirmed) return;

    const sections = getSections();
    const section = sections.find(s => String(s.id) === String(sectionId));
    if (!section) return;

    setSections(sections.filter(s => String(s.id) !== String(sectionId)));
    await deleteFromDB('sections', sectionId);

    const previousTodos = getTodos();
    const nextTodos = previousTodos.map(todo => {
      if (String(todo.section_id) !== String(sectionId)) return todo;
      return { ...todo, section_id: null, updated_at: new Date().toISOString() };
    });
    for (const todo of nextTodos) {
      if (todo.section_id === null && String(previousTodos.find(t => t.id === todo.id)?.section_id) === String(sectionId)) {
        await dbPut('todos', todo);
      }
    }
    setTodos(nextTodos);
    renderTodos();

    await addToSyncQueue('DELETE_SECTION', { id: sectionId });
    if (isOnlineForSync()) await syncWithServer();
  }

  let sectionActionsBound = false;
  function bindSectionActions() {
    if (sectionActionsBound) return;
    sectionActionsBound = true;

    document.addEventListener('click', async (event) => {
      const target = event.target?.closest?.('[data-section-action]');
      if (!target) return;
      const action = target.dataset.sectionAction;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'show-add') sectionsFeature.showAddSectionForm();
      else if (action === 'edit') sectionsFeature.editSectionInline(resolveSectionId(target.dataset.sectionId));
      else if (action === 'delete') await deleteSection(target.dataset.sectionId);
      else if (action === 'save-new') await saveNewSection();
      else if (action === 'save-edit') await saveSectionEdit(target.dataset.sectionId);
      else if (action === 'cancel') renderTodos();
    });

    document.addEventListener('keydown', async (event) => {
      const input = event.target?.closest?.('[data-section-input]');
      if (!input || (event.key !== 'Enter' && event.key !== 'Escape')) return;
      event.preventDefault();
      if (event.key === 'Escape') {
        renderTodos();
        return;
      }
      if (input.dataset.sectionInput === 'new') await saveNewSection();
      else if (input.dataset.sectionInput === 'edit') await saveSectionEdit(input.dataset.sectionId);
    });
  }

  return {
    renderSectionHeader: sectionsFeature.renderSectionHeader,
    bindSectionActions,
  };
}
