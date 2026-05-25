const LANGUAGE_STORAGE_KEY = 'nia-todo-language';
const SUPPORTED_LANGUAGES = ['de', 'en'];
const DEFAULT_LANGUAGE = 'en';
const dictionaries = new Map();
let activeLanguage = DEFAULT_LANGUAGE;
let activeDictionary = {};

function normalizeLanguage(value) {
  return SUPPORTED_LANGUAGES.includes(value) ? value : 'auto';
}

function detectBrowserLanguage() {
  const candidates = [navigator.language, ...(navigator.languages || [])]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().split('-')[0]);
  return candidates.find((value) => SUPPORTED_LANGUAGES.includes(value)) || DEFAULT_LANGUAGE;
}

function interpolate(text, params = {}) {
  return Object.entries(params).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    text,
  );
}

async function loadDictionary(language) {
  if (dictionaries.has(language)) return dictionaries.get(language);
  try {
    const response = await fetch(`/static/i18n/${language}.json`, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Failed to load i18n dictionary: ${language}`);
    const dictionary = await response.json();
    dictionaries.set(language, dictionary);
    return dictionary;
  } catch (err) {
    console.warn(`i18n: Failed to load ${language}, falling back to ${DEFAULT_LANGUAGE}`, err);
    if (language !== DEFAULT_LANGUAGE) {
      return loadDictionary(DEFAULT_LANGUAGE);
    }
    // Last resort: return empty dictionary to avoid blocking the app
    const empty = {};
    dictionaries.set(DEFAULT_LANGUAGE, empty);
    return empty;
  }
}

export function getLanguagePreference() {
  return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY) || 'auto');
}

export function getCurrentLanguage() {
  const preference = getLanguagePreference();
  return preference === 'auto' ? detectBrowserLanguage() : preference;
}

export function getActiveLanguage() {
  return activeLanguage;
}

export async function setLanguagePreference(mode, { authApi = null, syncServer = false } = {}) {
  const normalized = normalizeLanguage(mode);
  if (normalized === 'auto') localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  else localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  await initI18n();
  if (syncServer && authApi?.updateLanguage) await syncLanguagePreference(authApi);
  window.dispatchEvent(new CustomEvent('nia-language-change', {
    detail: { preference: getLanguagePreference(), language: getActiveLanguage() },
  }));
}

export async function syncLanguagePreference(authApi) {
  if (!authApi?.updateLanguage) return null;
  return authApi.updateLanguage(getLanguagePreference());
}

export async function adoptServerLanguagePreference(language) {
  const normalized = normalizeLanguage(language);
  if (normalized === 'auto') return initI18n();
  if (getLanguagePreference() === 'auto') localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  return initI18n();
}

export async function initI18n() {
  activeLanguage = getCurrentLanguage();
  activeDictionary = await loadDictionary(activeLanguage);
  document.documentElement.lang = activeLanguage;
  translatePage(document);
  return { preference: getLanguagePreference(), language: activeLanguage };
}

export function t(key, params = {}) {
  const value = activeDictionary[key] || key;
  return interpolate(value, params);
}

export function translatePage(root = document) {
  const scope = root.querySelectorAll ? root : document;
  scope.querySelectorAll('[data-i18n-key]').forEach((element) => {
    const key = element.dataset.i18nKey;
    if (key) element.textContent = t(key);
  });
  scope.querySelectorAll('[data-i18n-placeholder-key]').forEach((element) => {
    const key = element.dataset.i18nPlaceholderKey;
    if (key) element.setAttribute('placeholder', t(key));
  });
  scope.querySelectorAll('[data-i18n-title-key]').forEach((element) => {
    const key = element.dataset.i18nTitleKey;
    if (key) element.setAttribute('title', t(key));
  });
  scope.querySelectorAll('[data-i18n-aria-label-key]').forEach((element) => {
    const key = element.dataset.i18nAriaLabelKey;
    if (key) element.setAttribute('aria-label', t(key));
  });
  scope.querySelectorAll('[data-i18n-alt-key]').forEach((element) => {
    const key = element.dataset.i18nAltKey;
    if (key) element.setAttribute('alt', t(key));
  });
}

export { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY };
