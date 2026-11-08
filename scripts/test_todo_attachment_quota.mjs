#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createTodoAttachmentsFeature } from '../web/static/js/features/todo-attachments.js';

// No service, browser or database: exercise the real upload controller with a
// minimal DOM and explicitly held HTTP responses.
const freshUsage = { enabled: true, used_bytes: 0, quota_bytes: 100, remaining_bytes: 100,
  allowed_types: ['text/plain'], max_upload_bytes: 100 };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture({ usage = async () => freshUsage, upload, queue = async () => [] } = {}) {
  const file = { name: 'note.txt', type: 'text/plain', size: 4 };
  const input = { files: [file], value: 'selected', focus() {} };
  const todoId = { value: '7' }, button = { disabled: false };
  globalThis.document = { getElementById: id => ({ 'todo-id': todoId,
    'todo-attachment-file': input, 'todo-attachment-upload-btn': button }[id] || null) };
  const state = { user: { id: 1, attachments_enabled: false, attachment_remaining_bytes: 0,
    attachments_allowed_types: ['image/png'], attachment_max_upload_bytes: 1 },
  todos: [{ id: 7, project_id: null, attachments: [] }], usageCalls: 0, uploads: [],
  userWrites: [], writes: [], toasts: [], ref: { privacyGeneration: 0 } };
  const feature = createTodoAttachmentsFeature({
    getTodos: () => state.todos, setTodos: next => { state.todos = next; }, getProjects: () => [],
    getCurrentUser: () => state.user, setCurrentUser: user => { state.user = user; state.userWrites.push(user); },
    getAppInitialized: () => true, getDb: () => ({}), dbGetAll: queue,
    dbPut: async (store, row) => { state.writes.push({ store, row }); }, isOnlineForSync: () => true,
    todosApi: {
      getAttachmentUsage: () => { state.usageCalls++; return usage(); },
      uploadAttachment: async (id, selected) => {
        state.uploads.push({ id, file: selected });
        return upload ? upload() : { usage: { ...freshUsage, used_bytes: 4, remaining_bytes: 96 },
          todo: { id: 7, project_id: null, attachments: [{ id: 20 }] } };
      },
    },
    renderStats() {}, renderTodos() {}, closeModal() {}, confirmDanger: async () => false,
    showToast: message => state.toasts.push(message), t: key => key, iconSvg: () => '',
    escapeHtmlAttr: String, refreshTodoActionButtonState() {}, refreshTodoSaveButtonState() {},
    syncInProgressRef: state.ref,
  });
  return { state, feature, input, button, todoId, file };
}

{
  const f = fixture();
  assert.equal(await f.feature.uploadTodoAttachmentFromInput(), true, 'fresh quota released by revocation overrides stale cached exhaustion/policy');
  assert.equal(f.state.usageCalls, 1); assert.equal(f.state.uploads.length, 1);
  assert.equal(f.state.user.attachment_remaining_bytes, 96, 'upload responses reuse the same usage mapping');
  assert.equal(f.state.user.attachment_usage_bytes, 4);
  assert.deepEqual(f.state.user.attachments_allowed_types, ['text/plain']);
  assert.equal(f.state.writes.length, 1); assert.equal(f.input.value, ''); assert.equal(f.button.disabled, false);
}

for (const [policy, toast] of [
  [{ ...freshUsage, remaining_bytes: 0 }, 'quotaExceeded'],
  [{ ...freshUsage, enabled: false }, 'disabled'],
  [{ ...freshUsage, max_upload_bytes: 2 }, 'fileTooLarge'],
  [{ ...freshUsage, allowed_types: ['image/png'] }, 'typeNotAllowed'],
]) {
  const f = fixture({ usage: async () => policy });
  assert.equal(await f.feature.uploadTodoAttachmentFromInput(), false);
  assert.equal(f.state.uploads.length, 0, 'fresh policy rejection must never send an upload');
  assert.deepEqual(f.state.toasts, [`todo.attachments.${toast}`]);
  assert.equal(f.input.value, 'selected'); assert.equal(f.button.disabled, false);
}

{
  const response = deferred(), f = fixture({ usage: () => response.promise });
  const first = f.feature.uploadTodoAttachmentFromInput();
  assert.equal(f.button.disabled, true);
  assert.equal(await f.feature.uploadTodoAttachmentFromInput(), false, 'a duplicate submit is rejected during quota preflight');
  assert.equal(f.state.usageCalls, 1);
  f.state.user = { ...f.state.user, display_name: 'New display name' };
  response.resolve(freshUsage); assert.equal(await first, true);
  assert.equal(f.state.user.display_name, 'New display name', 'quota updates merge with the latest actor state');
  assert.equal(f.state.uploads.length, 1);
}

