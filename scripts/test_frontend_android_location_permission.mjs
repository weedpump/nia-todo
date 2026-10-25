#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  createAndroidLocationPermissionFlow,
  createAndroidLocationPermissionPrompt,
  createNativeReminderSnapshotState,
  scheduleAndroidLocationReminders,
} from '../web/static/js/features/android-location-permission.js';
import { createUiHistory } from '../web/static/js/features/ui-history.js';

function createElement() {
  const classes = new Set();
  const listeners = new Map();
  return {
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
    },
    dataset: {},
    textContent: '',
    setAttribute() {},
    focus() {},
    addEventListener(type, handler) { listeners.set(type, handler); },
    click() { listeners.get('click')?.(); },
  };
}

async function testGrantedStateSkipsPrompt() {
  let prompts = 0;
  const flow = createAndroidLocationPermissionFlow({
    nativeBridge: {
      locationPermissionGuidanceState: () => 'granted',
    },
    promptUser: async () => { prompts += 1; return 'continue'; },
  });

  assert.equal(await flow.ensurePermission(true), true);
  assert.equal(prompts, 0);
}

async function testDeclinedStatePromptsAgainWhileRemindersExist() {
  let prompts = 0;
  let requests = 0;
  const flow = createAndroidLocationPermissionFlow({
    nativeBridge: {
      locationPermissionGuidanceState: () => 'declined',
      requestLocationPermission: () => { requests += 1; return 'prompt'; },
    },
    promptUser: async () => { prompts += 1; return 'continue'; },
  });

  assert.equal(await flow.ensurePermission(true), false);
  assert.equal(prompts, 1);
  assert.equal(requests, 1);
}

async function testContinueStartsExistingNativeFlow() {
  let requested = 0;
  const states = [];
  const flow = createAndroidLocationPermissionFlow({
    nativeBridge: {
      locationPermissionGuidanceState: () => 'prompt',
      backgroundLocationPermissionOptionLabel: () => 'Allow all the time',
      backgroundLocationPermissionMode: () => 'settings',
      requestLocationPermission: () => { requested += 1; return 'prompt'; },
    },
    promptUser: async (state, optionLabel, mode) => { states.push([state, optionLabel, mode]); return 'continue'; },
  });

  assert.equal(await flow.ensurePermission(true), false);
  assert.deepEqual(states, [['prompt', 'Allow all the time', 'settings']]);
  assert.equal(requested, 1);
}

async function testDeclineRemovesLocationReminders() {
  let removals = 0;
  let requested = 0;
  const flow = createAndroidLocationPermissionFlow({
    nativeBridge: {
      locationPermissionGuidanceState: () => 'foreground_only',
      requestLocationPermission: () => { requested += 1; return 'background_settings'; },
    },
    promptUser: async () => 'decline',
    declinePermission: async () => { removals += 1; },
  });

  assert.equal(await flow.ensurePermission(true), false);
  assert.equal(removals, 1);
  assert.equal(requested, 0);
}

async function testForegroundGrantPromptsAgainForBackgroundAccess() {
  const states = ['prompt', 'foreground_only'];
  const prompts = [];
  let requests = 0;
  const flow = createAndroidLocationPermissionFlow({
    nativeBridge: {
      locationPermissionGuidanceState: () => states.shift(),
      backgroundLocationPermissionOptionLabel: () => 'Allow all the time',
      backgroundLocationPermissionMode: () => 'settings',
      requestLocationPermission: () => { requests += 1; return requests === 1 ? 'prompt' : 'background_settings'; },
    },
    promptUser: async state => { prompts.push(state); return 'continue'; },
  });

  assert.equal(await flow.ensurePermission(true), false);
  assert.equal(await flow.ensurePermission(true), false);
  assert.deepEqual(prompts, ['prompt', 'foreground_only']);
  assert.equal(requests, 2);
}


async function testDeclineKeepsPromptActiveWhenRemovalFails() {
  let prompts = 0;
  const flow = createAndroidLocationPermissionFlow({
    nativeBridge: {
      locationPermissionGuidanceState: () => 'foreground_only',
    },
    promptUser: async () => { prompts += 1; return 'decline'; },
    declinePermission: async () => { throw new Error('remove failed'); },
  });

  await assert.rejects(flow.ensurePermission(true), /remove failed/);
  await assert.rejects(flow.ensurePermission(true), /remove failed/);
  assert.equal(prompts, 2);
}

