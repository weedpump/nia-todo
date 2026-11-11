import { escapeHtmlAttr } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';

export function normalizeQuickAddName(value) {
  return String(value || '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function escapeQuickAddRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveQuickAddNamedEntity(name, entities = []) {
  const wanted = normalizeQuickAddName(name).replace(/\s/g, '');
  const found = wanted ? entities.filter(entity => normalizeQuickAddName(entity.name).replace(/\s/g, '') === wanted) : [];
  return { entity: found.length === 1 ? found[0] : null, ambiguous: found.length > 1 };
}

/** Shared, escaped chips for parsed and automatically applied field values. */
function quickAddChipData(match, t) {
  const remembered = match.source === 'memory';
  return { className: `quick-add-chip ${match.type || ''}`.trim(), label: match.label || '', value: match.value ?? match.token ?? '',
    remembered, title: remembered ? t('routingMemory.applied') : '', icon: remembered ? iconSvg('sparkles') : '' };
}

export function renderQuickAddChips(matches = [], t = key => key) {
  return matches.map(match => {
    const data = quickAddChipData(match, t);
    return `<span class="${escapeHtmlAttr(data.className)}"${data.remembered ? ` data-source="memory" title="${escapeHtmlAttr(data.title)}"` : ''}>${data.icon ? `<span class="quick-add-memory-icon" role="img" aria-label="${escapeHtmlAttr(data.title)}">${data.icon}</span>` : ''}<span class="quick-add-chip-label">${escapeHtmlAttr(data.label)}</span><strong>${escapeHtmlAttr(data.value)}</strong></span>`;
  }).join('');
}

export function renderQuickAddPreview(element, result, t = key => key) {
  if (!element) return;
  element.replaceChildren();
  const append = (className, text) => {
    const item = element.ownerDocument.createElement('span');
    item.className = className;
    item.textContent = text;
    element.appendChild(item);
  };
  for (const match of result?.matches || []) {
    const data = quickAddChipData(match, t), doc = element.ownerDocument;
    const chip = doc.createElement('span'); chip.className = data.className;
    if (data.remembered) {
      chip.setAttribute('data-source', 'memory'); chip.setAttribute('title', data.title);
      const icon = doc.createElement('span'); icon.className = 'quick-add-memory-icon';
      icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', data.title); icon.innerHTML = data.icon;
      chip.appendChild(icon);
    }
    const label = doc.createElement('span'); label.className = 'quick-add-chip-label'; label.textContent = data.label;
    const value = doc.createElement('strong'); value.textContent = data.value;
    chip.appendChild(label); chip.appendChild(value); element.appendChild(chip);
  }
  for (const key of result?.errors || []) append('quick-add-chip quick-add-error error', t(key));
  for (const key of result?.warnings || []) append('quick-add-chip quick-add-warning warning', t(key));
  element.hidden = !element.children.length;
}

export function createQuickAddPreviewController({ input, getContext = () => null, parse, render, isActive = () => true, onError }) {
  let destroyed = false;
  let generation = 0;
  const refresh = async () => {
    const current = ++generation;
    let valid = () => !destroyed && generation === current;
    try {
      if (destroyed || !isActive()) return null;
      const value = input.value;
      const context = getContext();
      // Context is a JSON-compatible identity/locale snapshot, not object identity.
      const contextSnapshot = JSON.stringify(context);
      valid = () => !destroyed && generation === current && isActive() && input.value === value && JSON.stringify(getContext()) === contextSnapshot;
      const result = await parse(value, context);
      if (!valid()) return null;
      await render(result);
      return valid() ? result : null;
    } catch (error) {
      try { if (valid()) await onError?.(error); } catch { /* Event handlers must not reject. */ }
      return null;
    }
  };
  // Preview is read-only, so composing text can be parsed without confirming it.
  const onInput = () => { void refresh(); };
  const onStart = () => { generation++; };
  const onEnd = () => { void refresh(); };
  input.addEventListener('input', onInput);
  input.addEventListener('compositionstart', onStart);
  input.addEventListener('compositionend', onEnd);
  return {
    refresh,
    invalidate() { generation++; },
    destroy() {
      destroyed = true; generation++;
      input.removeEventListener('input', onInput);
      input.removeEventListener('compositionstart', onStart);
      input.removeEventListener('compositionend', onEnd);
    },
  };
}

export function getQuickAddAliases(t, key) {
  const value = t?.(key);
  return typeof value === 'string' && value !== key
    ? value.split('|').map(alias => alias.trim().toLowerCase()).filter(Boolean) : [];
}
