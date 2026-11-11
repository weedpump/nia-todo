import { normalizeQuantityUnit, getQuantityUnitAliases, getQuantityUnitDefinition } from '../core/quantity-units.js';
import { getQuickAddAliases, escapeQuickAddRegExp, resolveQuickAddNamedEntity } from './quick-add.js';

const knownUnitPattern = getQuantityUnitAliases().sort((a,b) => b.length-a.length).map(escapeQuickAddRegExp).join('|');

export function parseShoppingQuickAdd(raw, { list, stores = [], locale = 'en', t = key => key } = {}) {
  const original = String(raw ?? '').trim();
  const quoted = original.match(/^(?:"([^"]*)"|'([^']*)')$/);
  const result = { title: quoted ? (quoted[1] ?? quoted[2]) : original, changes: {}, matches: [], errors: [], warnings: [] };
  // The editor validates its 500-character maximum; never parse a truncated name.
  if (quoted || original.length > 500) return result;
  const addError = name => {
    const key = `shopping.quickAdd.error.${name}`;
    if (!result.errors.includes(key)) result.errors.push(key);
  };
  const setField = (field, value) => {
    if (Object.hasOwn(result.changes, field) && JSON.stringify(result.changes[field]) !== JSON.stringify(value)) {
      addError('conflict');
      return false;
    }
    result.changes[field] = value;
    return true;
  };
  const aliases = key => getQuickAddAliases(t, `shopping.quickAdd.syntax.${key}`);
  let comma = false;
  try { comma = new Intl.NumberFormat(locale).formatToParts(1.1).some(part => part.type === 'decimal' && part.value === ','); } catch { /* Unknown locale uses decimal point. */ }
  const numberPattern = comma ? '\\d+(?:[.,]\\d+)?' : '\\d+(?:\\.\\d+)?';
  const units = knownUnitPattern;
  const leading = new RegExp(`^(${numberPattern})\\s*(${units ? `(?:${units})\\.*|` : ''}x)(?:\\s+|$)`, 'i').exec(original);
  const recognizedLeading = leading && (leading[2].toLowerCase() === 'x' || getQuantityUnitDefinition(leading[2]) != null);
  if (recognizedLeading && !original.slice(leading[0].length).trim()) addError('missingName');
  if (recognizedLeading && original.slice(leading[0].length).trim()) {
    const quantity = Number(leading[1].replace(',', '.'));
    if (Number.isFinite(quantity)) {
      result.changes.quantity_value = quantity;
      result.matches.push({type:'quantity',label:t('common.quantity'),value:quantity,token:leading[0].trim()});
      if (leading[2].toLowerCase() !== 'x') {
        result.changes.quantity_unit = normalizeQuantityUnit(leading[2]);
        result.matches.push({type:'unit',label:t('common.unit'),value:result.changes.quantity_unit,token:leading[0].trim()});
      }
      result.title = original.slice(leading[0].length);
    }
  }
  const sameId = (left, right) => left != null && right != null && String(left) === String(right);
  const activeStores = stores.filter(store => store.active !== false && (
    sameId(store.shopping_list_id, list?.id)
  ));
  const sectionPrefixes = getQuickAddAliases(t, 'quickAdd.syntax.sectionPrefixes');
  const storePrefixes = aliases('storePrefixes');
  const prefixTypes = new Map([
    ...sectionPrefixes.map(prefix => [prefix, 'section']),
    ...storePrefixes.map(prefix => [prefix, 'store']),
    ...aliases('quantityPrefixes').map(prefix => [prefix, 'quantity']),
    ...aliases('unitPrefixes').map(prefix => [prefix, 'unit']),
  ]);
  const prefixPattern = [...prefixTypes.keys()].sort((a,b)=>b.length-a.length).map(escapeQuickAddRegExp).join('|');
  const markers = new RegExp(`(^|\\s)(@|/|§${prefixPattern ? `|(?:${prefixPattern}):\\s*` : ''})`, 'gi');
  const text = result.title;
  const spans = [];
  // Quotes open only at a token/value boundary, never inside a product name.
  const quotedSpans = [...text.matchAll(/(^|[\s@/§:])(["'])(.*?)\2(?=\s|$)/g)]
    .map(match => [match.index + match[1].length, match.index + match[0].length]);
  let marker;
  while ((marker = markers.exec(text))) {
    const start = marker.index + marker[1].length;
    if (quotedSpans.some(([from,to]) => start >= from && start < to)) continue;
    const valueStart = markers.lastIndex;
    const type = marker[2] === '@' ? 'store' : marker[2] === '/' || marker[2] === '§' ? 'section' : prefixTypes.get(marker[2].split(':')[0].toLowerCase());
    const catalog = type === 'store' ? activeStores : list?.sections || [];
    const rest = text.slice(valueStart);
    const quotedName = rest.match(/^(["'])(.*?)\1(?=\s|$)/);
    if (type === 'quantity' || type === 'unit') {
      // An unfinished prefix must not swallow the next association.
      const nextMarker = !quotedName && new RegExp(`^(?:@|/|§${prefixPattern ? `|(?:${prefixPattern}):` : ''})`, 'i').test(rest);
      if (nextMarker && /\s/.test(text[valueStart-1] || '')) {
        if (type === 'quantity') addError('invalidQuantity');
        else if (!result.warnings.length) result.warnings.push('shopping.quickAdd.warning.unrecognized');
        markers.lastIndex = valueStart-1;
        continue;
      }
      const valueToken = quotedName || rest.match(/^\S+/);
      const rawValue = quotedName ? quotedName[2] : valueToken?.[0] || '';
      const value = type === 'quantity' ? Number(rawValue.replace(',', '.')) : normalizeQuantityUnit(rawValue);
      if (type === 'quantity' && (!new RegExp(`^${numberPattern}$`).test(rawValue) || !Number.isFinite(value))) {
        addError('invalidQuantity');
      } else if (rawValue) {
        const end = valueStart + valueToken[0].length;
        if (!setField(type === 'quantity' ? 'quantity_value' : 'quantity_unit', value)) continue;
        result.matches.push({type,label:t(type === 'quantity' ? 'common.quantity' : 'common.unit'),value,token:text.slice(start,end)});
        spans.push([start,end]);
        markers.lastIndex = end;
      }
      continue;
    }
    let resolved = null;
    let length = 0;
    if (quotedName) {
      resolved = resolveQuickAddNamedEntity(quotedName[2], catalog);
      length = quotedName[0].length;
    } else {
      const ends = [...rest.matchAll(/\S+(?=\s|$)/g)].map(match => match.index + match[0].length).reverse();
      for (const end of ends) {
        const candidate = resolveQuickAddNamedEntity(rest.slice(0,end), catalog);
        if (candidate.entity || candidate.ambiguous) { resolved = candidate; length = end; break; }
      }
    }
    if (resolved?.entity) {
      const entity = resolved.entity;
      const token = text.slice(start,valueStart+length);
      if (!setField(type === 'store' ? 'store_ids' : 'section_id', type === 'store' ? [entity.id] : entity.id)) continue;
      result.matches.push({type,label:t(type === 'store' ? 'shopping.item.store' : 'common.section'),value:entity.name,token});
      spans.push([start,valueStart+length]);
      markers.lastIndex = valueStart+length;
    } else if (resolved?.ambiguous) addError('ambiguous');
    else if (!result.warnings.length) result.warnings.push('shopping.quickAdd.warning.unrecognized');
  }
  for (const [from,end] of spans.reverse()) {
    let start = from;
    while (start > 0 && /\s/.test(text[start-1])) start--;
    result.title = result.title.slice(0,start) + result.title.slice(end);
  }
  if (spans.length) result.title = result.title.trim();
  if (!result.title) addError('missingName');
  return result;
}