async function testCancelledRemovalKeepsPromptActive() {
  let prompts = 0;
  let removals = 0;
  const flow = createAndroidLocationPermissionFlow({
    nativeBridge: {
      locationPermissionGuidanceState: () => 'foreground_only',
    },
    promptUser: async () => { prompts += 1; return 'decline'; },
    declinePermission: async () => { removals += 1; return false; },
  });

  assert.equal(await flow.ensurePermission(true), false);
  assert.equal(await flow.ensurePermission(true), false);
  assert.equal(prompts, 2);
  assert.equal(removals, 2);
}

async function testDismissDoesNotStartOptOut() {
  let optOuts = 0;
  let requests = 0;
  const flow = createAndroidLocationPermissionFlow({
    nativeBridge: {
      locationPermissionGuidanceState: () => 'foreground_only',
      requestLocationPermission: () => { requests += 1; return 'background_settings'; },
    },
    promptUser: async () => 'dismiss',
    declinePermission: async () => { optOuts += 1; },
  });

  assert.equal(await flow.ensurePermission(true), false);
  assert.equal(optOuts, 0);
  assert.equal(requests, 0);
}

async function testConcurrentSchedulingSharesOnePrompt() {
  let resolvePrompt;
  let prompts = 0;
  let requests = 0;
  const flow = createAndroidLocationPermissionFlow({
    nativeBridge: {
      locationPermissionGuidanceState: () => 'prompt',
      requestLocationPermission: () => { requests += 1; return 'prompt'; },
    },
    promptUser: () => {
      prompts += 1;
      return new Promise(resolve => { resolvePrompt = resolve; });
    },
  });

  const first = flow.ensurePermission(true);
  const second = flow.ensurePermission(true);
  await new Promise(resolve => setImmediate(resolve));
  resolvePrompt('continue');
  await Promise.all([first, second]);

  assert.equal(prompts, 1);
  assert.equal(requests, 1);
}

async function testDelayedZeroCountRetriesAndWarns() {
  const counts = [0, 0];
  let calls = 0;
  let warnings = 0;
  const result = await scheduleAndroidLocationReminders({
    nativeBridge: {
      async scheduleLocationReminders() {
        calls += 1;
        return counts.shift();
      },
    },
    reminders: [{ id: 'location-1' }],
    ensurePermission: async () => true,
    warn: () => { warnings += 1; },
  });
  assert.equal(result, 0);
  assert.equal(calls, 2);
  assert.equal(warnings, 1);
}

function testTemporaryEmptyBootstrapDoesNotReplaceNativeReminderSnapshot() {
  const snapshots = createNativeReminderSnapshotState();
  assert.equal(snapshots.accept([], { authoritative: false }), false);
  assert.equal(snapshots.hasSnapshot(), false);
  assert.equal(snapshots.accept([{ id: 'cached-location' }], { authoritative: false }), true);
  assert.deepEqual(snapshots.todos(), [{ id: 'cached-location' }]);
  assert.equal(snapshots.accept([], { authoritative: false }), false);
  assert.deepEqual(snapshots.todos(), [{ id: 'cached-location' }]);
  assert.equal(snapshots.accept([], { authoritative: true }), true);
  assert.deepEqual(snapshots.todos(), []);
}

