#!/usr/bin/env node
import assert from 'node:assert/strict';
import { updateConnectionStatus } from '../web/static/js/features/connection-status.js';

const originalDocument = globalThis.document;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function makeIndicator() {
  return {
    style: {},
    className: '',
    dataset: {},
    textContent: '',
    title: '',
    innerHTML: '',
  };
}

try {
  const indicator = makeIndicator();
  const refreshButton = {
    classList: { toggle() {} },
    setAttribute(name, value) { this[name] = value; },
  };
  globalThis.document = {
    getElementById(id) {
      return id === 'online-status' ? indicator : null;
    },
    querySelectorAll() {
      return [refreshButton];
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });

  updateConnectionStatus('connecting', { syncing: true });
  assert.equal(indicator.style.display, 'none', 'initial server refreshes without queued changes must not show the sync indicator');
  assert.equal(indicator.className, 'status-checking');

  for (const state of ['connecting', 'connected', 'reconnecting']) {
    updateConnectionStatus(state, { pendingCount: 3 });
    assert.equal(indicator.style.display, 'none', `${state}: queued online changes must not show the sync indicator`);
    assert.equal(indicator.dataset.count, '');
    assert.equal(refreshButton.disabled, false);
  }

  updateConnectionStatus('disconnected');
  assert.equal(indicator.style.display, 'inline-flex');
  assert.equal(indicator.className, 'status-offline');
  assert.equal(indicator.textContent, 'connection.offline', 'confirmed server failure must show the translated offline label');
  const stableOfflineMarkup = indicator.innerHTML;

  updateConnectionStatus('reconnecting');
  assert.equal(indicator.style.display, 'inline-flex', 'background reconnects must keep a confirmed offline badge visible');
  assert.equal(indicator.className, 'status-offline');
  assert.equal(indicator.innerHTML, stableOfflineMarkup, 'background reconnects must not rebuild the offline badge');

  updateConnectionStatus('disconnected', { pendingCount: 3 });
  assert.equal(indicator.className, 'status-pending-sync');
  assert.equal(indicator.dataset.count, '3');
  assert.match(indicator.innerHTML, /<svg[^>]*class="ui-icon"/, 'queued offline changes must render the sync icon immediately');
  assert.match(indicator.innerHTML, /<path /, 'queued changes must include the local Lucide icon paths');
  assert.match(indicator.innerHTML, />3</, 'queued changes must keep the visible queue count');
  assert.equal(refreshButton.disabled, true);

  updateConnectionStatus('reconnecting', { pendingCount: 4 });
  assert.equal(indicator.style.display, 'inline-flex', 'reconnect attempts must keep the offline queue visible');
  assert.equal(indicator.className, 'status-pending-sync');
  assert.equal(indicator.dataset.count, '4', 'offline queue counts must stay current during reconnect attempts');
  assert.equal(refreshButton.disabled, true);

  updateConnectionStatus('reconnecting');
  assert.equal(indicator.className, 'status-offline', 'an empty queue during reconnect must retain the offline label');
  assert.equal(indicator.textContent, 'connection.offline');

  updateConnectionStatus('disconnected', { pendingCount: 3 });
  updateConnectionStatus('connected', { pendingCount: 3 });
  assert.equal(indicator.style.display, 'none', 'reconnecting successfully must hide the queue before it drains');
  assert.equal(indicator.className, 'status-online');
  assert.equal(indicator.dataset.count, '');
  assert.equal(indicator.textContent, '');
  assert.equal(indicator.title, '');
  assert.equal(refreshButton.disabled, false);

  navigator.onLine = false;
  for (const state of ['connected', 'connecting', 'reconnecting', 'disconnected']) {
    updateConnectionStatus(state, { pendingCount: 2 });
    assert.equal(indicator.style.display, 'inline-flex', `${state}: browser offline must show queued changes even before WebSocket state catches up`);
    assert.equal(indicator.className, 'status-pending-sync');
    assert.equal(indicator.dataset.count, '2');
    assert.equal(refreshButton.disabled, true);

    updateConnectionStatus(state);
    assert.equal(indicator.className, 'status-offline', `${state}: browser offline without changes must show the offline label`);
    assert.equal(indicator.textContent, 'connection.offline');
    assert.equal(refreshButton.disabled, true);
  }

  navigator.onLine = true;
  updateConnectionStatus('connected', { pendingCount: 2 });
  assert.equal(indicator.style.display, 'none', 'returning online must hide pending changes');
  assert.equal(refreshButton.disabled, false);

  console.log('✅ Connection status indicator regression passed');
} finally {
  globalThis.document = originalDocument;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
}