{
  const f = fixture({ usage: async () => { throw new Error('usage unavailable'); } });
  const originalError = console.error; console.error = () => {};
  try { assert.equal(await f.feature.uploadTodoAttachmentFromInput(), false); }
  finally { console.error = originalError; }
  assert.equal(f.state.uploads.length, 0); assert.equal(f.state.userWrites.length, 0);
  assert.equal(f.button.disabled, false); assert.equal(f.input.value, 'selected');
}

{
  const f = fixture({ usage: async () => ({ ...freshUsage, remaining_bytes: 'unknown' }) });
  const originalError = console.error; console.error = () => {};
  try { assert.equal(await f.feature.uploadTodoAttachmentFromInput(), false); }
  finally { console.error = originalError; }
  assert.equal(f.state.uploads.length, 0, 'invalid quota data also fails closed');
  assert.equal(f.state.userWrites.length, 0);
}

for (const invalidate of [
  f => { f.state.user = { id: 2 }; },
  f => { f.state.ref.privacyGeneration++; },
  f => { f.todoId.value = '8'; },
  f => { f.input.files = [{ name: 'new.txt', type: 'text/plain', size: 4 }]; },
]) {
  const response = deferred(), f = fixture({ usage: () => response.promise });
  const pending = f.feature.uploadTodoAttachmentFromInput();
  invalidate(f); response.resolve(freshUsage);
  assert.equal(await pending, false);
  assert.equal(f.state.uploads.length, 0); assert.equal(f.state.userWrites.length, 0);
  assert.equal(f.state.writes.length, 0); assert.deepEqual(f.state.toasts, []);
}

{
  const response = deferred(), f = fixture({ upload: () => response.promise });
  f.input.files.push({ name: 'second.txt', type: 'text/plain', size: 4 });
  const pending = f.feature.uploadTodoAttachmentFromInput();
  await Promise.resolve();
  assert.equal(f.state.uploads.length, 1);
  f.state.user = { id: 2 };
  response.resolve({ usage: freshUsage, todo: { id: 7 } });
  assert.equal(await pending, false);
  assert.equal(f.state.uploads.length, 1, 'account change also prevents the remaining files being sent');
  assert.equal(f.state.userWrites.length, 1, 'only the original actor preflight may update quota');
  assert.equal(f.state.writes.length, 0); assert.deepEqual(f.state.user, { id: 2 });
}

for (const originalCount of [1, 2]) {
  const response = deferred(), f = fixture({ upload: () => response.promise });
  if (originalCount === 2) f.input.files.push({ name: 'second.txt', type: 'text/plain', size: 4 });
  const pending = f.feature.uploadTodoAttachmentFromInput();
  await Promise.resolve();
  assert.equal(f.state.uploads.length, 1);
  const replacement = { name: 'replacement.txt', type: 'text/plain', size: 5 };
  f.input.files = [replacement]; f.input.value = 'replacement';
  response.resolve({ usage: freshUsage, todo: { id: 7, project_id: null, attachments: [{ id: 20 }] } });
  assert.equal(await pending, false);
  assert.equal(f.state.uploads.length, 1, 'a selection change during POST cancels the remaining original batch');
  assert.deepEqual(f.input.files, [replacement]); assert.equal(f.input.value, 'replacement');
  assert.equal(f.state.writes.length, 0); assert.deepEqual(f.state.toasts, [], 'an obsolete selection must not report success');
}

{
  const queued = deferred(), enteredQueue = deferred();
  const f = fixture({ queue: () => { enteredQueue.resolve(); return queued.promise; } });
  const pending = f.feature.uploadTodoAttachmentFromInput();
  await enteredQueue.promise;
  const replacement = { name: 'during-commit.txt', type: 'text/plain', size: 5 };
  f.input.files = [replacement]; f.input.value = 'during-commit';
  queued.resolve([]);
  assert.equal(await pending, false);
  assert.equal(f.state.uploads.length, 1);
  assert.deepEqual(f.input.files, [replacement]); assert.equal(f.input.value, 'during-commit');
  assert.equal(f.state.writes.length, 0, 'the selection is revalidated after the queue read inside the commit lock');
  assert.deepEqual(f.state.toasts, []);
}

{
  const old = deferred(), next = deferred(); let calls = 0;
  const f = fixture({ usage: () => (++calls === 1 ? old : next).promise });
  const stale = f.feature.uploadTodoAttachmentFromInput();
  f.state.user = { id: 2 };
  const current = f.feature.uploadTodoAttachmentFromInput();
  old.resolve(freshUsage); assert.equal(await stale, false);
  assert.equal(f.button.disabled, true, 'an obsolete preflight must not release the newer operation');
  next.resolve(freshUsage); assert.equal(await current, true);
  assert.equal(f.state.uploads.length, 1);
  assert.equal(f.state.user.id, 2);
}

console.log('✅ Attachment quota refresh, policy, duplicate-submit and actor/privacy guards passed');
