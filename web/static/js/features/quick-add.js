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
    const chip = element.ownerDocument.createElement('span');
    chip.className = `quick-add-chip ${match.type || ''}`.trim();
    const label = element.ownerDocument.createElement('span');
    label.className = 'quick-add-chip-label';
    label.textContent = match.label;
    const value = element.ownerDocument.createElement('strong');
    value.textContent = match.value ?? match.token ?? '';
    chip.appendChild(label);
    chip.appendChild(value);
    element.appendChild(chip);
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
