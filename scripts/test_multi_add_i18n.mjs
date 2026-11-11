#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseShoppingQuickAdd } from '../web/static/js/features/shopping-quick-add.js';

const locales = ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN'];
const directory = new URL('../web/static/i18n/', import.meta.url);
const shared = ['modeLabel', 'introTitle', 'introDescription', 'remaining.one', 'remaining.many', 'limit', 'addRow', 'defaultsTitle', 'defaultsDescription', 'rowLabel', 'removeRow', 'duplicate', 'tooLong', 'pasteOmitted.one', 'pasteOmitted.many'];
const shopping = ['modeSingle', 'modeMultiple', 'title', 'subtitle', 'count.one', 'count.many', 'quickAddHint', 'create.one', 'create.many', 'created.one', 'created.many'];
const todo = [...shopping, 'recurringNeedsDue'];
const placeholders = text => (text.match(/\{\{?[^{}]+\}\}?|%\d*\$?[sdif]/gu) || []).sort();
const expectedPlaceholders = suffix => suffix.startsWith('pasteOmitted.') ? ['{count}', '{max}']
  : /^(remaining\.|count\.|create\.|created\.|tooLong$)/u.test(suffix) ? ['{count}']
    : suffix === 'limit' ? ['{max}'] : ['rowLabel', 'removeRow'].includes(suffix) ? ['{number}'] : [];
const domainTerms = {
  cs: /úkol|položk/iu, de: /todo|artikel/iu, en: /\btodos?\b|\bitems?\b|shopping/iu,
  es: /tarea|artículo/iu, fr: /tâche|article/iu, it: /attività|articol/iu,
  nl: /\btaak\b|taken|artikel/iu, pl: /zada[ńn]|artykuł/iu, 'pt-BR': /tarefa|artigo/iu,
  ru: /задач|товар/iu, sv: /uppgift|artikel|artiklar/iu, 'zh-CN': /待办|商品/u,
};
const perLineTerms = {
  cs: /pro každý řádek/u, de: /pro Zeile/u, en: /per line/u, es: /por línea/u,
  fr: /par ligne/u, it: /per riga/u, nl: /per regel/u, pl: /w każdym wierszu/u,
  'pt-BR': /por linha/u, ru: /для каждой строки/u, sv: /per rad/u, 'zh-CN': /逐行/u,
};
const productTerms = {
  cs: /polož/iu, de: /Artikel/u, en: /\bitems?\b/u, es: /artículos?/u, fr: /articles?/u,
  it: /articol[oi]/u, nl: /artikel/u, pl: /artykuł/u, 'pt-BR': /artigos?/u,
  ru: /товар/u, sv: /artikel|artiklar/u, 'zh-CN': /商品/u,
};
assert.deepEqual(readdirSync(directory).filter(file => file.endsWith('.json')).sort(), locales.map(locale => `${locale}.json`).sort());
const dictionaries = Object.fromEntries(locales.map(locale => {
  const raw = readFileSync(new URL(`${locale}.json`, directory), 'utf8');
  // Dictionaries are flat JSON. Check raw member names before JSON.parse can hide duplicates.
  const members = [...raw.matchAll(/^\s*"((?:[^"\\]|\\.)+)"\s*:/gmu)].map(match => JSON.parse(`"${match[1]}"`));
  assert.equal(new Set(members).size, members.length, `${locale}: duplicate dictionary keys`);
  const messages = JSON.parse(raw);
  assert.equal(members.length, Object.keys(messages).length, `${locale}: flat dictionary member coverage`);
  return [locale, messages];
}));
for (const locale of locales) {
  const messages = dictionaries[locale];
  for (const [prefix, suffixes] of [['capture.multiAdd.', shared], ['shopping.multiAdd.', shopping], ['todo.multiAdd.', todo]]) {
    assert.deepEqual(Object.keys(messages).filter(key => key.startsWith(prefix)).sort(), suffixes.map(suffix => prefix + suffix).sort(), `${locale}: exact ${prefix} coverage`);
  }
  for (const suffix of shared) assert.ok(!Object.hasOwn(messages, `todo.multiAdd.${suffix}`), `${locale}: obsolete Todo key ${suffix}`);
  for (const [prefix, suffixes] of [['capture.multiAdd.', shared], ['shopping.multiAdd.', shopping]]) {
    for (const suffix of suffixes) {
      const key = prefix + suffix;
      const value = messages[key];
      assert.equal(typeof value, 'string', `${locale}: missing ${key}`);
      assert.ok(value.trim(), `${locale}: empty ${key}`);
      assert.deepEqual(placeholders(value), expectedPlaceholders(suffix), `${locale}: placeholder multiset ${key}`);
      // No blanket language exemption: all current prose differs from English.
      if (locale !== 'en') assert.notEqual(value, dictionaries.en[key], `${locale}: English copy ${key}`);
      if (prefix === 'capture.multiAdd.') assert.doesNotMatch(value, domainTerms[locale], `${locale}: neutral shared text ${key}`);
      else if (suffix !== 'quickAddHint') assert.match(value, productTerms[locale], `${locale}: localized Shopping noun ${key}`);
    }
  }
  const hint = messages['shopping.multiAdd.quickAddHint'];
  assert.match(hint, perLineTerms[locale], `${locale}: explain that Quick Add works on each line`);
  const reference = messages['shopping.quickAdd.hint'];
  const examplePattern = /2 (?<unit>\S+) (?<name>[^@\n]+?) @(?<store>[^\s/]+) \/(?<section>[^\s"“”„«»‘’：:]+)/u;
  const example = hint.match(examplePattern);
  assert.ok(example, `${locale}: complete local quantity/name/store/section example`);
  assert.equal(example[0], reference.match(examplePattern)?.[0], `${locale}: reuse established executable local example`);
  const list = { id: 'list', sections: [{ id: 'section', name: example.groups.section }] };
  const options = { locale, t: key => messages[key] || key, list, stores: [{ id: 'store', shopping_list_id: list.id, active: true, name: example.groups.store }] };
  const parsed = parseShoppingQuickAdd(example[0], options);
  assert.equal(parsed.title, example.groups.name);
  assert.deepEqual(parsed.errors, [], `${locale}: executable bulk hint`);
  assert.deepEqual(parsed.warnings, [], `${locale}: recognized bulk hint`);
  // Localized liter aliases remain valid input; the shared unit registry emits canonical l.
  assert.deepEqual(parsed.changes, { quantity_value: 2, quantity_unit: 'l', store_ids: ['store'], section_id: 'section' });
  if (locale === 'en') {
    assert.match(hint, /1 gal Milk/u);
    assert.deepEqual(parseShoppingQuickAdd('1 gal Milk', options).changes, { quantity_value: 1, quantity_unit: 'gal' });
  }
  if (locale === 'ru') { assert.equal(example.groups.unit, 'л'); assert.equal(example.groups.store, 'Пятёрочка'); }
  if (locale === 'zh-CN') { assert.equal(example.groups.unit, '升'); assert.equal(example.groups.store, '盒马'); }
}
console.log(`Multi-add localization: ${locales.length} locales × ${shared.length} shared + ${shopping.length} Shopping keys passed (coverage, obsolete keys, duplicate keys, placeholder multisets, neutral/localized prose, executable hints).`);
