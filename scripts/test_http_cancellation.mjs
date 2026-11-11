import assert from 'node:assert/strict';

globalThis.window = {};
globalThis.location = { origin: 'https://nia.test', search: '' };
globalThis.localStorage = { getItem: () => null };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: '', platform: '' }, configurable: true });
const { http } = await import('../web/static/js/api/http.js');

let captured;
globalThis.fetch = async (_url, options) => {
  captured = options;
  return { ok: true, json: () => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) };
};
await assert.rejects(http.post('/preview', { url: 'https://example.com' }, { timeoutMs: 20 }), { name: 'AbortError' });
assert.equal(captured.signal.aborted, true, 'deadline covers a stalled JSON body after headers arrive');
assert.equal(captured.credentials, 'include');

const controller = new AbortController();
const request = http.post('/preview', {}, { signal: controller.signal, timeoutMs: 1000 });
await Promise.resolve();
controller.abort();
await assert.rejects(request, { name: 'AbortError' });
assert.equal(captured.signal.aborted, true, 'external cancellation propagates to the actual fetch signal');

globalThis.fetch = async (_url, options) => {
  assert.equal(options.signal.aborted, true);
  throw new DOMException('Aborted', 'AbortError');
};
await assert.rejects(http.post('/preview', {}, { signal: controller.signal }), { name: 'AbortError' });
console.log('PASS HTTP deadlines include response bodies and external/already-aborted cancellation');
