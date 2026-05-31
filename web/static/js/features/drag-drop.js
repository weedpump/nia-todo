import { RUNTIME_CAPABILITIES } from '../core/config.js';

export function createDragDropFeature({
  getTodos,
  setTodos,
  getSections,
  setSections,
  isOnlineForSync,
  todosApi,
  sectionsApi,
  renderTodos,
  dbGetAll,
  dbPut,
}) {
  let dragSrcTodoId = null;
  let dragSrcSectionId = null;
  let currentSectionDropIndex = null;
  let pointerDrag = null;
  let nativeSummaryPointer = null;
  let suppressNextNativeClick = false;
  const TOUCH_LONG_PRESS_MS = 320;
  const TOUCH_SCROLL_CANCEL_PX = 10;
  const MOUSE_DRAG_THRESHOLD_PX = 8;
  const SUMMARY_TOGGLE_MOVE_THRESHOLD_PX = 8;

  function eventDataTransfer(e) {
    return e.dataTransfer || { setData() {}, effectAllowed: 'move', dropEffect: 'move' };
  }

  function handleTodoDragStart(e) {
    const rawId = e.target.dataset.id;
    dragSrcTodoId = /^\d+$/.test(String(rawId)) ? parseInt(rawId) : rawId;
    e.target.classList.add('dragging');
    const transfer = eventDataTransfer(e);
    transfer.effectAllowed = 'move';
    transfer.setData('text/plain', 'todo:' + dragSrcTodoId);
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
    eventDataTransfer(e).dropEffect = 'move';
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

    if (dbPut) await dbPut('todos', updatedTodo);

    const isTempTodo = String(todo.id).startsWith('temp-');
    if (isTempTodo && dbGetAll && dbPut) {
      const queue = await dbGetAll('syncQueue');
      const createItem = queue.find(item => item.action === 'CREATE_TODO' && String(item.data?._tempId) === String(todo.id));
      if (createItem) {
        await dbPut('syncQueue', { ...createItem, data: { ...createItem.data, section_id: sectionId } });
      }
    }

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
    const transfer = eventDataTransfer(e);
    transfer.effectAllowed = 'move';
    transfer.setData('text/plain', 'section:' + dragSrcSectionId);
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
    eventDataTransfer(e).dropEffect = 'move';
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

  function clearNativeDragIndicators() {
    document.querySelectorAll('.section-todos.drag-over, .section-header.drag-over, .section-dropzone.drag-over').forEach(el => el.classList.remove('drag-over'));
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
      if (sectionTodos) {
        sectionTodos.classList.add('drag-over');
        return { sectionTodos };
      }
      if (sectionHeader) {
        sectionHeader.classList.add('drag-over');
        return { sectionHeader };
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

  function touchPointForDrag(event) {
    if (!pointerDrag?.isTouch) return null;
    const touches = [...(event.touches || []), ...(event.changedTouches || [])];
    return touches.find((touch) => touch.identifier === pointerDrag.pointerId) || touches[0] || null;
  }

  function dragEventFromTouch(touch) {
    return { clientX: touch.clientX, clientY: touch.clientY };
  }

  function startNativePointerDrag(event, source, type, id) {
    const isTouch = event.pointerType === 'touch' || event.pointerType === 'pen';
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
    document.body.classList.add('native-pointer-dragging');
    pointerDrag.source.classList.add('dragging');
    pointerDrag.ghost = createNativeGhost(pointerDrag.source);
    if (pointerDrag.type === 'todo') dragSrcTodoId = pointerDrag.id;
    if (pointerDrag.type === 'section') dragSrcSectionId = pointerDrag.id;
    moveNativeGhost(event);
    updateNativeDropTarget(event.clientX, event.clientY);
  }

  async function finishNativePointerDrag(event) {
    if (!pointerDrag) return;
    const drag = pointerDrag;
    const wasActive = drag.active;
    const target = wasActive ? updateNativeDropTarget(event.clientX, event.clientY) : null;
    if (drag.longPressTimer) window.clearTimeout(drag.longPressTimer);
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

  function bindNativePointerDragDrop() {
    if (!RUNTIME_CAPABILITIES.native || bindNativePointerDragDrop.bound) return;
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
      if (!event.target.closest('.todo-item, .section-header, .section-todos, .section-dropzone')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    document.addEventListener('drop', (event) => {
      if (!event.target.closest('.todo-item, .section-header, .section-todos, .section-dropzone')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    document.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
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
      if (pointerDrag.active && pointerDrag.isTouch) return;
      if (pointerDrag.active) finishNativePointerDrag(event);
      else cancelNativePointerDrag();
    }, true);

    document.addEventListener('touchmove', (event) => {
      if (!pointerDrag?.active || !pointerDrag.isTouch) return;
      const touch = touchPointForDrag(event);
      if (!touch) return;
      event.preventDefault();
      const dragEvent = dragEventFromTouch(touch);
      pointerDrag.lastX = dragEvent.clientX;
      pointerDrag.lastY = dragEvent.clientY;
      moveNativeGhost(dragEvent);
      updateNativeDropTarget(dragEvent.clientX, dragEvent.clientY);
    }, { capture: true, passive: false });

    document.addEventListener('touchend', (event) => {
      if (!pointerDrag?.active || !pointerDrag.isTouch) return;
      const touch = touchPointForDrag(event);
      if (!touch) return;
      event.preventDefault();
      finishNativePointerDrag(dragEventFromTouch(touch));
    }, { capture: true, passive: false });

    document.addEventListener('touchcancel', (event) => {
      if (!pointerDrag?.isTouch) return;
      const touch = touchPointForDrag(event);
      if (!touch) return;
      if (pointerDrag.active) finishNativePointerDrag(dragEventFromTouch(touch));
      else cancelNativePointerDrag();
    }, true);

    document.addEventListener('click', (event) => {
      if (!suppressNextNativeClick) return;
      suppressNextNativeClick = false;
      if (isNativePointerDragInteractiveTarget(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
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
    bindNativePointerDragDrop,
  };
}
