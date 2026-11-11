import { routingMemoryRules as rules } from '../core/routing-memory-rule-data.js';

// Personal destination inference, including bounded single-edit fallback:
// no products, synonyms, stopwords or automatic title corrections. Keep this kernel in parity with api/services/routing_matcher.py.
export const normalizeRoutingName = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/ß/g, 'ss').replace(/ς/g, 'σ').trim().replace(/\s+/gu, ' ');
const fields = ['list', 'section', 'stores'];
const unknown = Symbol('unresolved personal history');
// Only explicitly prepared, privately owned snapshots are cached. Mutable arrays
// passed to the original pure API retain their existing uncached semantics.
const preparedRows = new WeakMap(), preparedDocuments = new WeakMap();
function registerPreparedRows(rows, context = { names: new Map(), tokens: new Map() }) {
  preparedRows.set(rows, { context, subsets: new Map(), documents: new Map(), vocabulary: null });
  return rows;
}
function subset(entries, key, build) {
  const prepared = preparedRows.get(entries);
  if (!prepared) return build();
  if (prepared.subsets.has(key)) return prepared.subsets.get(key);
  const rows = build();
  if (rows.length) prepared.subsets.set(key, registerPreparedRows(rows, prepared.context));
  return rows;
}
function scopedRows(entries, containerId) {
  return containerId === null ? entries : subset(entries, `scope:${String(containerId)}`,
    () => entries.filter(row => String(row.shopping_list_id) === String(containerId)));
}
const modelRows = entries => subset(entries, 'model', () => entries.filter(row => !row.inference_direct_only));
function sourceName(entries, value) {
  const context = preparedRows.get(entries)?.context;
  if (!context) return normalizeRoutingName(value);
  const raw = String(value || '');
  if (!context.names.has(raw)) context.names.set(raw, normalizeRoutingName(raw));
  return context.names.get(raw);
}
function sourceTokens(entries, value) {
  const context = preparedRows.get(entries)?.context;
  if (!context) return routingTokens(value);
  const raw = String(value || '');
  if (!context.tokens.has(raw)) context.tokens.set(raw, routingTokens(raw));
  return context.tokens.get(raw);
}
function documentWords(docs) {
  const prepared = preparedDocuments.get(docs);
  if (prepared?.words) return prepared.words;
  const words = new Set(docs.flatMap(doc => doc.words));
  if (prepared) prepared.words = words;
  return words;
}
function typoVocabulary(entries) {
  const prepared = preparedRows.get(entries);
  if (prepared?.vocabulary) return prepared.vocabulary;
  const words = [...new Set(entries.flatMap(row => sourceTokens(entries, row.name_key)).filter(eligibleTypoWord))].sort(compare);
  if (prepared) prepared.vocabulary = words;
  return words;
}

const compare = (left, right) => {
  const a = [...left], b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference) return difference;
  }
  return a.length - b.length;
};

/** Coalescing an unsent create preserves one receipt, never pre-reset intent. */
export function mergeRoutingFeedback(previous, next) {
  if (!next || !previous || previous.generation !== next.generation) return next;
  return { ...next, event_id: previous.event_id,
    fields: [...new Set([...(previous.fields || []), ...next.fields])].filter(field => field === 'module' || fields.includes(field)) };
}
export function isRoutingIdeographic(char) {
  const code = char.codePointAt(0);
  return rules.ideographic_ranges.some(([start, end]) => code >= start && code <= end);
}
function tokenSpans(value) {
  const spans = [];
  let start = null, index = 0;
  for (const char of value) {
    const ideographic = isRoutingIdeographic(char), word = /[\p{L}\p{M}\p{N}]/u.test(char);
    if (ideographic || !word) {
      if (start !== null) { spans.push([value.slice(start, index), start, index]); start = null; }
      if (ideographic) spans.push([char, index, index + char.length]);
    } else if (start === null) start = index;
    index += char.length;
  }
  if (start !== null) spans.push([value.slice(start), start, value.length]);
  return spans;
}
export function routingTokens(value) {
  const key = normalizeRoutingName(value);
  if ([...key].length > rules.max_input_characters) return [];
  const words = tokenSpans(key).map(([word]) => word);
  return words.length <= rules.max_tokens ? words : [];
}
export function routingLookupNames(value) {
  const key = normalizeRoutingName(value);
  const spans = [...key].length <= rules.max_input_characters ? tokenSpans(key) : [];
  if (spans.length > rules.max_tokens) return [key];
  const names = new Set([key]);
  for (let start = 0; start < spans.length; start++) for (let end = start; end < spans.length; end++) {
    names.add(key.slice(spans[start][1], spans[end][2]));
  }
  return [...names];
}
const known = (row, field) => Boolean((field === 'list' ? row.preferred || row.list_known : row[`${field}_known`])
  && row.evidence?.[field]?.reliable !== false);
