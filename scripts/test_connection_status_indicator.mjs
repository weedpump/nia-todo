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
  globalThis.document = {
    getElementById(id) {
      return id === 'online-status' ? indicator : null;
    },
    querySelectorAll() {
      return [];
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });

  updateConnectionStatus('connecting', { syncing: true });
  assert.equal(indicator.style.display, 'none', 'initial server refreshes without queued changes must not show the sync indicator');
  assert.equal(indicator.className, 'status-checking');

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
  assert.match(indicator.innerHTML, /<svg[^>]*class="ui-icon"/, 'queued changes must render the sync icon immediately');
  assert.match(indicator.innerHTML, /<path /, 'queued changes must include the local Lucide icon paths');
  assert.match(indicator.innerHTML, />3</, 'queued changes must keep the visible queue count');

  console.log('✅ Connection status indicator regression passed');
} finally {
  globalThis.document = originalDocument;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
}
