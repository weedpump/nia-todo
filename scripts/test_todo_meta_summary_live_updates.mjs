#!/usr/bin/env node
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: { origin: 'http://localhost:8753', search: '' },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Node.js', platform: 'Linux', maxTouchPoints: 0 },
});
globalThis.window = globalThis;

const {
  bindTodoMetaSummaryUpdates,
  isAutoCloseTodoMetaSelection,
  isDirectTodoMetaToggle,
} = await import('../web/static/js/features/todos.js');

assert.equal(
  isDirectTodoMetaToggle({ id: 'todo-pinned', type: 'checkbox' }),
  true,
  'the pinned badge must toggle its checkbox without opening the metadata drawer',
);
assert.equal(
  isDirectTodoMetaToggle({ id: 'todo-status', type: 'select-one' }),
  false,
  'selection badges must keep opening the metadata editor',
);

for (const id of ['todo-project', 'todo-section', 'todo-status', 'todo-priority']) {
  assert.equal(isAutoCloseTodoMetaSelection(id), true, `${id} must close the badge-opened editor after selection`);
}
for (const id of ['todo-recurring-frequency', 'todo-location-place', 'todo-location-trigger']) {
  assert.equal(isAutoCloseTodoMetaSelection(id), false, `${id} must keep the metadata editor open for related fields`);
}

const listeners = new Map();
const form = {
  addEventListener(type, listener) {
    listeners.set(type, listener);
  },
};
let renders = 0;

bindTodoMetaSummaryUpdates(form, () => {
  renders += 1;
});

listeners.get('change')({ target: { id: 'todo-status' } });
await Promise.resolve();
assert.equal(renders, 1, 'status changes must refresh the metadata summary immediately');

listeners.get('input')({ target: { id: 'todo-remind' } });
listeners.get('change')({ target: { id: 'todo-remind' } });
await Promise.resolve();
assert.equal(renders, 2, 'input and change from one picker apply must coalesce into one summary refresh');

listeners.get('change')({ target: { id: 'todo-project' } });
await Promise.resolve();
assert.equal(renders, 3, 'project changes must refresh the metadata summary immediately');

listeners.get('input')({ target: { id: 'todo-location-address' } });
await Promise.resolve();
assert.equal(renders, 4, 'location edits must refresh the metadata summary immediately');

listeners.get('input')({ target: { id: 'todo-title' } });
await Promise.resolve();
assert.equal(renders, 4, 'unrelated form edits must not rebuild the metadata summary');

console.log('Todo metadata live-update binding test passed');
