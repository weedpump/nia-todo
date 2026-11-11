#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseShoppingQuickAdd } from '../web/static/js/features/shopping-quick-add.js';
import { getQuantityUnitDefinition, normalizeQuantityUnit } from '../web/static/js/core/quantity-units.js';

const localesUrl = new URL('../web/static/i18n/', import.meta.url);
const locales = ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN'];
const prefix = 'shopping.quickAdd.';
const suffixes = [
  'hint',
  'syntax.quantityPrefixes',
  'syntax.unitPrefixes',
  'syntax.storePrefixes',
  'error.ambiguous',
  'error.conflict',
  'error.invalidQuantity',
  'error.missingName',
  'warning.unrecognized',
];
const keys = suffixes.map(suffix => prefix + suffix);
const internationalUnits = ['g', 'kg', 'mg', 'ml', 'cl', 'dl', 'l'];
// Local-language anchors guard both halves of the warning contract. Merely
// having a translated warning must not imply that unknown text is discarded.
const warningTerms = {
  cs: [/nerozpoznané/iu, /text/iu, /zůstane/iu, /názvu položky/iu],
  de: [/unbekannte/iu, /text/iu, /erhalten/iu, /artikelnamen/iu],
  en: [/unrecognized/iu, /text/iu, /retained/iu, /article name/iu],
  es: [/no reconocida/iu, /texto/iu, /conserva/iu, /nombre del artículo/iu],
  fr: [/non reconnue/iu, /texte/iu, /conservé/iu, /nom de l’article/iu],
  it: [/non riconosciuta/iu, /testo/iu, /mantenuto/iu, /nome dell’articolo/iu],
  nl: [/onbekende/iu, /tekst/iu, /behouden/iu, /artikelnaam/iu],
  pl: [/nierozpoznane/iu, /tekst/iu, /zachowany/iu, /nazwie artykułu/iu],
  'pt-BR': [/não reconhecida/iu, /texto/iu, /mantido/iu, /nome do artigo/iu],
  ru: [/нераспознанное/iu, /текст/iu, /сохраняется/iu, /названии товара/iu],
  sv: [/okänd/iu, /texten/iu, /behålls/iu, /artikelnamnet/iu],
  'zh-CN': [/无法识别/u, /文本/u, /保留/u, /商品名称/u],
};
const localUnits = {
  cs: ['kus', 'kusy', 'balení', 'láhev', 'lahve'],
  de: ['stück', 'packung', 'packungen', 'flasche', 'flaschen'],
  en: ['piece', 'pieces', 'pack', 'packs', 'bottle', 'bottles', 'oz', 'lb', 'lbs', 'fl oz'],
  es: ['pieza', 'piezas', 'paquete', 'paquetes', 'botella', 'botellas'],
  fr: ['pièce', 'pièces', 'paquet', 'paquets', 'bouteille', 'bouteilles'],
  it: ['pezzo', 'pezzi', 'confezione', 'confezioni', 'bottiglia', 'bottiglie'],
  nl: ['stuk', 'stuks', 'pak', 'pakken', 'fles', 'flessen'],
  pl: ['sztuka', 'sztuki', 'opakowanie', 'opakowania', 'butelka', 'butelki'],
  'pt-BR': ['unidade', 'unidades', 'pacote', 'pacotes', 'garrafa', 'garrafas'],
  ru: ['г', 'кг', 'л', 'штука', 'штуки', 'упаковка', 'упаковки', 'бутылка', 'бутылки'],
  sv: ['styck', 'stycken', 'paket', 'flaska', 'flaskor'],
  'zh-CN': ['克', '千克', '升', '个', '包', '瓶'],
};
const files = readdirSync(localesUrl).filter(file => file.endsWith('.json')).sort();
assert.deepEqual(files, locales.map(locale => `${locale}.json`).sort(), 'check all 12 shipped dictionaries');
const dictionaries = Object.fromEntries(locales.map(locale => [
  locale, JSON.parse(readFileSync(new URL(`${locale}.json`, localesUrl), 'utf8')),
]));
// Preserve repeated placeholder occurrences, not just the set of names.
const placeholders = value => (value.match(/\{\{?[^{}]+\}\}?|%\d*\$?[sdif]/gu) || []).sort();
const aliases = (value, label) => {
  const tokens = value.split('|');
  assert.ok(tokens.length > 0, `${label}: no aliases`);
  for (const token of tokens) {
    assert.ok(token.length > 0 && token === token.trim(), `${label}: empty or untrimmed alias`);
    assert.ok(!/[:@/{}]/u.test(token), `${label}: aliases must not contain assignment syntax`);
  }
  assert.equal(new Set(tokens.map(token => token.normalize('NFC').toLocaleLowerCase('en-US'))).size,
    tokens.length, `${label}: duplicate aliases`);
  return tokens;
};
for (const locale of locales) {
  const messages = dictionaries[locale];
  assert.deepEqual(Object.keys(messages).filter(key => key.startsWith(prefix)).sort(), [...keys].sort(),
    `${locale}: exact feature key parity (reuse existing field labels and section prefixes)`);
  for (const key of keys) {
    const value = messages[key];
    assert.equal(typeof value, 'string', `${locale}: missing string ${key}`);
    assert.ok(value.trim(), `${locale}: empty ${key}`);
    assert.deepEqual(placeholders(value), placeholders(dictionaries.en[key]), `${locale}: placeholder parity for ${key}`);
    // International unit abbreviations are intentionally equal across languages;
    // prose and localized assignment prefixes are not exempt from this check.
    if (locale !== 'en') {
      assert.notEqual(value, dictionaries.en[key], `${locale}: untranslated ${key}`);
    }
  }
  for (const suffix of ['quantityPrefixes', 'unitPrefixes', 'storePrefixes']) {
    aliases(messages[`${prefix}syntax.${suffix}`], `${locale}: ${suffix}`);
  }
  assert.equal(typeof messages['quickAdd.syntax.sectionPrefixes'], 'string', `${locale}: shared section prefixes missing`);
  aliases(messages['quickAdd.syntax.sectionPrefixes'], `${locale}: shared section prefixes`);
  for (const unit of [...internationalUnits, ...localUnits[locale]]) {
    assert.ok(getQuantityUnitDefinition(unit), `${locale}: missing registered unit ${unit}`);
  }
  const hint = messages[`${prefix}hint`];
  const example = hint.match(/2 (?<unit>\S+) (?<name>[^@\n]+?) @(?<store>[^\s/]+) \/(?<section>[^\s"“”„«»‘’：:]+)/u);
  assert.ok(example, `${locale}: quantity/unit/name/@store/section example`);
  assert.ok(getQuantityUnitDefinition(example.groups.unit), `${locale}: example unit must be supported`);
  if (locale === 'ru') assert.equal(example.groups.unit, 'л', 'Russian examples use the supported Cyrillic unit');
  if (locale === 'zh-CN') assert.equal(example.groups.unit, '升', 'Chinese examples use the supported local unit');
  const exampleList = { id: 'example-list', sections: [{ id: 'example-section', name: example.groups.section }] };
  const exampleOptions = {
    locale,
    t: key => messages[key] || key,
    list: exampleList,
    stores: [{ id: 'example-store', shopping_list_id: exampleList.id, name: example.groups.store, active: true }],
  };
  const parsedExample = parseShoppingQuickAdd(example[0], exampleOptions);
  assert.equal(parsedExample.title, example.groups.name);
  assert.deepEqual(parsedExample.errors, [], `${locale}: displayed example must parse`);
  assert.deepEqual(parsedExample.changes, { quantity_value: 2, quantity_unit: normalizeQuantityUnit(example.groups.unit), store_ids: ['example-store'], section_id: 'example-section' });
  if (locale === 'en') {
    assert.match(hint, /1 gal Milk/u, 'English examples include gallons alongside litres');
    const gallons = parseShoppingQuickAdd('1 gal Milk', exampleOptions);
    assert.equal(gallons.title, 'Milk');
    assert.deepEqual(gallons.changes, { quantity_value: 1, quantity_unit: 'gal' });
  }
  assert.match(hint, /3x /u, `${locale}: multiplier syntax example`);
  for (const term of warningTerms[locale]) {
    assert.match(messages[`${prefix}warning.unrecognized`], term, `${locale}: warning must retain unknown text in the name`);
  }
  const errors = ['ambiguous', 'conflict', 'invalidQuantity', 'missingName'].map(suffix => messages[`${prefix}error.${suffix}`]);
  assert.equal(new Set(errors).size, errors.length, `${locale}: error explanations must be distinct`);
}
for (const [locale, expected] of Object.entries({
  de: ['menge|anzahl', 'einheit', 'supermarkt|markt'],
  en: ['quantity|qty', 'unit', 'store|market'],
})) {
  for (const [index, suffix] of ['quantityPrefixes', 'unitPrefixes', 'storePrefixes'].entries()) {
    assert.equal(dictionaries[locale][`${prefix}syntax.${suffix}`], expected[index], `${locale}: supported ${suffix}`);
  }
}
console.log(`Shopping Quick-Add localization: ${locales.length} locales × ${keys.length} keys passed (aliases, placeholders, examples, and text-preserving warnings).`);
