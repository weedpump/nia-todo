import { RUNTIME_CAPABILITIES } from '../core/config.js';

export function createDragDropFeature({
  getTodos,
  setTodos,
  getProjects,
  getSections,
  setSections,
  isOnlineForSync,
  todosApi,
  sectionsApi,
  renderTodos,
  renderProjects,
  dbGetAll,
  dbPut,
  addToSyncQueue,
}) {
  let dragSrcTodoId = null;
  let dragSrcSectionId = null;
  let currentSectionDropIndex = null;
  let pointerDrag = null;
  let nativeSummaryPointer = null;
  let standardDragAutoScroll = null;
  let suppressNextNativeClick = false;
  const TOUCH_LONG_PRESS_MS = 320;
  const TOUCH_SCROLL_CANCEL_PX = 10;
  const MOUSE_DRAG_THRESHOLD_PX = 8;
  const SUMMARY_TOGGLE_MOVE_THRESHOLD_PX = 8;
  const NATIVE_AUTO_SCROLL_EDGE_PX = 48;
  const NATIVE_AUTO_SCROLL_VIEWPORT_GAP_PX = 8;
  const NATIVE_AUTO_SCROLL_TOP_EDGE_PX = 48;
  const NATIVE_AUTO_SCROLL_TOPBAR_GAP_PX = 8;
  const NATIVE_AUTO_SCROLL_MAX_PX = 18;

  function eventDataTransfer(e) {
    return e.dataTransfer || { setData() {}, effectAllowed: 'move', dropEffect: 'move' };
  }

  function handleTodoDragStart(e) {
    const item = e.target?.closest?.('.todo-item[data-id]') || e.target;
    const rawId = item.dataset.id;
    dragSrcTodoId = /^\d+$/.test(String(rawId)) ? parseInt(rawId) : rawId;
    item.classList.add('dragging');
    const transfer = eventDataTransfer(e);
    transfer.effectAllowed = 'move';
    transfer.setData('text/plain', 'todo:' + dragSrcTodoId);
  }

  function handleTodoDragEnd(e) {
    stopStandardDragAutoScroll();
    const item = e.target?.closest?.('.todo-item[data-id]') || e.target;
    item.classList.remove('dragging');
    document.querySelectorAll('.section-todos.drag-over, .project-group-todos.drag-over, .section-header.drag-over, .project-drop-target.drag-over').forEach(el => {
      el.classList.remove('drag-over');
    });
    dragSrcTodoId = null;
  }

  function clearTodoDropIndicators() {
    document.querySelectorAll('.section-todos.drag-over, .project-group-todos.drag-over, .section-header.drag-over, .project-drop-target.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function handleTodoDragOver(e) {
    if (!dragSrcTodoId) return;
    e.preventDefault();
    eventDataTransfer(e).dropEffect = 'move';
    scheduleStandardDragAutoScroll(e);
    clearTodoDropIndicators();
    const container = e.target.closest('.section-todos, .project-group-todos');
    const header = e.target.closest('.section-header');
    if (container) container.classList.add('drag-over');
    else if (header) header.classList.add('drag-over');
  }

  async function moveTodoToSection(todoId, sectionId) {
    const todos = getTodos();
    const todo = todos.find(t => String(t.id) === String(todoId));
    if (!todo || todo.section_id === sectionId) return false;

    const updatedTodo = { ...todo, section_id: sectionId, updated_at: new Date().toISOString() };
    const nextTodos = todos.map(t => String(t.id) === String(todoId) ? updatedTodo : t);
    setTodos(nextTodos);
    renderTodos();

    if (dbPut) await dbPut('todos', updatedTodo);

    const isTempTodo = String(todo.id).startsWith('temp-');
    if (isTempTodo && dbGetAll && dbPut) {
      const queue = await dbGetAll('syncQueue');
      const createItem = queue.find(item => item.action === 'CREATE_TODO' && String(item.data?._tempId) === String(todo.id));
      if (createItem) {
        await dbPut('syncQueue', { ...createItem, data: { ...createItem.data, section_id: sectionId } });
      }
    }

    if (!isTempTodo) {
      if (isOnlineForSync()) {
        try {
          await todosApi.update(todo.id, { section_id: sectionId });
        } catch (err) {
          console.error('Move todo failed', err);
        }
      } else if (addToSyncQueue) {
        await addToSyncQueue('UPDATE_TODO', { id: todo.id, changes: { section_id: sectionId } });
      }
    }
    return true;
  }

  async function moveTodoToProject(todoId, projectId) {
    const todos = getTodos();
    const todo = todos.find(t => String(t.id) === String(todoId));
    const project = (getProjects?.() || []).find(p => String(p.id) === String(projectId));
    if (!todo || !project) return false;

    const newProjectId = Number(project.id);
    const changed = Number(todo.project_id) !== newProjectId || todo.section_id !== null;
    if (!changed) return false;

    // Dropping onto a project means: move to that project, into its unsectioned bucket.
    const updatedTodo = { ...todo, project_id: newProjectId, section_id: null, updated_at: new Date().toISOString() };
    const nextTodos = todos.map(t => String(t.id) === String(todoId) ? updatedTodo : t);
    setTodos(nextTodos);
    renderTodos();
    renderProjects?.();

    if (dbPut) await dbPut('todos', updatedTodo);

    const isTempTodo = String(todo.id).startsWith('temp-');
    if (isTempTodo && dbGetAll && dbPut) {
      const queue = await dbGetAll('syncQueue');
      const createItem = queue.find(item => item.action === 'CREATE_TODO' && String(item.data?._tempId) === String(todo.id));
      if (createItem) {
        await dbPut('syncQueue', { ...createItem, data: { ...createItem.data, project_id: newProjectId, section_id: null } });
      }
    }

    if (!isTempTodo) {
      const changes = { project_id: newProjectId, section_id: null };
      if (isOnlineForSync()) {
        try {
          await todosApi.update(todo.id, changes);
        } catch (err) {
          console.error('Move todo to project failed', err);
        }
      } else if (addToSyncQueue) {
        await addToSyncQueue('UPDATE_TODO', { id: todo.id, changes });
      }
    }
    return true;
  }

  async function handleTodoDrop(e) {
    e.preventDefault();
    stopStandardDragAutoScroll();
    const container = e.target.closest('.section-todos');
    if (!container) return;
    container.classList.remove('drag-over');

    const targetSectionId = container.dataset.sectionId;
    if (!dragSrcTodoId) return;

    const newSectionId = targetSectionId === 'null' ? null : parseInt(targetSectionId);
    await moveTodoToSection(dragSrcTodoId, newSectionId);
  }

  function projectDropEnabled() {
    return window.matchMedia?.('(min-width: 769px)').matches ?? true;
  }

  function handleProjectDragOver(e) {
    if (!dragSrcTodoId || !projectDropEnabled()) return;
    const target = e.target.closest('.project-drop-target[data-project-id]');
    if (!target) return;
    e.preventDefault();
    eventDataTransfer(e).dropEffect = 'move';
    scheduleStandardDragAutoScroll(e);
    clearTodoDropIndicators();
    target.classList.add('drag-over');
  }

  async function handleProjectDrop(e) {
    if (!dragSrcTodoId || !projectDropEnabled()) return;
    const target = e.target.closest('.project-drop-target[data-project-id]');
    if (!target) return;
    e.preventDefault();
    stopStandardDragAutoScroll();
    target.classList.remove('drag-over');
    await moveTodoToProject(dragSrcTodoId, target.dataset.projectId);
  }

  function handleSectionDragStart(e) {
    const section = e.target?.closest?.('.section-header[data-section-id]') || e.target;
    dragSrcSectionId = parseInt(section.dataset.sectionId);
    section.classList.add('dragging');
    const transfer = eventDataTransfer(e);
    transfer.effectAllowed = 'move';
    transfer.setData('text/plain', 'section:' + dragSrcSectionId);
  }

  function clearSectionDropIndicators() {
    document.querySelectorAll('.section-header.drag-over, .section-dropzone.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function handleSectionDragEnd(e) {
    stopStandardDragAutoScroll();
    const section = e.target?.closest?.('.section-header[data-section-id]') || e.target;
    section.classList.remove('dragging');
    clearSectionDropIndicators();
    dragSrcSectionId = null;
    currentSectionDropIndex = null;
  }

  function handleSectionDragOver(e) {
    if (!dragSrcSectionId) return;
    e.preventDefault();
    eventDataTransfer(e).dropEffect = 'move';
    scheduleStandardDragAutoScroll(e);
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

  async function moveSectionToDropTarget(header, dropzone) {
    if (!dragSrcSectionId) return false;
    const sections = [...getSections()];
    const srcIdx = sections.findIndex(s => s.id === dragSrcSectionId);
    if (srcIdx === -1) return false;

    if (dropzone) {
      const rawIndex = parseInt(dropzone.dataset.dropIndex, 10);
      if (Number.isNaN(rawIndex)) return false;
      const [moved] = sections.splice(srcIdx, 1);
      const targetIdx = srcIdx < rawIndex ? rawIndex - 1 : rawIndex;
      sections.splice(Math.max(0, Math.min(targetIdx, sections.length)), 0, moved);
      await persistSectionOrder(sections);
      return true;
    }

    const targetSectionId = header?.dataset.sectionId;
    if (targetSectionId === 'null' || !header || dragSrcSectionId === parseInt(targetSectionId)) return false;

    const targetIdx = sections.findIndex(s => s.id === parseInt(targetSectionId));
    if (targetIdx === -1) return false;

    const [moved] = sections.splice(srcIdx, 1);
    sections.splice(targetIdx, 0, moved);
    await persistSectionOrder(sections);
    return true;
  }

  async function handleSectionDrop(e) {
    e.preventDefault();
    stopStandardDragAutoScroll();

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

    await moveSectionToDropTarget(header, dropzone);
  }

  let standardDragDropBound = false;
  function bindStandardDragDrop() {
    if (standardDragDropBound) return;
    standardDragDropBound = true;

    document.addEventListener('dragstart', (event) => {
      const todo = event.target?.closest?.('.todo-item[data-id][draggable="true"]');
      if (todo) {
        handleTodoDragStart(event);
        return;
      }
      const section = event.target?.closest?.('.section-header[data-section-id]:not(.section-unsorted)[draggable="true"]');
      if (section) handleSectionDragStart(event);
    });

    document.addEventListener('dragend', (event) => {
      const todo = event.target?.closest?.('.todo-item[data-id]');
      if (todo) {
        handleTodoDragEnd(event);
        return;
      }
      const section = event.target?.closest?.('.section-header[data-section-id]:not(.section-unsorted)');
      if (section) handleSectionDragEnd(event);
    });

    document.addEventListener('dragover', (event) => {
      if (event.target?.closest?.('.project-drop-target[data-project-id]')) {
        handleProjectDragOver(event);
        return;
      }
      if (event.target?.closest?.('.section-dropzone, .section-header[data-section-id]')) {
        handleSectionDragOver(event);
        handleTodoDragOver(event);
        return;
      }
      if (event.target?.closest?.('.section-todos[data-section-id], .project-group-todos')) handleTodoDragOver(event);
    });

    document.addEventListener('drop', async (event) => {
      if (event.target?.closest?.('.project-drop-target[data-project-id]')) {
        await handleProjectDrop(event);
        return;
      }
      if (event.target?.closest?.('.section-dropzone, .section-header[data-section-id]')) {
        await handleSectionDrop(event);
        return;
      }
      if (event.target?.closest?.('.section-todos[data-section-id]')) await handleTodoDrop(event);
    });
  }

  function clearNativeDragIndicators() {
    document.querySelectorAll('.section-todos.drag-over, .project-group-todos.drag-over, .section-header.drag-over, .section-dropzone.drag-over, .project-drop-target.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function nativeDragElementFromPoint(x, y) {
    const ghost = pointerDrag?.ghost;
    if (ghost) ghost.style.display = 'none';
    const element = document.elementFromPoint(x, y);
    if (ghost) ghost.style.display = '';
    return element;
  }

  function updateNativeDropTarget(x, y) {
    clearNativeDragIndicators();
    const element = nativeDragElementFromPoint(x, y);
    if (!element) return null;
    if (pointerDrag?.type === 'todo') {
      const sectionTodos = element.closest('.section-todos');
      const sectionHeader = element.closest('.section-header');
      const projectTarget = projectDropEnabled() ? element.closest('.project-drop-target[data-project-id]') : null;
      if (sectionTodos) {
        sectionTodos.classList.add('drag-over');
        return { sectionTodos };
      }
      if (sectionHeader) {
        sectionHeader.classList.add('drag-over');
        return { sectionHeader };
      }
      if (projectTarget) {
        projectTarget.classList.add('drag-over');
        return { projectTarget };
      }
      return null;
    }
    const dropzone = element.closest('.section-dropzone');
    if (dropzone) {
      dropzone.classList.add('drag-over');
      return { dropzone };
    }
    const sectionHeader = element.closest('.section-header:not(.section-unsorted)');
    if (sectionHeader) {
      sectionHeader.classList.add('drag-over');
      return { sectionHeader };
    }
    return null;
  }

  function createNativeGhost(source) {
    const rect = source.getBoundingClientRect();
    const ghost = source.cloneNode(true);
    ghost.classList.add('native-drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);
    return ghost;
  }

  function moveNativeGhost(event) {
    if (!pointerDrag?.ghost) return;
    pointerDrag.ghost.style.transform = `translate3d(${event.clientX - pointerDrag.startX}px, ${event.clientY - pointerDrag.startY}px, 0)`;
  }

  function nativeDragEventFromLastPosition() {
    if (!pointerDrag) return null;
    return { clientX: pointerDrag.lastX, clientY: pointerDrag.lastY };
  }

  function rememberNativeDragTouch(touch) {
    if (!pointerDrag?.isTouch || !touch) return;
    if (pointerDrag.touchIdentifier === null || pointerDrag.touchIdentifier === undefined) {
      pointerDrag.touchIdentifier = touch.identifier;
    }
  }

  function closestTouchForDrag(touches) {
    if (!pointerDrag?.isTouch) return null;
    const list = Array.from(touches || []);
    if (!list.length) return null;
    if (pointerDrag.touchIdentifier !== null && pointerDrag.touchIdentifier !== undefined) {
      return list.find((touch) => touch.identifier === pointerDrag.touchIdentifier) || null;
    }
    return list.reduce((best, touch) => {
      const bestDistance = Math.hypot(best.clientX - pointerDrag.lastX, best.clientY - pointerDrag.lastY);
      const distance = Math.hypot(touch.clientX - pointerDrag.lastX, touch.clientY - pointerDrag.lastY);
      return distance < bestDistance ? touch : best;
    }, list[0]);
  }

  function activeTouchForDrag(event) {
    const touch = closestTouchForDrag(event.touches);
    rememberNativeDragTouch(touch);
    return touch;
  }

  function changedTouchForDrag(event) {
    const touch = closestTouchForDrag(event.changedTouches);
    rememberNativeDragTouch(touch);
    return touch;
  }

  function dragEventFromTouch(touch) {
    return { clientX: touch.clientX, clientY: touch.clientY };
  }

  function scrollContainerFromElement(source) {
    let element = source?.closest?.('.main, .modal-body, .todo-list, [data-scroll-container]') || source?.parentElement || null;
    while (element && element !== document.body && element !== document.documentElement) {
      const style = getComputedStyle(element);
      const canScroll = element.scrollHeight > element.clientHeight + 1;
      const overflowY = style.overflowY || style.overflow;
      if (canScroll && /(auto|scroll|overlay)/.test(overflowY)) return element;
      element = element.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function nativeScrollContainer() {
    return scrollContainerFromElement(pointerDrag?.source);
  }

  function nativeAutoScrollTopBoundary(containerRect) {
    const topbar = document.querySelector('.topbar');
    const topbarRect = topbar?.getBoundingClientRect?.();
    if (!topbarRect?.bottom) return containerRect.top;
    return Math.max(containerRect.top, topbarRect.bottom + NATIVE_AUTO_SCROLL_TOPBAR_GAP_PX);
  }

  function autoScrollDelta(clientY, container, topTriggerY = clientY, bottomTriggerY = clientY) {
    const isDocument = container === document.scrollingElement || container === document.documentElement;
    const rect = isDocument
      ? { top: 0, bottom: window.innerHeight || document.documentElement.clientHeight || 0 }
      : container.getBoundingClientRect();
    if (!rect.bottom) return 0;
    const topBoundary = nativeAutoScrollTopBoundary(rect);
    const topEdgeBottom = topBoundary + NATIVE_AUTO_SCROLL_TOP_EDGE_PX;
    if (topTriggerY < topEdgeBottom) {
      return -Math.ceil(((topEdgeBottom - topTriggerY) / NATIVE_AUTO_SCROLL_TOP_EDGE_PX) * NATIVE_AUTO_SCROLL_MAX_PX);
    }
    const bottomEdgeTop = rect.bottom - NATIVE_AUTO_SCROLL_VIEWPORT_GAP_PX - NATIVE_AUTO_SCROLL_EDGE_PX;
    if (bottomTriggerY > bottomEdgeTop) {
      return Math.ceil(((bottomTriggerY - bottomEdgeTop) / NATIVE_AUTO_SCROLL_EDGE_PX) * NATIVE_AUTO_SCROLL_MAX_PX);
    }
    return 0;
  }

  function nativeAutoScrollDelta(clientY, container = nativeScrollContainer()) {
    const ghostRect = pointerDrag?.ghost?.getBoundingClientRect?.() || null;
    return autoScrollDelta(clientY, container, ghostRect?.top ?? clientY, ghostRect?.bottom ?? clientY);
  }

  function readScrollTop(container) {
    return container === document.scrollingElement || container === document.documentElement
      ? (window.scrollY || document.documentElement.scrollTop || 0)
      : container.scrollTop;
  }

  function applyScrollDelta(container, deltaY) {
    if (container === document.scrollingElement || container === document.documentElement) {
      window.scrollBy({ top: deltaY, left: 0, behavior: 'auto' });
    } else {
      container.scrollTop += deltaY;
    }
  }

  function stopStandardDragAutoScroll() {
    if (standardDragAutoScroll?.raf) cancelAnimationFrame(standardDragAutoScroll.raf);
    standardDragAutoScroll = null;
  }

  function runStandardDragAutoScroll() {
    if (!standardDragAutoScroll) return;
    const state = standardDragAutoScroll;
    const deltaY = Math.min(0, autoScrollDelta(state.clientY, state.container, state.clientY));
    if (deltaY) applyScrollDelta(state.container, deltaY);
    state.raf = requestAnimationFrame(runStandardDragAutoScroll);
  }

  function scheduleStandardDragAutoScroll(event) {
    if (!event || typeof event.clientY !== 'number') return;
    const container = scrollContainerFromElement(event.target);
    standardDragAutoScroll = {
      container,
      clientY: event.clientY,
      raf: standardDragAutoScroll?.raf || null,
    };
    if (!standardDragAutoScroll.raf) standardDragAutoScroll.raf = requestAnimationFrame(runStandardDragAutoScroll);
  }

  function stopNativeAutoScroll() {
    if (!pointerDrag?.autoScrollRaf) return;
    cancelAnimationFrame(pointerDrag.autoScrollRaf);
    pointerDrag.autoScrollRaf = null;
  }

  function runNativeAutoScroll() {
    if (!pointerDrag?.active) return;
    const container = nativeScrollContainer();
    const deltaY = nativeAutoScrollDelta(pointerDrag.lastY, container);
    if (deltaY) {
      const before = readScrollTop(container);
      applyScrollDelta(container, deltaY);
      const after = readScrollTop(container);
      if (after !== before) updateNativeDropTarget(pointerDrag.lastX, pointerDrag.lastY);
    }
    pointerDrag.autoScrollRaf = requestAnimationFrame(runNativeAutoScroll);
  }

  function scheduleNativeAutoScroll() {
    if (!pointerDrag?.active) return;
    if (pointerDrag.autoScrollRaf) return;
    pointerDrag.autoScrollRaf = requestAnimationFrame(runNativeAutoScroll);
  }

  function startNativePointerDrag(event, source, type, id) {
    const isTouch = event.pointerType === 'touch' || event.pointerType === 'pen';
    try { window.getSelection?.()?.removeAllRanges?.(); } catch (_error) {}
    pointerDrag = {
      pointerId: event.pointerId,
      source,
      type,
      id,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      isTouch,
      longPressReady: !isTouch,
      active: false,
      ghost: null,
      longPressTimer: null,
      ignoreCancelUntilMs: 0,
      autoScrollRaf: null,
      touchIdentifier: null,
    };
    if (isTouch) {
      pointerDrag.longPressTimer = window.setTimeout(() => {
        if (!pointerDrag || pointerDrag.pointerId !== event.pointerId || pointerDrag.active) return;
        pointerDrag.longPressReady = true;
        activateNativePointerDrag({ ...event, clientX: pointerDrag.lastX, clientY: pointerDrag.lastY });
      }, TOUCH_LONG_PRESS_MS);
    }
  }

  function cancelNativePointerDrag() {
    if (!pointerDrag) return;
    if (pointerDrag.longPressTimer) window.clearTimeout(pointerDrag.longPressTimer);
    stopNativeAutoScroll();
    pointerDrag.ghost?.remove();
    pointerDrag.source?.classList?.remove('dragging');
    document.body.classList.remove('native-pointer-dragging');
    clearNativeDragIndicators();
    pointerDrag = null;
    dragSrcTodoId = null;
    dragSrcSectionId = null;
  }

  function activateNativePointerDrag(event) {
    if (!pointerDrag || pointerDrag.active || !pointerDrag.longPressReady) return;
    if (pointerDrag.longPressTimer) {
      window.clearTimeout(pointerDrag.longPressTimer);
      pointerDrag.longPressTimer = null;
    }
    pointerDrag.active = true;
    pointerDrag.ignoreCancelUntilMs = Date.now() + 900;
    try { pointerDrag.source.setPointerCapture?.(pointerDrag.pointerId); } catch (_error) {}
    suppressNextNativeClick = true;
    try { window.getSelection?.()?.removeAllRanges?.(); } catch (_error) {}
    document.body.classList.add('native-pointer-dragging');
    pointerDrag.source.classList.add('dragging');
    pointerDrag.ghost = createNativeGhost(pointerDrag.source);
    if (pointerDrag.type === 'todo') dragSrcTodoId = pointerDrag.id;
    if (pointerDrag.type === 'section') dragSrcSectionId = pointerDrag.id;
    moveNativeGhost(event);
    updateNativeDropTarget(event.clientX, event.clientY);
    scheduleNativeAutoScroll();
  }

  async function finishNativePointerDrag(event) {
    if (!pointerDrag) return;
    const drag = pointerDrag;
    const wasActive = drag.active;
    const target = wasActive ? updateNativeDropTarget(event.clientX, event.clientY) : null;
    if (drag.longPressTimer) window.clearTimeout(drag.longPressTimer);
    stopNativeAutoScroll();
    pointerDrag = null;
    try { drag.source.releasePointerCapture?.(drag.pointerId); } catch (_error) {}
    drag.ghost?.remove();
    drag.source.classList.remove('dragging');
    document.body.classList.remove('native-pointer-dragging');
    clearNativeDragIndicators();

    if (!wasActive || !target) {
      dragSrcTodoId = null;
      dragSrcSectionId = null;
      return;
    }

    if (drag.type === 'todo') {
      if (target.projectTarget?.dataset.projectId) {
        await moveTodoToProject(drag.id, target.projectTarget.dataset.projectId);
        dragSrcTodoId = null;
        return;
      }
      const rawSectionId = target.sectionTodos?.dataset.sectionId || target.sectionHeader?.dataset.sectionId;
      if (rawSectionId) await moveTodoToSection(drag.id, rawSectionId === 'null' ? null : parseInt(rawSectionId));
      dragSrcTodoId = null;
      return;
    }

    if (drag.type === 'section') {
      await moveSectionToDropTarget(target.sectionHeader, target.dropzone);
      dragSrcSectionId = null;
    }
  }

  function disableNativeHtmlDragDrop(root = document) {
    root.querySelectorAll?.('.todo-item[draggable], .section-header[draggable]').forEach((element) => {
      element.setAttribute('data-native-pointer-dnd', 'true');
      element.setAttribute('data-touch-dnd', 'true');
      element.draggable = false;
      element.removeAttribute('draggable');
    });
  }

  function isNativePointerDragInteractiveTarget(target) {
    return Boolean(target?.closest?.('button, input, textarea, select, a, summary, details, .todo-check, .todo-actions, [role="button"]'));
  }

  function nativeTodoDetailsSummaryFromTarget(target) {
    return target?.closest?.('.todo-status-menu > summary, .todo-snooze-menu > summary') || null;
  }

  function toggleNativeTodoDetailsSummary(summary) {
    const details = summary?.parentElement;
    if (!summary || !details) return false;
    document.querySelectorAll('.todo-status-menu[open], .todo-snooze-menu[open]').forEach((menu) => {
      if (menu !== details) menu.removeAttribute('open');
    });
    details.open = !details.open;
    return true;
  }

  function clearNativeSummaryPointer(pointerId = null) {
    if (pointerId !== null && nativeSummaryPointer?.pointerId !== pointerId) return;
    nativeSummaryPointer = null;
  }

  function shouldUsePointerDragDrop() {
    if (RUNTIME_CAPABILITIES.native) return true;
    const coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    return RUNTIME_CAPABILITIES.browser && (coarsePointer || Number(navigator.maxTouchPoints || 0) > 1);
  }

  function bindNativePointerDragDrop() {
    if (!shouldUsePointerDragDrop() || bindNativePointerDragDrop.bound) return;
    bindNativePointerDragDrop.bound = true;
    disableNativeHtmlDragDrop();
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) disableNativeHtmlDragDrop(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });

    document.addEventListener('dragstart', (event) => {
      if (!event.target.closest('.todo-item, .section-header')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    document.addEventListener('dragover', (event) => {
      if (!event.target.closest('.todo-item, .section-header, .section-todos, .project-group-todos, .section-dropzone, .project-drop-target')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    document.addEventListener('drop', (event) => {
      if (!event.target.closest('.todo-item, .section-header, .section-todos, .project-group-todos, .section-dropzone, .project-drop-target')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    document.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (pointerDrag && pointerDrag.pointerId !== event.pointerId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const summary = nativeTodoDetailsSummaryFromTarget(event.target);
      if (summary) {
        nativeSummaryPointer = {
          pointerId: event.pointerId,
          summary,
          startX: event.clientX,
          startY: event.clientY,
          canceled: false,
        };
        return;
      }
      clearNativeSummaryPointer();
      if (isNativePointerDragInteractiveTarget(event.target)) return;
      const todo = event.target.closest('.todo-item[data-id]');
      if (todo) {
        startNativePointerDrag(event, todo, 'todo', /^\d+$/.test(String(todo.dataset.id)) ? parseInt(todo.dataset.id) : todo.dataset.id);
        return;
      }
      const section = event.target.closest('.section-header[data-section-id]:not(.section-unsorted)');
      if (section && section.dataset.sectionId !== 'null') {
        startNativePointerDrag(event, section, 'section', parseInt(section.dataset.sectionId));
      }
    }, true);

    document.addEventListener('pointermove', (event) => {
      if (nativeSummaryPointer?.pointerId === event.pointerId) {
        const dx = event.clientX - nativeSummaryPointer.startX;
        const dy = event.clientY - nativeSummaryPointer.startY;
        if (Math.hypot(dx, dy) > SUMMARY_TOGGLE_MOVE_THRESHOLD_PX) nativeSummaryPointer.canceled = true;
      }
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      pointerDrag.lastX = event.clientX;
      pointerDrag.lastY = event.clientY;
      const dx = event.clientX - pointerDrag.startX;
      const dy = event.clientY - pointerDrag.startY;
      const distance = Math.hypot(dx, dy);
      if (!pointerDrag.active) {
        if (pointerDrag.isTouch && !pointerDrag.longPressReady) {
          if (Math.abs(dy) > TOUCH_SCROLL_CANCEL_PX || distance > TOUCH_SCROLL_CANCEL_PX * 1.5) {
            cancelNativePointerDrag();
          }
          return;
        }
        if (!pointerDrag.isTouch && distance < MOUSE_DRAG_THRESHOLD_PX) return;
      }
      event.preventDefault();
      activateNativePointerDrag(event);
      moveNativeGhost(event);
      updateNativeDropTarget(event.clientX, event.clientY);
      scheduleNativeAutoScroll();
    }, { capture: true, passive: false });

    document.addEventListener('pointerup', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const summaryPointer = nativeSummaryPointer?.pointerId === event.pointerId ? nativeSummaryPointer : null;
      clearNativeSummaryPointer(event.pointerId);
      if (!pointerDrag && summaryPointer && !summaryPointer.canceled && nativeTodoDetailsSummaryFromTarget(event.target) === summaryPointer.summary) {
        toggleNativeTodoDetailsSummary(summaryPointer.summary);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      if (!pointerDrag.active && isNativePointerDragInteractiveTarget(event.target)) {
        cancelNativePointerDrag();
        return;
      }
      event.preventDefault();
      finishNativePointerDrag(event);
    }, true);

    document.addEventListener('pointercancel', (event) => {
      clearNativeSummaryPointer(event.pointerId);
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      if (pointerDrag.active) finishNativePointerDrag(nativeDragEventFromLastPosition() || event);
      else cancelNativePointerDrag();
    }, true);

    document.addEventListener('touchstart', (event) => {
      if (!pointerDrag?.active || !pointerDrag.isTouch || event.touches.length < 2) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true, passive: false });

    document.addEventListener('touchmove', (event) => {
      if (!pointerDrag?.active || !pointerDrag.isTouch) return;
      if (event.touches.length > 1) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      const touch = activeTouchForDrag(event);
      if (!touch) return;
      event.preventDefault();
      const dragEvent = dragEventFromTouch(touch);
      pointerDrag.lastX = dragEvent.clientX;
      pointerDrag.lastY = dragEvent.clientY;
      moveNativeGhost(dragEvent);
      updateNativeDropTarget(dragEvent.clientX, dragEvent.clientY);
      scheduleNativeAutoScroll();
    }, { capture: true, passive: false });

    document.addEventListener('touchend', (event) => {
      if (!pointerDrag?.active || !pointerDrag.isTouch) return;
      const changedTouch = changedTouchForDrag(event);
      const activeTouch = activeTouchForDrag(event);
      if (!changedTouch && activeTouch) return;
      if (event.touches.length > 0 && activeTouch) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      event.preventDefault();
      finishNativePointerDrag(changedTouch ? dragEventFromTouch(changedTouch) : nativeDragEventFromLastPosition());
    }, { capture: true, passive: false });

    document.addEventListener('touchcancel', (event) => {
      if (!pointerDrag?.isTouch) return;
      const changedTouch = changedTouchForDrag(event);
      if (pointerDrag.active) finishNativePointerDrag(changedTouch ? dragEventFromTouch(changedTouch) : nativeDragEventFromLastPosition());
      else cancelNativePointerDrag();
    }, true);

    document.addEventListener('click', (event) => {
      if (!suppressNextNativeClick) return;
      suppressNextNativeClick = false;
      if (isNativePointerDragInteractiveTarget(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    window.addEventListener('blur', cancelNativePointerDrag, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') cancelNativePointerDrag();
    }, { passive: true });
  }

  return {
    handleTodoDragStart,
    handleTodoDragEnd,
    handleTodoDragOver,
    handleTodoDrop,
    handleProjectDragOver,
    handleProjectDrop,
    handleSectionDragStart,
    handleSectionDragEnd,
    handleSectionDragOver,
    handleSectionDrop,
    bindStandardDragDrop,
    bindNativePointerDragDrop,
  };
}
