export function createDragDropFeature({
  getTodos,
  setTodos,
  getSections,
  setSections,
  isOnlineForSync,
  todosApi,
  sectionsApi,
  renderTodos,
}) {
  let dragSrcTodoId = null;
  let dragSrcSectionId = null;
  let currentSectionDropIndex = null;

  function handleTodoDragStart(e) {
    const rawId = e.target.dataset.id;
    dragSrcTodoId = /^\d+$/.test(String(rawId)) ? parseInt(rawId) : rawId;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'todo:' + dragSrcTodoId);
  }

  function handleTodoDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.section-todos.drag-over, .section-header.drag-over').forEach(el => {
      el.classList.remove('drag-over');
    });
    dragSrcTodoId = null;
  }

  function handleTodoDragOver(e) {
    if (!dragSrcTodoId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const container = e.target.closest('.section-todos');
    if (container) container.classList.add('drag-over');
  }

  async function moveTodoToSection(todoId, sectionId) {
    const todos = getTodos();
    const todo = todos.find(t => String(t.id) === String(todoId));
    if (!todo || todo.section_id === sectionId) return false;

    const updatedTodo = { ...todo, section_id: sectionId, updated_at: new Date().toISOString() };
    const nextTodos = todos.map(t => String(t.id) === String(todoId) ? updatedTodo : t);
    setTodos(nextTodos);
    renderTodos();

    const isTempTodo = String(todo.id).startsWith('temp-');
    if (isOnlineForSync() && !isTempTodo) {
      try {
        await todosApi.update(todo.id, { section_id: sectionId });
      } catch (err) {
        console.error('Move todo failed', err);
      }
    }
    return true;
  }

  async function handleTodoDrop(e) {
    e.preventDefault();
    const container = e.target.closest('.section-todos');
    if (!container) return;
    container.classList.remove('drag-over');

    const targetSectionId = container.dataset.sectionId;
    if (!dragSrcTodoId) return;

    const newSectionId = targetSectionId === 'null' ? null : parseInt(targetSectionId);
    await moveTodoToSection(dragSrcTodoId, newSectionId);
  }

  function handleSectionDragStart(e) {
    dragSrcSectionId = parseInt(e.target.dataset.sectionId);
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'section:' + dragSrcSectionId);
  }

  function clearSectionDropIndicators() {
    document.querySelectorAll('.section-header.drag-over, .section-dropzone.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function handleSectionDragEnd(e) {
    e.target.classList.remove('dragging');
    clearSectionDropIndicators();
    dragSrcSectionId = null;
    currentSectionDropIndex = null;
  }

  function handleSectionDragOver(e) {
    if (!dragSrcSectionId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearSectionDropIndicators();
    const dropzone = e.target.closest('.section-dropzone');
    if (dropzone) {
      currentSectionDropIndex = parseInt(dropzone.dataset.dropIndex, 10);
      dropzone.classList.add('drag-over');
      return;
    }
    const header = e.target.closest('.section-header');
    if (header) header.classList.add('drag-over');
  }

  async function persistSectionOrder(sections) {
    for (let i = 0; i < sections.length; i++) {
      sections[i] = { ...sections[i], sort_order: i };
      if (isOnlineForSync()) {
        try {
          await sectionsApi.update(sections[i].id, { sort_order: i });
        } catch (err) {
          console.error('Sort section failed', err);
        }
      }
    }

    setSections(sections);
    renderTodos();
  }

  async function handleSectionDrop(e) {
    e.preventDefault();

    const header = e.target.closest('.section-header');
    const dropzone = e.target.closest('.section-dropzone');
    if (header) header.classList.remove('drag-over');
    if (dropzone) dropzone.classList.remove('drag-over');

    const targetSectionId = header?.dataset.sectionId;

    if (dragSrcTodoId && header) {
      const newSectionId = targetSectionId === 'null' ? null : parseInt(targetSectionId);
      await moveTodoToSection(dragSrcTodoId, newSectionId);
      return;
    }

    if (!dragSrcSectionId) return;

    const sections = [...getSections()];
    const srcIdx = sections.findIndex(s => s.id === dragSrcSectionId);
    if (srcIdx === -1) return;

    if (dropzone) {
      const rawIndex = parseInt(dropzone.dataset.dropIndex, 10);
      if (Number.isNaN(rawIndex)) return;
      const [moved] = sections.splice(srcIdx, 1);
      const targetIdx = srcIdx < rawIndex ? rawIndex - 1 : rawIndex;
      sections.splice(targetIdx, 0, moved);
      await persistSectionOrder(sections);
      return;
    }

    if (targetSectionId === 'null' || !header || dragSrcSectionId === parseInt(targetSectionId)) return;

    const targetIdx = sections.findIndex(s => s.id === parseInt(targetSectionId));
    if (targetIdx === -1) return;

    const [moved] = sections.splice(srcIdx, 1);
    sections.splice(targetIdx, 0, moved);
    await persistSectionOrder(sections);
  }

  return {
    handleTodoDragStart,
    handleTodoDragEnd,
    handleTodoDragOver,
    handleTodoDrop,
    handleSectionDragStart,
    handleSectionDragEnd,
    handleSectionDragOver,
    handleSectionDrop,
  };
}
