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

  function handleTodoDragStart(e) {
    dragSrcTodoId = parseInt(e.target.dataset.id);
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
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const container = e.target.closest('.section-todos');
    if (container) container.classList.add('drag-over');
  }

  async function moveTodoToSection(todoId, sectionId) {
    const todos = getTodos();
    const todo = todos.find(t => t.id === todoId);
    if (!todo || todo.section_id === sectionId) return false;

    const nextTodos = todos.map(t => t.id === todoId ? { ...t, section_id: sectionId } : t);
    setTodos(nextTodos);
    renderTodos();

    if (isOnlineForSync()) {
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

  function handleSectionDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.section-header.drag-over').forEach(el => el.classList.remove('drag-over'));
    dragSrcSectionId = null;
  }

  function handleSectionDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const header = e.target.closest('.section-header');
    if (header) header.classList.add('drag-over');
  }

  async function handleSectionDrop(e) {
    e.preventDefault();
    const header = e.target.closest('.section-header');
    if (!header) return;
    header.classList.remove('drag-over');

    const targetSectionId = header.dataset.sectionId;

    if (dragSrcTodoId) {
      const newSectionId = targetSectionId === 'null' ? null : parseInt(targetSectionId);
      await moveTodoToSection(dragSrcTodoId, newSectionId);
      return;
    }

    if (targetSectionId === 'null' || !dragSrcSectionId || dragSrcSectionId === parseInt(targetSectionId)) return;

    const sections = [...getSections()];
    const srcIdx = sections.findIndex(s => s.id === dragSrcSectionId);
    const targetIdx = sections.findIndex(s => s.id === parseInt(targetSectionId));
    if (srcIdx === -1 || targetIdx === -1) return;

    const [moved] = sections.splice(srcIdx, 1);
    sections.splice(targetIdx, 0, moved);

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
