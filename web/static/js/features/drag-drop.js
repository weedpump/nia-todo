import { RUNTIME_CAPABILITIES } from '../core/config.js';
import { resolveSectionDragSourceAdapter, resolveSectionDropAdapter } from './section-ui.js';

export function sectionDragSourceMatches({ currentId, currentAdapter, completedId, completedAdapter } = {}) {
  return currentAdapter === completedAdapter
    && currentId !== null
    && currentId !== undefined
    && String(currentId) === String(completedId);
}

export function createDragDropFeature({
  getSections,
  setSections,
  isOnlineForSync,
  sectionsApi,
  renderTodos,
  sectionRegistry,
  taskSectionAdapter,
}) {
  let dragSrcItem = null;
  let dragSrcSectionId = null;
  let dragSrcSectionAdapter = null;
  let currentSectionDropIndex = null;
  let pointerDrag = null;
  let nativeSummaryPointer = null;
  let nativeSummaryClickSuppression = null;
  let standardDragAutoScroll = null;
  let nativeClickSuppression = null;
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

  function setSectionDragActive(active) {
    document.body.classList.toggle('section-dragging', active);
  }

  function sectionAdapterFromTarget(target) {
    return sectionRegistry?.resolve?.(target) || taskSectionAdapter || null;
  }

  function itemDragSourceFromTarget(target) {
    const item = target?.closest?.('[data-item-dnd="true"]') || null;
    if (!item) return null;
    const sectionAdapter = sectionAdapterFromTarget(item);
    const itemAdapter = sectionAdapter?.itemDrag || null;
    if (!itemAdapter?.canDrag?.(item)) return null;
    const key = itemAdapter.keyFromElement?.(item);
    if (key === null || key === undefined || key === '') return null;
    return { item, key, itemAdapter, sectionAdapter };
  }

  function itemDropSectionId(target, source = dragSrcItem) {
    if (!source) return undefined;
    const targetSectionAdapter = sectionAdapterFromTarget(target);
    if (!targetSectionAdapter || targetSectionAdapter !== source.sectionAdapter || targetSectionAdapter.itemDrag !== source.itemAdapter) return undefined;
    const rawId = target?.dataset?.sectionId;
    if (rawId === 'null') return null;
    return source.itemAdapter.resolveSectionId?.(rawId) ?? targetSectionAdapter.resolveSectionId?.(rawId) ?? rawId;
  }

  async function moveDraggedItemToSection(source, target) {
    if (!source) return null;
    const sectionId = itemDropSectionId(target, source);
    if (sectionId === undefined) return null;
    const moved = await source.itemAdapter.moveToSection?.(source.key, sectionId);
    if (moved && source.restoreFocus) source.itemAdapter.focusItem?.(moved.client_mutation_id ?? moved.id ?? source.key);
    return moved || null;
  }

  function handleItemDragStart(e) {
    const source = itemDragSourceFromTarget(e.target);
    if (!source) return;
    source.restoreFocus = source.item.contains(document.activeElement);
    dragSrcItem = source;
    source.item.classList.add('dragging');
    const transfer = eventDataTransfer(e);
    transfer.effectAllowed = 'move';
    transfer.setData('text/plain', 'item:' + source.key);
  }

  function handleItemDragEnd(e) {
    stopStandardDragAutoScroll();
    const item = e.target?.closest?.('[data-item-dnd="true"]') || dragSrcItem?.item;
    item?.classList?.remove('dragging');
    clearItemDropIndicators();
    dragSrcItem = null;
  }

  function clearItemDropIndicators() {
    document.querySelectorAll('.section-todos.drag-over, .project-group-todos.drag-over, .section-header.drag-over, .project-drop-target.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function handleItemDragOver(e) {
    if (!dragSrcItem) return;
    const container = e.target.closest('.section-todos, .project-group-todos');
    const header = e.target.closest('.section-header');
    const target = container || header;
    if (target && itemDropSectionId(target) === undefined) return;
    e.preventDefault();
    eventDataTransfer(e).dropEffect = 'move';
    scheduleStandardDragAutoScroll(e);
    clearItemDropIndicators();
    if (container) container.classList.add('drag-over');
    else if (header) header.classList.add('drag-over');
  }

  async function handleItemDrop(e) {
    e.preventDefault();
    stopStandardDragAutoScroll();
    const container = e.target.closest('.section-todos');
    if (!container || !dragSrcItem) return;
    container.classList.remove('drag-over');
    const source = dragSrcItem;
    await moveDraggedItemToSection(source, container);
    source.item?.classList?.remove('dragging');
    if (dragSrcItem === source) dragSrcItem = null;
  }

  function projectDropEnabled() {
    return window.matchMedia?.('(min-width: 769px)').matches ?? true;
  }

  function handleProjectDragOver(e) {
    if (!dragSrcItem?.itemAdapter?.moveToProject || !projectDropEnabled()) return;
    const target = e.target.closest('.project-drop-target[data-project-id]');
    if (!target) return;
    e.preventDefault();
    eventDataTransfer(e).dropEffect = 'move';
    scheduleStandardDragAutoScroll(e);
    clearItemDropIndicators();
    target.classList.add('drag-over');
  }

  async function handleProjectDrop(e) {
    if (!dragSrcItem?.itemAdapter?.moveToProject || !projectDropEnabled()) return;
    const target = e.target.closest('.project-drop-target[data-project-id]');
    if (!target) return;
    e.preventDefault();
    stopStandardDragAutoScroll();
    target.classList.remove('drag-over');
    const source = dragSrcItem;
    const moved = await source.itemAdapter.moveToProject(source.key, target.dataset.projectId);
    if (moved && source.restoreFocus) source.itemAdapter.focusItem?.(moved.client_mutation_id ?? moved.id ?? source.key);
    source.item?.classList?.remove('dragging');
    if (dragSrcItem === source) dragSrcItem = null;
  }

  function handleSectionDragStart(e) {
    const section = e.target?.closest?.('.section-header[data-section-id]') || e.target;
    dragSrcSectionAdapter = resolveSectionDragSourceAdapter({ registry: sectionRegistry, taskAdapter: taskSectionAdapter, target: section });
    if (!dragSrcSectionAdapter) return;
    dragSrcSectionId = dragSrcSectionAdapter.resolveSectionId?.(section.dataset.sectionId) ?? section.dataset.sectionId;
    section.classList.add('dragging');
    setSectionDragActive(true);
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
    setSectionDragActive(false);
    clearSectionDropIndicators();
    dragSrcSectionId = null;
    dragSrcSectionAdapter = null;
    currentSectionDropIndex = null;
  }

  function handleSectionDragOver(e) {
    if (dragSrcSectionId === null || dragSrcSectionId === undefined) return;
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

  async function persistSectionOrder(sections, sourceAdapter = dragSrcSectionAdapter) {
    if (sourceAdapter?.reorderSections) {
      await sourceAdapter.reorderSections(sections.map(section => section.id));
      return;
    }
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

  async function moveSectionToDropTarget(header, dropzone, source = {}) {
    const sourceId = source.id ?? dragSrcSectionId;
    const sourceAdapter = source.adapter ?? dragSrcSectionAdapter;
    if (sourceId === null || sourceId === undefined) return false;
    const adapter = resolveSectionDropAdapter({
      registry: sectionRegistry,
      taskAdapter: taskSectionAdapter,
      sourceAdapter,
      target: dropzone || header,
    });
    if (!adapter?.canManage?.()) return false;
    const sections = [...(adapter.getSections?.() || getSections())];
    const srcIdx = sections.findIndex(section => String(section.id) === String(sourceId));
    if (srcIdx === -1) return false;

    if (dropzone) {
      const rawIndex = parseInt(dropzone.dataset.dropIndex, 10);
      if (Number.isNaN(rawIndex)) return false;
      const [moved] = sections.splice(srcIdx, 1);
      const targetIdx = srcIdx < rawIndex ? rawIndex - 1 : rawIndex;
      sections.splice(Math.max(0, Math.min(targetIdx, sections.length)), 0, moved);
      await persistSectionOrder(sections, sourceAdapter);
      return true;
    }

    const targetSectionId = header?.dataset.sectionId;
    if (targetSectionId === 'null' || !header || String(sourceId) === String(targetSectionId)) return false;

    const targetId = adapter.resolveSectionId?.(targetSectionId) ?? targetSectionId;
    const targetIdx = sections.findIndex(section => String(section.id) === String(targetId));
    if (targetIdx === -1) return false;

    const [moved] = sections.splice(srcIdx, 1);
    sections.splice(targetIdx, 0, moved);
    await persistSectionOrder(sections, sourceAdapter);
    return true;
  }

  async function handleSectionDrop(e) {
    e.preventDefault();
    stopStandardDragAutoScroll();
    setSectionDragActive(false);

    const header = e.target.closest('.section-header');
    const dropzone = e.target.closest('.section-dropzone');
    if (header) header.classList.remove('drag-over');
    if (dropzone) dropzone.classList.remove('drag-over');

    if (dragSrcItem && header) {
      const source = dragSrcItem;
      await moveDraggedItemToSection(source, header);
      source.item?.classList?.remove('dragging');
      if (dragSrcItem === source) dragSrcItem = null;
      return;
    }

    await moveSectionToDropTarget(header, dropzone);
  }

  let standardDragDropBound = false;
  function bindStandardDragDrop() {
    if (standardDragDropBound) return;
    standardDragDropBound = true;

    document.addEventListener('dragstart', (event) => {
      const item = event.target?.closest?.('[data-item-dnd="true"][draggable="true"]');
      if (item) {
        handleItemDragStart(event);
        return;
      }
      const section = event.target?.closest?.('.section-header[data-section-id]:not(.section-unsorted)[draggable="true"]');
      if (section) handleSectionDragStart(event);
    });

    document.addEventListener('dragend', (event) => {
      const item = event.target?.closest?.('[data-item-dnd="true"]');
      if (item) {
        handleItemDragEnd(event);
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
        handleItemDragOver(event);
        return;
      }
      if (event.target?.closest?.('.section-todos[data-section-id], .project-group-todos')) handleItemDragOver(event);
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
      if (event.target?.closest?.('.section-todos[data-section-id]')) await handleItemDrop(event);
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
    if (pointerDrag?.type === 'item') {
      const sectionTodos = element.closest('.section-todos');
      const sectionHeader = element.closest('.section-header');
      const projectTarget = pointerDrag.itemSource?.itemAdapter?.moveToProject && projectDropEnabled()
        ? element.closest('.project-drop-target[data-project-id]')
        : null;
      if (sectionTodos && itemDropSectionId(sectionTodos, pointerDrag.itemSource) !== undefined) {
        sectionTodos.classList.add('drag-over');
        return { sectionTodos };
      }
      if (sectionHeader && itemDropSectionId(sectionHeader, pointerDrag.itemSource) !== undefined) {
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
    ghost.classList.remove('dragging', 'touch-feedback', 'todo-press-active', 'swiping', 'swipe-right', 'swipe-left', 'swipe-ready', 'swipe-settling', 'swipe-committing');
    ghost.classList.add('native-drag-ghost');
    ghost.removeAttribute('id');
    ghost.removeAttribute('draggable');
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.removeProperty('transform');
    ghost.style.removeProperty('--swipe-x');
    ghost.style.removeProperty('--swipe-progress');
    document.body.appendChild(ghost);
    return ghost;
  }

  function moveNativeGhost(event) {
    if (!pointerDrag?.ghost) return;
    pointerDrag.ghost.style.left = `${event.clientX - pointerDrag.offsetX}px`;
    pointerDrag.ghost.style.top = `${event.clientY - pointerDrag.offsetY}px`;
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

  function startNativePointerDrag(event, source, type, id, itemSource = null) {
    const isTouch = event.pointerType === 'touch' || event.pointerType === 'pen';
    try { window.getSelection?.()?.removeAllRanges?.(); } catch (_error) {}
    pointerDrag = {
      pointerId: event.pointerId,
      source,
      type,
      id,
      itemSource,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: 0,
      offsetY: 0,
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
    if (pointerDrag.type === 'section') setSectionDragActive(false);
    document.body.classList.remove('native-pointer-dragging');
    clearNativeDragIndicators();
    pointerDrag = null;
    dragSrcItem = null;
    dragSrcSectionId = null;
    dragSrcSectionAdapter = null;
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
    if (pointerDrag.type === 'item' && pointerDrag.itemSource) {
      nativeClickSuppression = {
        itemAdapter: pointerDrag.itemSource.itemAdapter,
        key: pointerDrag.itemSource.key,
        until: Date.now() + 600,
      };
    }
    try { window.getSelection?.()?.removeAllRanges?.(); } catch (_error) {}
    document.body.classList.add('native-pointer-dragging');
    const sourceRect = pointerDrag.source.getBoundingClientRect();
    pointerDrag.offsetX = Math.max(0, Math.min(event.clientX - sourceRect.left, sourceRect.width));
    pointerDrag.offsetY = Math.max(0, Math.min(event.clientY - sourceRect.top, sourceRect.height));
    pointerDrag.ghost = createNativeGhost(pointerDrag.source);
    pointerDrag.source.classList.add('dragging');
    if (pointerDrag.type === 'item') dragSrcItem = pointerDrag.itemSource;
    if (pointerDrag.type === 'section') {
      dragSrcSectionId = pointerDrag.id;
      dragSrcSectionAdapter = resolveSectionDragSourceAdapter({ registry: sectionRegistry, taskAdapter: taskSectionAdapter, target: pointerDrag.source });
      setSectionDragActive(true);
    }
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
    if (drag.type === 'section') setSectionDragActive(false);
    document.body.classList.remove('native-pointer-dragging');
    clearNativeDragIndicators();

    if (!wasActive || !target) {
      if (dragSrcItem === drag.itemSource) dragSrcItem = null;
      dragSrcSectionId = null;
      dragSrcSectionAdapter = null;
      return;
    }

    if (drag.type === 'item') {
      const source = drag.itemSource;
      if (target.projectTarget?.dataset.projectId && source?.itemAdapter?.moveToProject) {
        const moved = await source.itemAdapter.moveToProject(source.key, target.projectTarget.dataset.projectId);
        if (moved && source.restoreFocus) source.itemAdapter.focusItem?.(moved.client_mutation_id ?? moved.id ?? source.key);
      } else {
        const targetElement = target.sectionTodos || target.sectionHeader;
        if (targetElement) await moveDraggedItemToSection(source, targetElement);
      }
      if (dragSrcItem === source) dragSrcItem = null;
      return;
    }

    if (drag.type === 'section') {
      const completedId = drag.id;
      const completedAdapter = dragSrcSectionAdapter;
      await moveSectionToDropTarget(target.sectionHeader, target.dropzone, { id: completedId, adapter: completedAdapter });
      if (sectionDragSourceMatches({
        currentId: dragSrcSectionId,
        currentAdapter: dragSrcSectionAdapter,
        completedId,
        completedAdapter,
      })) {
        dragSrcSectionId = null;
        dragSrcSectionAdapter = null;
      }
    }
  }

  function disableNativeHtmlDragDrop(root = document) {
    root.querySelectorAll?.('[data-item-dnd="true"][draggable], .section-header[draggable]').forEach((element) => {
      element.setAttribute('data-native-pointer-dnd', 'true');
      element.setAttribute('data-touch-dnd', 'true');
      element.draggable = false;
      element.removeAttribute('draggable');
    });
  }

  function isNativePointerDragInteractiveTarget(target, itemAdapter = null) {
    if (itemAdapter?.protectedStartSelector && target?.closest?.(itemAdapter.protectedStartSelector)) return true;
    if (itemAdapter?.interactiveStartSelector && target?.closest?.(itemAdapter.interactiveStartSelector)) return false;
    return Boolean(target?.closest?.('button, input, textarea, select, a, summary, details, .todo-check, .todo-actions, [role="button"]'));
  }

  function nativeTodoDetailsSummaryFromTarget(target) {
    return target?.closest?.('.todo-status-menu > summary, .todo-snooze-menu > summary') || null;
  }

  function resetNativeTodoDetailsPlacement(menu) {
    menu?.classList?.remove('opens-up', 'placement-ready');
  }

  function updateNativeTodoDetailsPlacement(menu) {
    if (!menu?.open) return;
    const panel = menu.querySelector('.todo-action-menu');
    const summary = menu.querySelector('summary');
    if (!panel || !summary) return;
    menu.classList.remove('opens-up', 'placement-ready');
    const summaryRect = summary.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const safeGap = 8;
    const spaceBelow = viewportHeight - summaryRect.bottom - safeGap;
    const spaceAbove = summaryRect.top - safeGap;
    if (panelRect.height > spaceBelow && spaceAbove > spaceBelow) {
      menu.classList.add('opens-up');
    }
    menu.classList.add('placement-ready');
  }

  function toggleNativeTodoDetailsSummary(summary) {
    const details = summary?.parentElement;
    if (!summary || !details) return false;
    const nextOpen = !details.open;
    document.querySelectorAll('.todo-status-menu[open], .todo-snooze-menu[open]').forEach((menu) => {
      if (menu !== details) {
        menu.removeAttribute('open');
        resetNativeTodoDetailsPlacement(menu);
      }
    });
    details.open = nextOpen;
    if (nextOpen) updateNativeTodoDetailsPlacement(details);
    else resetNativeTodoDetailsPlacement(details);
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
      if (!event.target.closest('[data-item-dnd="true"], .section-header')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    document.addEventListener('dragover', (event) => {
      if (!event.target.closest('[data-item-dnd="true"], .section-header, .section-todos, .project-group-todos, .section-dropzone, .project-drop-target')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    document.addEventListener('drop', (event) => {
      if (!event.target.closest('[data-item-dnd="true"], .section-header, .section-todos, .project-group-todos, .section-dropzone, .project-drop-target')) return;
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
      const itemSource = itemDragSourceFromTarget(event.target);
      if (itemSource) {
        if (isNativePointerDragInteractiveTarget(event.target, itemSource.itemAdapter)) return;
        itemSource.restoreFocus = itemSource.item.contains(document.activeElement);
        startNativePointerDrag(event, itemSource.item, 'item', itemSource.key, itemSource);
        return;
      }
      if (isNativePointerDragInteractiveTarget(event.target)) return;
      const section = event.target.closest('.section-header[data-section-id]:not(.section-unsorted)');
      if (section && section.dataset.sectionId !== 'null') {
        const adapter = resolveSectionDragSourceAdapter({ registry: sectionRegistry, taskAdapter: taskSectionAdapter, target: section });
        if (!adapter) return;
        const sectionId = adapter?.resolveSectionId?.(section.dataset.sectionId) ?? section.dataset.sectionId;
        startNativePointerDrag(event, section, 'section', sectionId);
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
        nativeSummaryClickSuppression = { summary: summaryPointer.summary, until: Date.now() + 600 };
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      if (!pointerDrag.active) {
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
      const summary = nativeTodoDetailsSummaryFromTarget(event.target);
      if (summary && nativeSummaryClickSuppression?.summary === summary && Date.now() <= nativeSummaryClickSuppression.until) {
        nativeSummaryClickSuppression = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!nativeClickSuppression || Date.now() > nativeClickSuppression.until) {
        nativeClickSuppression = null;
        return;
      }
      const item = event.target?.closest?.('[data-item-dnd="true"]');
      const itemAdapter = sectionAdapterFromTarget(item)?.itemDrag || null;
      const key = itemAdapter?.keyFromElement?.(item);
      if (itemAdapter !== nativeClickSuppression.itemAdapter || String(key) !== String(nativeClickSuppression.key)) return;
      nativeClickSuppression = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    window.addEventListener('blur', cancelNativePointerDrag, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') cancelNativePointerDrag();
    }, { passive: true });
  }

  return {
    handleItemDragStart,
    handleItemDragEnd,
    handleItemDragOver,
    handleItemDrop,
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