const observed = (row, field) => (row.history_fields || []).includes(field) || known(row, field);
function target(row, field) {
  if (field === 'list') return row.shopping_list_id ?? null;
  if (field === 'section') return row.section_id ?? null;
  if (field === 'module') return row.module_value ?? null;
  return [...new Map((row.store_ids || []).map(value => [String(value), value])).entries()]
    .sort(([a], [b]) => compare(a, b)).map(([, value]) => value);
}
const signature = value => Array.isArray(value) ? JSON.stringify([...new Set(value.map(String))].sort(compare)) : value == null ? null : String(value);
function resolveRows(rows, field) {
  const choices = rows.filter(row => observed(row, field));
  if (!choices.length) return { status: 'none', value: null };
  if (field === 'list') {
    const winners = choices.filter(row => known(row, field));
    return new Set(winners.map(row => signature(target(row, field)))).size === 1
      ? { status: 'value', value: target(winners[0], field) } : { status: 'blocked', value: null };
  }
  if (choices.some(row => !known(row, field))) return { status: 'blocked', value: null };
  return new Set(choices.map(row => signature(target(row, field)))).size === 1
    ? { status: 'value', value: target(choices[0], field) } : { status: 'blocked', value: null };
}
function documents(entries, field) {
  const prepared = preparedRows.get(entries);
  if (prepared?.documents.has(field)) return prepared.documents.get(field);
  const groups = new Map();
  for (const row of entries) {
    const key = sourceName(entries, row.name_key);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, new Map());
    const kinds = groups.get(key), kind = row.key_kind || 'exact';
    if (!kinds.has(kind)) kinds.set(kind, []);
    kinds.get(kind).push(row);
  }
  const docs = [];
  for (const [key, kinds] of [...groups].sort(([a], [b]) => compare(a, b))) {
    for (const kind of ['exact', 'token']) {
      const choice = resolveRows(kinds.get(kind) || [], field);
      if (choice.status === 'none') continue;
      docs.push({ name_key: key, key_kind: kind, ...choice, words: sourceTokens(entries, key),
        inference_direct_only: (kinds.get(kind) || []).filter(row => observed(row, field)).every(row => Boolean(row.inference_direct_only)) });
      break;
    }
  }
  if (prepared && docs.length) {
    prepared.documents.set(field, docs);
    preparedDocuments.set(docs, { corpus: null, words: null });
  }
  return docs;
}
function result(status = 'none', value = null, kind = null, docs = [], score = 0) {
  const keys = new Map(docs.map(doc => [JSON.stringify([doc.name_key, doc.key_kind]), { name_key: doc.name_key, key_kind: doc.key_kind }]));
  return { status, value, match_kind: kind,
    source_keys: [...keys.values()].sort((a, b) => compare(a.name_key, b.name_key) || compare(a.key_kind, b.key_kind)),
    score: Math.round(score * 1e6) / 1e6 };
}
function uniformDocuments(docs, kind, score = 1) {
  if (docs.some(doc => doc.status !== 'value') || new Set(docs.map(doc => signature(doc.value))).size !== 1) {
    return result('blocked', null, kind, docs, score);
  }
  return result('value', docs[0].value, kind, docs, score);
}
function subsequence(source, query) {
  let index = 0;
  for (const word of query) if (index < source.length && source[index] === word) index++;
  return index === source.length;
}
const ideographicWords = words => Boolean(words.length && words.every(word => [...word].length === 1 && isRoutingIdeographic(word)));
function containsPhrase(source, query, sourceName, queryName) {
  if (!source.length) return false;
  if (ideographicWords(source)) {
    if (sourceName === queryName) return true;
    if (source.length < rules.min_ideographic_phrase_chars || !queryName.includes(sourceName)) return false;
    return query.some((_, index) => index + source.length <= query.length && source.every((word, offset) => word === query[index + offset]));
  }
  return subsequence(source, query);
}
function corpus(docs) {
  const prepared = preparedDocuments.get(docs);
  if (prepared?.corpus) return prepared.corpus;
  const frequencies = new Map(), routes = new Map();
  for (const doc of docs) {
    const choice = doc.status === 'value' ? signature(doc.value) : unknown;
    for (const word of new Set(doc.words)) {
      frequencies.set(word, (frequencies.get(word) || 0) + 1);
      if (!routes.has(word)) routes.set(word, new Map());
      const choices = routes.get(word);
      choices.set(choice, (choices.get(choice) || 0) + 1);
    }
  }
  const reliable = new Map();
  for (const [word, choices] of routes) {
    const ranked = [...choices].sort((a, b) => b[1] - a[1]), [winner, count] = ranked[0];
    const total = [...choices.values()].reduce((sum, value) => sum + value, 0);
    if (winner !== unknown && count / total >= rules.min_term_route_fraction && (ranked.length === 1 || count > ranked[1][1])) reliable.set(word, winner);
  }
  const weight = word => {
    const frequency = frequencies.get(word);
    if (frequency === undefined) return (1 + Math.log((docs.length + 1) / 2)) * rules.unknown_term_weight;
    const share = Math.max(...routes.get(word).values()) / frequency;
    return (1 + Math.log((docs.length + 1) / (frequency + 1))) * Math.log1p(frequency) * share;
  };
  const result = { reliable, weight };
  if (prepared) prepared.corpus = result;
  return result;
}
/** Each distinct personal title votes once, regardless of historical hit count. */
function matchRoutingFieldWithoutTypos(entries, name, field, containerId = null) {
  const key = normalizeRoutingName(name);
  entries = scopedRows(entries, containerId);
  const docs = documents(entries, field), exact = docs.filter(doc => doc.name_key === key && doc.key_kind === 'exact');
  if (exact.length) return uniformDocuments(exact, 'exact');
  const query = routingTokens(key);
  if (!query.length) return result();
  // Focused server recall may add literal older memories; it must never alter
  // the bounded personal corpus shared with the browser and offline cache.
  const modelEntries = modelRows(entries);
  const modelDocs = modelEntries.length === entries.length ? docs : documents(modelEntries, field);
  const modelWords = documentWords(modelDocs);
  const { reliable, weight } = corpus(modelDocs), complete = [];
  for (const doc of docs) {
    if (!containsPhrase(doc.words, query, doc.name_key, key)) continue;
    if (doc.words.length === 1 && doc.status === 'value'
      && !(doc.inference_direct_only && !modelWords.has(doc.words[0]))
      && (reliable.get(doc.words[0]) ?? unknown) !== signature(doc.value)) continue;
    complete.push(doc);
  }
  if (complete.length) {
    if (complete.length > rules.max_candidate_phrases) return result('blocked', null, 'phrase');
    const maximal = complete.filter(doc => !complete.some(other => other.words.length > doc.words.length && subsequence(doc.words, other.words)));
    return uniformDocuments(maximal, 'phrase');
  }
  const candidates = [], queryWords = new Set(query);
  const queryWeight = [...queryWords].reduce((sum, word) => sum + weight(word), 0);
  for (const doc of modelDocs) {
    const words = new Set(doc.words), shared = [...words].filter(word => queryWords.has(word));
    if (!shared.length || shared.every(word => ideographicWords([word]))) continue;
    const choice = doc.status === 'value' ? signature(doc.value) : unknown;
    const useful = choice === unknown ? shared : shared.filter(word => (reliable.get(word) ?? unknown) === choice);
    const overlap = useful.reduce((sum, word) => sum + weight(word), 0);
    const sourceCoverage = words.size ? overlap / [...words].reduce((sum, word) => sum + weight(word), 0) : 0;
    const score = Math.min(overlap / queryWeight, sourceCoverage);
    if (sourceCoverage > rules.min_statistical_source_coverage + 1e-12 && score + 1e-12 >= rules.min_statistical_similarity) candidates.push({ doc, score, choice });
  }
  if (!candidates.length) return result();
  if (candidates.length > rules.max_candidate_phrases) return result('blocked', null, 'statistical');
  const targets = new Map();
  for (const { score, choice } of candidates) targets.set(choice, Math.max(score, targets.get(choice) || 0));
  const ranked = [...targets].sort((a, b) => b[1] - a[1]), [choice, score] = ranked[0];
  const total = [...targets.values()].reduce((sum, value) => sum + value, 0);
  if (choice === unknown || score / total < rules.min_target_route_fraction || (ranked.length > 1 && score - ranked[1][1] < rules.min_target_score_margin)) {
    return result('blocked', null, 'statistical', candidates.map(({ doc }) => doc), score);
  }
  const winners = candidates.filter(candidate => candidate.choice === choice && Math.abs(candidate.score - score) < 1e-12).map(({ doc }) => doc);
  return result('value', winners[0].value, 'statistical', winners, score);
}
function eligibleTypoWord(word) {
  const chars = [...word];
  return chars.length >= rules.min_typo_word_characters
    && chars.every(char => /\p{L}/u.test(char) && !isRoutingIdeographic(char));
}
/** Exactly one edit; unchanged words, short names and numeric identifiers fail. */
export function singleRoutingTypoEdit(left, right) {
  left = [...normalizeRoutingName(left)]; right = [...normalizeRoutingName(right)];
  if (rules.max_typo_edits !== 1 || !eligibleTypoWord(left.join('')) || !eligibleTypoWord(right.join(''))
    || left.join('') === right.join('') || Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const different = left.flatMap((char, index) => char === right[index] ? [] : [index]);
    if (different.length === 1) return true;
    return different.length === 2 && different[1] === different[0] + 1
      && left[different[0]] === right[different[1]] && left[different[1]] === right[different[0]];
  }
  const [short, long] = left.length < right.length ? [left, right] : [right, left];
  let index = 0;
  while (index < short.length && short[index] === long[index]) index++;
  return short.slice(index).join('') === long.slice(index + 1).join('');
}
function typoAlignment(source, query, neighbors) {
  // Encode (source index, used edit, ambiguous spelling) as index * 4 + flags.
  let states = new Set([0]);
  for (const word of query) {
    const following = new Set(states);
    for (const state of states) {
      const index = Math.floor(state / 4), edited = Boolean(state & 2);
      if (index === source.length) continue;
      if (source[index] === word) following.add((index + 1) * 4 + (state & 3));
      else if (!edited && neighbors.get(word)?.has(source[index])) {
        following.add((index + 1) * 4 + 2 + Number(neighbors.get(word).size > 1));
      }
    }
    states = following;
  }
  const complete = [...states].filter(state => Math.floor(state / 4) === source.length && (state & 2));
  return { complete: Boolean(complete.length), ambiguous: complete.some(state => state & 1) };
}
/** Fuzzy routing never changes titles, creates aliases or learns from a lookup. */
export function matchRoutingTypoField(entries, name, field, containerId = null) {
  const query = routingTokens(name);
  if (!query.length) return result();
  let model = modelRows(entries);
  const protectedWords = documentWords(documents(model, field));
  const vocabulary = typoVocabulary(model);
  const neighbors = new Map();
  let comparisons = 0;
  for (const word of [...new Set(query)].sort(compare)) {
    if (protectedWords.has(word) || !eligibleTypoWord(word)) continue;
    const adjacent = new Set();
    for (const spelling of vocabulary) {
      if (spelling === word || Math.abs([...word].length - [...spelling].length) > 1) continue;
      if (++comparisons > rules.max_typo_comparisons) return result('blocked', null, 'typo');
      if (singleRoutingTypoEdit(word, spelling)) adjacent.add(spelling);
    }
    if (adjacent.size) neighbors.set(word, adjacent);
  }
  if (!neighbors.size) return result();
  model = scopedRows(model, containerId);
  const docs = documents(model, field), possible = new Set([...neighbors.values()].flatMap(words => [...words]));
  const candidates = docs.filter(doc => doc.words.some(word => possible.has(word)));
  if (candidates.length > rules.max_candidate_phrases) return result('blocked', null, 'typo');
  const { reliable } = corpus(docs), matched = [];
  for (let doc of candidates) {
    const alignment = typoAlignment(doc.words, query, neighbors);
    if (!alignment.complete) continue;
    if (alignment.ambiguous) return result('blocked', null, 'typo');
    if (doc.words.length === 1 && doc.status === 'value'
      && (reliable.get(doc.words[0]) ?? unknown) !== signature(doc.value)) doc = { ...doc, status: 'blocked' };
    matched.push(doc);
  }
  if (!matched.length) return result();
  const maximal = matched.filter(doc => !matched.some(other => other.words.length > doc.words.length && subsequence(doc.words, other.words)));
  const decision = uniformDocuments(maximal, 'typo');
  return decision.status === 'value' ? decision : result('blocked', null, 'typo');
}
export function matchRoutingField(entries, name, field, containerId = null) {
  const decision = matchRoutingFieldWithoutTypos(entries, name, field, containerId);
  return decision.status === 'none' ? matchRoutingTypoField(entries, name, field, containerId) : decision;
}
function suggestScopedRoute(entries, name, listId, { task = false } = {}) {
  const sources = {}, values = {};
  if (listId == null) {
    const choice = matchRoutingField(entries, name, 'list');
    if (choice.status !== 'value') return null;
    listId = choice.value; sources.list = choice.match_kind;
  }
  for (const field of task ? ['section'] : ['section', 'stores']) {
    const choice = matchRoutingField(entries, name, field, listId);
    if (choice.status === 'value') { values[field] = choice.value; sources[field] = choice.match_kind; }
  }
  if (!Object.keys(sources).length) return null;
  const kinds = new Set(Object.values(sources));
  return { name_key: normalizeRoutingName(name), shopping_list_id: listId, list_known: 'list' in sources, preferred: 'list' in sources,
    section_known: 'section' in sources, section_id: values.section ?? null, stores_known: 'stores' in sources,
    store_ids: values.stores || [], memory_fields: fields.filter(field => field in sources), memory_sources: sources,
    match_kind: kinds.size === 1 ? [...kinds][0] : 'mixed' };
}
export function suggestRoutingRoute(entries, name, listId = null) {
  return suggestScopedRoute(subset(entries, 'shopping', () => entries.filter(row => row.shopping_list_id != null)), name, listId);
}
export function suggestTaskRoutingRoute(entries, name, workspaceId = null, projectId = null) {
  const adapted = subset(entries, `tasks:${workspaceId == null ? 'null' : String(workspaceId)}`, () => entries
    .filter(row => row.project_id != null && ((row.workspace_id == null && workspaceId == null)
      || row.workspace_id != null && workspaceId != null && String(row.workspace_id) === String(workspaceId)))
    .map(row => ({ ...row, shopping_list_id: row.project_id,
      list_known: Boolean(row.list_known ?? row.project_known ?? row.preferred) })));
  const route = suggestScopedRoute(adapted, name, projectId, { task: true });
  if (!route) return null;
  const { shopping_list_id, store_ids, stores_known, ...common } = route;
  return { ...common, workspace_id: workspaceId, project_id: shopping_list_id, project_known: route.list_known };
}

/** Reuse immutable model analysis across names; no query-result cache is retained. */
export function createPreparedRoutingMatcher(entries) {
  const catalog = structuredClone(entries);
  let policy = null;
  function current() {
    const next = JSON.stringify(rules);
    if (next !== policy) { policy = next; registerPreparedRows(catalog); }
    return catalog;
  }
  return Object.freeze({
    suggest: (name, listId = null) => structuredClone(suggestRoutingRoute(current(), name, listId)),
    suggestTask: (name, workspaceId = null, projectId = null) => structuredClone(suggestTaskRoutingRoute(current(), name, workspaceId, projectId)),
    matchField: (name, field, containerId = null) => structuredClone(matchRoutingField(current(), name, field, containerId)),
  });
}