async function testHistoryBackSettlesPromptAndAllowsRetry() {
  const modal = createElement();
  const overlay = createElement();
  modal.querySelector = selector => selector === '.modal-overlay' ? overlay : null;
  const message = createElement();
  const continueButton = createElement();
  const declineButton = createElement();
  const elements = {
    'android-location-permission-modal': modal,
    'android-location-permission-message': message,
    'android-location-permission-continue': continueButton,
    'android-location-permission-decline': declineButton,
  };
  const listeners = new Map();
  const window = {
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
  };
  const stack = [{ state: null }];
  let stackIndex = 0;
  const history = {
    get state() { return stack[stackIndex].state; },
    replaceState(state) { stack[stackIndex] = { state: structuredClone(state) }; },
    pushState(state) {
      stack.splice(stackIndex + 1);
      stack.push({ state: structuredClone(state) });
      stackIndex += 1;
    },
    back() {
      if (stackIndex === 0) return;
      stackIndex -= 1;
      for (const handler of listeners.get('popstate') || []) handler({ state: stack[stackIndex].state });
    },
  };
  const documentListeners = new Map();
  const document = {
    getElementById: id => elements[id] || null,
    addEventListener(type, handler) {
      const handlers = documentListeners.get(type) || [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
  };
  const uiHistory = createUiHistory({ window, history, location: { pathname: '/', search: '' }, document });
  const prompt = createAndroidLocationPermissionPrompt({
    document,
    translate: (key, params) => `${key}:${params?.option || ''}`,
    openLayer: uiHistory.openLayer,
    registerLayer: uiHistory.registerLayer,
    requestCloseLayer: uiHistory.requestCloseLayer,
  });
  prompt.bind();
  assert.equal((documentListeners.get('keydown') || []).length, 1);

  const first = prompt.show('prompt', 'Allow all the time', 'settings');
  assert.deepEqual(history.state.niaTodoUi.layers, ['android-location-permission-modal']);
  history.back();
  assert.equal(await first, 'dismiss');

  const second = prompt.show('foreground_only', 'Allow all the time', 'settings');
  continueButton.click();
  assert.equal(await second, 'continue');
  assert.deepEqual(history.state.niaTodoUi.layers, []);

  const third = prompt.show('prompt', 'Allow all the time', 'settings');
  for (const handler of documentListeners.get('keydown') || []) handler({ key: 'Escape', preventDefault() {} });
  assert.equal(await third, 'dismiss');

  const fourth = prompt.show('prompt', 'Allow all the time', 'settings');
  overlay.click();
  assert.equal(await fourth, 'dismiss');

  const fifth = prompt.show('prompt', 'Allow all the time', 'settings');
  declineButton.click();
  assert.equal(await fifth, 'decline');
}

async function testOriginRestrictedLocationBridgeContract() {
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  const originalNavigator = globalThis.navigator;
  const originalDocument = globalThis.document;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const actions = [];
  let pendingSchedule = null;
  let timeoutCalls = 0;
  try {
    globalThis.window = {
      NIA_TODO_NATIVE: true,
      NIA_TODO_PLATFORM: 'android',
      location: { origin: 'http://tauri.localhost', search: '?nativeApp=tauri' },
      NiaAndroidLocationPermission: {
        postMessage(raw) {
          const message = JSON.parse(raw);
          actions.push(message);
          if (message.action === 'schedule') {
            pendingSchedule = message;
            return;
          }
          const payloads = {
            guidanceState: { state: 'foreground_only' },
            decline: { declined: true },
            resetGuidance: { reset: true },
            optionLabel: { label: 'Allow all the time' },
            mode: { mode: 'settings' },
            request: { state: 'background_settings' },
          };
          queueMicrotask(() => window.__niaAndroidLocationPermissionResponse(message.requestId, true, payloads[message.action] || {}));
        },
      },
    };
    globalThis.location = globalThis.window.location;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Android' } });
    globalThis.document = {
      documentElement: { classList: { contains: () => false } },
      body: { classList: { contains: () => false } },
    };
    globalThis.setTimeout = () => { timeoutCalls += 1; return timeoutCalls; };
    globalThis.clearTimeout = () => {};
    const { createNativeBridge } = await import(pathToFileURL(`${process.cwd()}/web/static/js/features/native-bridge.js`).href);
    const bridge = createNativeBridge();
    const scheduleResult = bridge.scheduleLocationReminders([{ id: 'location-1' }]);
    await Promise.resolve();
    assert.equal(timeoutCalls, 0, 'native location scheduling must remain pending beyond the generic 15-second bridge timeout');
    window.__niaAndroidLocationPermissionResponse(pendingSchedule.requestId, true, { count: 0 });
    assert.equal(await scheduleResult, 0, 'a delayed native scheduling failure must still reach retry and warning logic');
    assert.equal(await bridge.locationPermissionGuidanceState(), 'foreground_only');
    assert.equal(timeoutCalls, 1, 'short location bridge calls must retain their bounded timeout');
    assert.equal(await bridge.declineLocationPermissionGuidance(), true);
    assert.equal(await bridge.resetLocationPermissionGuidance(), true);
    assert.equal(await bridge.backgroundLocationPermissionOptionLabel(), 'Allow all the time');
    assert.equal(await bridge.backgroundLocationPermissionMode(), 'settings');
    assert.equal(await bridge.requestLocationPermission(), 'background_settings');
    assert.deepEqual(actions.map(entry => entry.action), [
      'schedule',
      'guidanceState',
      'decline',
      'resetGuidance',
      'optionLabel',
      'mode',
      'request',
    ]);
  } finally {
    globalThis.window = originalWindow;
    globalThis.location = originalLocation;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
    globalThis.document = originalDocument;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

await testGrantedStateSkipsPrompt();
await testDeclinedStatePromptsAgainWhileRemindersExist();
await testContinueStartsExistingNativeFlow();
await testDeclineRemovesLocationReminders();
await testForegroundGrantPromptsAgainForBackgroundAccess();
await testDeclineKeepsPromptActiveWhenRemovalFails();
await testCancelledRemovalKeepsPromptActive();
await testDismissDoesNotStartOptOut();
await testConcurrentSchedulingSharesOnePrompt();
await testDelayedZeroCountRetriesAndWarns();
testTemporaryEmptyBootstrapDoesNotReplaceNativeReminderSnapshot();
await testHistoryBackSettlesPromptAndAllowsRetry();
await testOriginRestrictedLocationBridgeContract();

const taskDialogs = await readFile(new URL('../web/static/js/modules/tasks-dialogs.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
const lifecycle = await readFile(new URL('../web/static/js/features/app-lifecycle.js', import.meta.url), 'utf8');
const desktop = await readFile(new URL('../web/static/js/features/desktop-integration.js', import.meta.url), 'utf8');
const permissionModule = await readFile(new URL('../web/static/js/features/android-location-permission.js', import.meta.url), 'utf8');
const todos = await readFile(new URL('../web/static/js/features/todos.js', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../web/static/js/features/native-bridge.js', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');

for (const id of [
  'android-location-permission-modal',
  'android-location-permission-title',
  'android-location-permission-message',
  'android-location-permission-decline',
  'android-location-permission-continue',
]) {
  assert(taskDialogs.includes(`id="${id}"`), `missing Android location guidance element ${id}`);
}
assert(desktop.includes('createAndroidLocationPermissionFlow'), 'desktop reminder scheduling must use the guided location permission flow');
assert(desktop.includes('createAndroidLocationPermissionPrompt'), 'desktop integration must use the history-aware location permission guidance modal');
assert(desktop.includes('removeAllLocationReminders()'), 'explicit opt-out must remove location reminders from the current post-confirmation todo state');
assert(app.includes('removeAllLocationReminders: () => todosFeature.removeAllLocationReminders()'), 'desktop opt-out must use the atomic current-state todo batch operation');
assert(todos.includes('async function removeAllLocationReminders()') && todos.includes('.filter(todo => todo?.location_reminder || todo?.location_reminders?.some?.(Boolean))'), 'location opt-out must select every reminder from the current todo state after confirmation');
assert(todos.includes('commitTodoUpdatesWithQueue(async persist => {') && todos.includes('const currentTodos = getTodos()'), 'location opt-out must build and apply its current todo snapshot inside the sync-queue write reservation');
assert(todos.includes('location_reminders: []'), 'location opt-out must clear normalized reminder state');
assert(desktop.includes('await syncTodoChanges?.()'), 'location opt-out must synchronize the complete queued batch once');
assert(bridge.includes('locationPermissionGuidanceState'), 'native bridge must expose the persisted guidance state');
assert(bridge.includes('declineLocationPermissionGuidance'), 'native bridge must persist an explicit decline');
assert(bridge.includes('backgroundLocationPermissionOptionLabel'), 'native bridge must expose Android’s localized background-location option label');
assert(bridge.includes('backgroundLocationPermissionMode'), 'native bridge must expose the API-level-specific background location flow');
assert(bridge.includes('NiaAndroidLocationPermission'), 'permission operations must use a dedicated WebMessage bridge');
assert(bridge.includes('__niaAndroidLocationPermissionResponse'), 'permission WebMessage calls must have an asynchronous response channel');
assert(!bridge.includes("android().declineLocationPermissionGuidance()"), 'persistent decline must not use the frame-wide JavascriptInterface');
assert(bridge.includes('resetLocationPermissionGuidance'), 'native bridge must expose deliberate guidance reactivation');
assert(todos.includes('locationReminderDirty') && todos.includes('resetLocationPermissionGuidanceForUserIntent'), 'creating or changing a location reminder must deliberately reactivate guidance');
assert(lifecycle.includes('nativeReminderSnapshotAuthoritative: false'), 'local bootstrap snapshots must be explicitly marked as non-authoritative');
assert(app.includes('nativeReminderSnapshotAuthoritative') && app.includes('authoritative: nativeReminderSnapshotAuthoritative'), 'snapshot authority must reach native reminder synchronization');
assert(permissionModule.includes('todo.location.permission.bodyRuntime'), 'API 29 must receive runtime-dialog-specific guidance');
assert(permissionModule.includes('todo.location.permission.bodyLegacy'), 'pre-Android-10 must not be told to open app settings');
assert(serviceWorker.includes('/static/js/features/android-location-permission.js'), 'location permission flow must be available in the offline native app shell');

console.log('✅ Android location permission guidance frontend test passed');
