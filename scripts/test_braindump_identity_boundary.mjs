#!/usr/bin/env node
import assert from 'node:assert/strict';

const elements = new Map();
function createElement() {
  return {
    id: '',
    className: '',
    innerHTML: '',
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    remove() { if (this.id) elements.delete(this.id); },
  };
}
elements.set('app', createElement());
elements.set('login-overlay', { ...createElement(), style: { display: 'none' } });
globalThis.document = {
  body: { appendChild(element) { if (element.id) elements.set(element.id, element); } },
  createElement,
  getElementById: id => elements.get(id) || null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.window = globalThis;
window.addEventListener = () => {};
window.getComputedStyle = element => element.style || { display: 'none' };
globalThis.location = { origin: 'https://todo.example', search: '' };
globalThis.localStorage = { getItem: key => key === 'jwt_token' ? 'token' : null };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0', mediaDevices: null } });
globalThis.history = { state: null, replaceState() {}, pushState() {} };

let accessRequests = 0;
let resolveOldAccess;
globalThis.fetch = async () => {
  accessRequests += 1;
  if (accessRequests === 1) {
    return { ok: true, json: () => new Promise(resolve => { resolveOldAccess = resolve; }) };
  }
  return { ok: true, json: async () => ({ enabled: true }) };
};

const { createBrainDumpLiveFeature } = await import('../web/static/js/features/braindump-live.js');
const feature = createBrainDumpLiveFeature({ getProjects: () => [], getSections: () => [], getCurrentWorkspaceId: () => null });
const oldIdentityInit = feature.init();
await Promise.resolve();
await Promise.resolve();
assert.equal(accessRequests, 1);

feature.resetForIdentityBoundary();
assert.equal(elements.has('braindump-fab'), false, 'identity reset must remove the old user launcher');
assert.equal(elements.has('braindump-modal'), false, 'identity reset must remove old transcript and candidate DOM');

await feature.init();
assert.equal(accessRequests, 2, 'the new identity must perform a fresh BrainDump entitlement request');
assert(elements.has('braindump-fab'));
assert(elements.has('braindump-modal'));

resolveOldAccess({ enabled: false });
await oldIdentityInit;
elements.get('braindump-fab')?.remove();
elements.get('braindump-modal')?.remove();
await feature.init();
assert.equal(accessRequests, 2, 'a stale old-user access result must not replace the new identity entitlement state');
assert(elements.has('braindump-fab'), 'the new identity entitlement must survive a late old-user response');
assert(elements.has('braindump-modal'), 'the new identity modal must remain available after a late old-user response');

console.log('✅ BrainDump state resets across identity boundaries');