#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

console.log('🤖 Running slim Android todo gesture contract test...');

const dragDropSource = await readFile(new URL('../web/static/js/features/drag-drop.js', import.meta.url), 'utf8');
const todosSource = await readFile(new URL('../web/static/js/features/todos.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../web/static/style.css', import.meta.url), 'utf8');

assert.ok(
  dragDropSource.includes('shouldUsePointerDragDrop()')
    && dragDropSource.includes("window.matchMedia('(hover: none) and (pointer: coarse)'")
    && dragDropSource.includes('navigator.maxTouchPoints'),
  'Touch browsers such as Android/iPadOS must use pointer drag-drop instead of native HTML5 drag previews',
);

assert.ok(
  dragDropSource.includes('touchIdentifier')
    && dragDropSource.includes('changedTouchForDrag(event)')
    && dragDropSource.includes('activeTouchForDrag(event)')
    && dragDropSource.includes('nativeDragEventFromLastPosition()'),
  'Native touch drag cleanup must track the active touch and clean up from last coordinates',
);

assert.ok(
  dragDropSource.includes('NATIVE_AUTO_SCROLL_EDGE_PX')
    && dragDropSource.includes('nativeAutoScrollTopBoundary')
    && dragDropSource.includes('scheduleNativeAutoScroll()')
    && dragDropSource.includes('applyScrollDelta'),
  'Native pointer drag must keep topbar-aware auto-scroll support',
);

assert.ok(
  dragDropSource.includes('pointerDrag && pointerDrag.pointerId !== event.pointerId')
    && dragDropSource.includes("document.addEventListener('touchstart'")
    && dragDropSource.includes('event.stopImmediatePropagation()'),
  'Multi-touch must not replace or strand an active native pointer drag',
);

assert.ok(
  todosSource.includes('--swipe-x')
    && todosSource.includes('--swipe-progress')
    && todosSource.includes("classList.toggle('swipe-ready'")
    && todosSource.includes("classList.add('swiping')"),
  'Todo swipe logic must expose swipe progress and ready state',
);

assert.ok(
  !styles.includes('.todo-card') || !styles.includes('.todo-card .mini-scrollbar'),
  'Todo cards must not get nested mini-scrollbar hints during aborted swipe gestures',
);

console.log('✅ Slim Android todo gesture contract test passed');
