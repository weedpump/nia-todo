import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'en-US', languages: ['en-US'] },
});
globalThis.document = {
  documentElement: { lang: '' },
  querySelectorAll() { return []; },
};
globalThis.window = new EventTarget();

const pendingDictionaries = new Map();
globalThis.fetch = (url) => {
  const language = String(url).match(/\/([^/]+)\.json$/)?.[1];
  return new Promise((resolve, reject) => {
    pendingDictionaries.set(language, { resolve, reject });
  });
};

function completeDictionary(language, dictionary) {
  const pending = pendingDictionaries.get(language);
  assert(pending, `Expected a pending ${language} dictionary request`);
  pendingDictionaries.delete(language);
  pending.resolve({
    ok: true,
    async json() { return dictionary; },
  });
}

function failDictionary(language) {
  const pending = pendingDictionaries.get(language);
  assert(pending, `Expected a pending ${language} dictionary request`);
  pendingDictionaries.delete(language);
  pending.reject(new Error(`expected ${language} dictionary failure`));
}

const moduleUrl = pathToFileURL(path.resolve('web/static/js/i18n/index.js'));
moduleUrl.searchParams.set('test', String(Date.now()));
const i18n = await import(moduleUrl.href);

const languageEvents = [];
window.addEventListener('nia-language-change', (event) => {
  languageEvents.push({ ...event.detail, marker: i18n.t('marker') });
});

const failedServerSync = i18n.setLanguagePreference('de', {
  syncServer: true,
  authApi: {
    async updateLanguage() {
      assert.deepEqual(
        languageEvents.at(-1),
        { preference: 'de', language: 'en', marker: 'en' },
        'The local event must expose the effective fallback language and dictionary before server persistence',
      );
      throw new Error('expected server failure');
    },
  },
});
failDictionary('de');
await Promise.resolve();
completeDictionary('en', { marker: 'en' });
await assert.rejects(failedServerSync, /expected server failure/);
assert.equal(i18n.getActiveLanguage(), 'en');
assert.equal(i18n.t('marker'), 'en');

const retryRequestedLanguage = i18n.setLanguagePreference('de');
completeDictionary('de', { marker: 'de' });
await retryRequestedLanguage;
assert.equal(i18n.getActiveLanguage(), 'de');
assert.equal(i18n.t('marker'), 'de');
assert.deepEqual(languageEvents.at(-1), { preference: 'de', language: 'de', marker: 'de' });

const eventCountBeforeRace = languageEvents.length;
const olderChange = i18n.setLanguagePreference('cs');
const newerChange = i18n.setLanguagePreference('fr');
completeDictionary('cs', { marker: 'cs' });
await olderChange;
assert.equal(languageEvents.length, eventCountBeforeRace, 'A superseded dictionary load must not emit a language event');
assert.equal(i18n.getActiveLanguage(), 'de');
assert.equal(i18n.t('marker'), 'de');
completeDictionary('fr', { marker: 'fr' });
await newerChange;
assert.equal(languageEvents.length, eventCountBeforeRace + 1);
assert.equal(i18n.getActiveLanguage(), 'fr');
assert.equal(i18n.t('marker'), 'fr');
assert.deepEqual(languageEvents.at(-1), { preference: 'fr', language: 'fr', marker: 'fr' });

storage.delete('nia-todo-language');
const previousEventCount = languageEvents.length;
const serverAdoption = i18n.adoptServerLanguagePreference('it');
completeDictionary('it', { marker: 'it' });
await serverAdoption;
assert.equal(i18n.getActiveLanguage(), 'it');
assert.equal(i18n.t('marker'), 'it');
assert.equal(languageEvents.length, previousEventCount + 1, 'Server language adoption must emit one language event');
assert.deepEqual(languageEvents.at(-1), { preference: 'it', language: 'it', marker: 'it' });

console.log('✅ i18n language lifecycle regression passed');
