import { quantityUnits, quantityUnitDefinitions } from './quantity-unit-data.js';

// Match Python str.split/strip, including NEL and information separators.
const whitespace = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const trim = value => value.replace(new RegExp(`^${whitespace}+|${whitespace}+$`, 'gu'), '');
const collapse = new RegExp(`${whitespace}+`, 'gu');
// NFKC handles compatibility ligatures and micro signs. These additional
// default-fold expansions preserve caseless spelling in the registry scripts.
const caseFold = value => value.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ').replace(/\u0345/g, 'ι');
function unitKey(value, fold = true) {
  const normalized = value.normalize('NFKC');
  return trim(fold ? caseFold(normalized) : normalized).replace(collapse, ' ').replace(/\.+$/, '');
}
function aliases(fold) {
  const choices = new Map();
  for (const [symbol, spellings] of Object.entries(quantityUnits)) {
    for (const alias of [symbol, ...spellings]) {
      const key = unitKey(alias, fold);
      if (!choices.has(key)) choices.set(key, new Set());
      choices.get(key).add(symbol);
    }
  }
  const result = new Map([...choices].filter(([, symbols]) => symbols.size === 1)
    .map(([key, symbols]) => [key, [...symbols][0]]));
  for (const symbol of Object.keys(quantityUnits)) result.set(unitKey(symbol, fold), symbol);
  return result;
}
const exact = aliases(false), words = aliases(true);

/** Match services.quantity_units without changing amounts or unknown units. */
export function normalizeQuantityUnit(value) {
  if (value == null) return null;
  const cleaned = trim(String(value));
  if (!cleaned) return null;
  const key = unitKey(cleaned, false);
  if (exact.has(key)) return exact.get(key);
  // Unregistered short SI spellings remain case-sensitive (ML/Mg).
  const folded = words.get(unitKey(cleaned));
  const kind = folded != null && Object.hasOwn(quantityUnitDefinitions, folded) ? quantityUnitDefinitions[folded].kind : null;
  if ([...key].length <= 3 && /^[\p{L}\p{N}]+$/u.test(key) && !['count', 'spoon', 'other'].includes(kind)) return cleaned;
  return folded ?? cleaned;
}

export function getQuantityUnitDefinition(value) {
  const id = normalizeQuantityUnit(value);
  return id != null && Object.hasOwn(quantityUnitDefinitions, id) ? quantityUnitDefinitions[id] : null;
}

/** Quick Add recognizes the same known spellings, independently of UI language.
 * Ambiguous spellings must stay literal rather than selecting an arbitrary unit. */
let recognizedAliases;
export function getQuantityUnitAliases() {
  recognizedAliases ||= [...new Set(Object.entries(quantityUnits).flatMap(([id, values]) => [id, ...values]))]
    .filter(value => getQuantityUnitDefinition(value) != null);
  return [...recognizedAliases];
}

/** Canonical IDs are stored; a unit has one fixed display label per locale. */
export function formatQuantityUnit(value, locale) {
  const id = normalizeQuantityUnit(value);
  if (id == null) return '';
  const definition = getQuantityUnitDefinition(id);
  if (!definition?.labels) return id;
  const language = String(locale || Intl.NumberFormat().resolvedOptions().locale).replace('_', '-');
  const supported = Object.keys(definition.labels).find(key => key.toLowerCase() === language.toLowerCase())
    || Object.keys(definition.labels).find(key => key.split('-')[0] === language.split('-')[0]);
  return definition.labels[supported || 'en'] || id;
}
