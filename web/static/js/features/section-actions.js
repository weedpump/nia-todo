import { createCompletedCleanupController, createSectionController } from './section-ui.js';
import { t } from '../i18n/index.js';
import { resolveKnownTodoTargets } from './todo-targets.js';
import { mergeRoutingFeedback } from './routing-memory-matcher.js';

export function createSectionActionsFeature({
  routingMemory = null,
  getTodos,
  setTodos,
  getProjects,
  getSections,
  setSections,
  getCurrentProjectId,
  dbPut,
  dbGetAll,
  deleteFromDB,
  addToSyncQueue,
  runSyncQueueMutation,
  isOnlineForSync,
  syncWithServer,
  renderTodos,
  renderProjects,
  confirmDanger,
  completedCount = () => 0,
  clearCompleted = async () => null,
  onCompletedEmpty = () => {},
  onCompletedSuccess = () => {},
  onCompletedError = () => {},
  completedLabels = {},
  sectionsFeature,
  sectionRegistry,
}) {
  const commitQueuedMutation = runSyncQueueMutation || (operation => operation(addToSyncQueue));

  function resolveSectionId(id) {
    const section = getSections().find(candidate => String(candidate.id) === String(id));
    return section ? section.id : id;
  }

  async function moveTodoToSection(todoId, sectionId) {
    const isTempTodo = await commitQueuedMutation(async enqueue => {
      const todos = getTodos();
      const todo = todos.find(candidate => String(candidate.id) === String(todoId));
      if (!todo || (todo.section_id == null && sectionId == null) || String(todo.section_id) === String(sectionId)) return null;
      const target = resolveKnownTodoTargets({ projectId: todo.project_id, sectionId,
        projects: getProjects?.() || [], sections: getSections() });
      if (!target) return null;
      sectionId = target.section_id;
      const updatedTodo = { ...todo, section_id: sectionId, updated_at: new Date().toISOString() };
      const nextTodos = todos.map(candidate => String(candidate.id) === String(todoId) ? updatedTodo : candidate);
      const tempTodo = String(todo.id).startsWith('temp-');
      setTodos(nextTodos);
      if (dbPut) await dbPut('todos', updatedTodo);
      if (tempTodo && dbGetAll && dbPut) {
        const queue = await dbGetAll('syncQueue');
        const createItem = queue.find(item => item.action === 'CREATE_TODO' && String(item.data?._tempId) === String(todo.id));
        if (createItem && !createItem.attempted) {
          const feedback = mergeRoutingFeedback(createItem.data.routing_feedback, routingMemory?.feedback(['section']));
          await dbPut('syncQueue', { ...createItem, data: { ...createItem.data, section_id: sectionId, ...(feedback ? { routing_feedback: feedback } : {}) } });
        } else {
          const feedback = routingMemory?.feedback(['section']);
          await enqueue('UPDATE_TODO', { id: todo.id, changes: { section_id: sectionId, ...(feedback ? { routing_feedback: feedback } : {}) } });
        }
      } else {
        const feedback = routingMemory?.feedback(['section']);
        await enqueue('UPDATE_TODO', { id: todo.id, changes: { section_id: sectionId, ...(feedback ? { routing_feedback: feedback } : {}) } });
      }
      return { item: updatedTodo, temporary: tempTodo };
    });
    if (!isTempTodo) return null;
    renderTodos();
    if (!isTempTodo.temporary && isOnlineForSync()) await syncWithServer?.();
    return isTempTodo.item;
  }

  async function moveTodoToProject(todoId, projectId) {
    const result = await commitQueuedMutation(async enqueue => {
      const todos = getTodos();
      const todo = todos.find(candidate => String(candidate.id) === String(todoId));
      const project = (getProjects?.() || []).find(candidate => String(candidate.id) === String(projectId));
      if (!todo || !project) return null;
      const target = resolveKnownTodoTargets({ projectId: project.id, projects: getProjects?.() || [] });
      if (!target) return null;
      const newProjectId = target.project_id;
      if (String(todo.project_id) === String(newProjectId) && todo.section_id === null) return null;
      const updatedTodo = { ...todo, project_id: newProjectId, section_id: null, updated_at: new Date().toISOString() };
      const nextTodos = todos.map(candidate => String(candidate.id) === String(todoId) ? updatedTodo : candidate);
      const temporary = String(todo.id).startsWith('temp-');
      const changes = { project_id: newProjectId, section_id: null };
      const feedback = routingMemory?.feedback(['list', 'section']);
      setTodos(nextTodos);
      if (dbPut) await dbPut('todos', updatedTodo);
      if (temporary && dbGetAll && dbPut) {
        const queue = await dbGetAll('syncQueue');
        const createItem = queue.find(item => item.action === 'CREATE_TODO' && String(item.data?._tempId) === String(todo.id));
        if (createItem && !createItem.attempted) {
          const merged = mergeRoutingFeedback(createItem.data.routing_feedback, feedback);
          await dbPut('syncQueue', { ...createItem, data: { ...createItem.data, ...changes, ...(merged ? { routing_feedback: merged } : {}) } });
        } else {
          await enqueue('UPDATE_TODO', { id: todo.id, changes: { ...changes, ...(feedback ? { routing_feedback: feedback } : {}) } });
        }
      } else {
        await enqueue('UPDATE_TODO', { id: todo.id, changes: { ...changes, ...(feedback ? { routing_feedback: feedback } : {}) } });
      }
      return { item: updatedTodo, temporary };
    });
    if (!result) return null;
    renderTodos();
    renderProjects?.();
    if (!result.temporary && isOnlineForSync()) await syncWithServer?.();
    return result.item;
  }

  const itemDrag = {
    canDrag: () => true,
    keyFromElement: element => element?.dataset?.id,
    resolveSectionId,
    moveToSection: moveTodoToSection,
    moveToProject: moveTodoToProject,
    focusItem(id) {
      const item = Array.from(adapter.getRoot()?.querySelectorAll?.('.todo-item[data-id]') || [])
        .find(candidate => String(candidate.dataset.id) === String(id));
      item?.querySelector?.('.todo-body')?.focus?.();
    },
  };

  const adapter = {
    getRoot: () => document.getElementById('todo-list'),
    labels: completedLabels,
    getSections,
    canManage: () => Boolean(getCurrentProjectId()),
    completedCount,
    clearCompleted,
    onCompletedEmpty,
    onCompletedSuccess,
    onError: (error, context) => {
      if (context?.action === 'clear-completed') onCompletedError(error);
    },
    newInputId: () => 'new-section-name',
    editInputId: id => `edit-section-name-${id}`,
    resolveSectionId,
    itemDrag,
    render: renderTodos,
    async createSection(name) {
      const section = await commitQueuedMutation(async enqueue => {
        const currentProjectId = getCurrentProjectId();
        const project = (getProjects?.() || []).find(candidate => String(candidate.id) === String(currentProjectId));
        if (!name || !project) return null;
        const currentSections = getSections();
        const now = new Date().toISOString();
        const tempId = `temp-section-${Date.now()}`;
        const nextSection = {
          id: tempId,
          name,
          project_id: project.id,
          sort_order: currentSections.length,
          created_at: now,
          updated_at: now,
        };
        await dbPut('sections', nextSection);
        await enqueue('CREATE_SECTION', { ...nextSection, _tempId: tempId });
        setSections([...currentSections, nextSection]);
        renderTodos();
        return nextSection;
      });
      if (section && isOnlineForSync()) await syncWithServer();
      return section;
    },
    async renameSection(id, name) {
      const updated = await commitQueuedMutation(async enqueue => {
        const sectionId = resolveSectionId(id);
        const currentSections = getSections();
        const current = currentSections.find(section => String(section.id) === String(sectionId));
        const project = (getProjects?.() || []).find(candidate => String(candidate.id) === String(current?.project_id));
        if (!current || !project || !name) return null;
        const nextSection = { ...current, name, updated_at: new Date().toISOString() };
        await dbPut('sections', nextSection);
        await enqueue('UPDATE_SECTION', { id: sectionId, changes: { name } });
        setSections(currentSections.map(section => String(section.id) === String(sectionId) ? nextSection : section));
        renderTodos();
        return nextSection;
      });
      if (updated && isOnlineForSync()) await syncWithServer();
      return updated;
    },
    async deleteSection(id) {
      const result = await commitQueuedMutation(async enqueue => {
        const sectionId = resolveSectionId(id);
        const currentSections = getSections();
        const current = currentSections.find(section => String(section.id) === String(sectionId));
        const project = (getProjects?.() || []).find(candidate => String(candidate.id) === String(current?.project_id));
        if (!current || !project) return null;
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
        await enqueue('DELETE_SECTION', { id: sectionId });
        setSections(currentSections.filter(section => String(section.id) !== String(sectionId)));
        setTodos(nextTodos);
        renderTodos();
        return { id: sectionId };
      });
      if (result && isOnlineForSync()) await syncWithServer();
      return result;
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
  const completedCleanupController = createCompletedCleanupController({
    registry: sectionRegistry,
    confirmDanger,
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
    completedCleanupController.bind();
  }

  return {
    renderSectionHeader: sectionsFeature.renderSectionHeader,
    bindSectionActions,
    registerRoot,
    adapter,
  };
}
