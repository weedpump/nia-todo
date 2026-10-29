import { iconSvg } from '../icons/lucide-icons.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeHtmlAttr(value) {
  return escapeHtml(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

export function renderSectionHeader({ section = null, count = 0, canManage = true, unsortedLabel = '', deleteLabel = '' } = {}) {
  if (!section) {
    return `
      <div class="section-header section-unsorted" data-section-id="null">
        <span class="section-name">${escapeHtml(unsortedLabel)}</span>
        <span class="section-count">${count}</span>
      </div>
    `;
  }
  const id = escapeHtmlAttr(section.id);
  return `
    <div class="section-header" data-section-id="${id}"${canManage ? ' draggable="true"' : ''}>
      <span class="section-name"${canManage ? ` data-section-action="edit" data-section-id="${id}"` : ''}>${escapeHtml(section.name)}</span>
      <span class="section-count">${count}</span>
      ${canManage ? `<button class="section-delete" data-section-action="delete" data-section-id="${id}" title="${escapeHtmlAttr(deleteLabel)}">${iconSvg('x')}</button>` : ''}
    </div>
  `;
}

export function renderSectionCollection({
  sections = [],
  items = [],
  canManage = true,
  unsortedLabel = '',
  deleteLabel = '',
  newLabel = '',
  renderItem = () => '',
  sortItems = values => values,
  renderAddRow = null,
  showUnsorted = true,
} = {}) {
  const ordered = [...sections].sort((left, right) => Number(left?.sort_order ?? 0) - Number(right?.sort_order ?? 0));
  const validIds = new Set(ordered.map(section => String(section.id)));
  let html = '';
  ordered.forEach((section, index) => {
    const sectionItems = sortItems(items.filter(item => sameId(item.section_id, section.id)));
    if (canManage) html += `<div class="section-dropzone" data-drop-index="${index}"></div>`;
    html += renderSectionHeader({ section, count: sectionItems.length, canManage, deleteLabel });
    html += `<div class="section-todos" data-section-id="${escapeHtmlAttr(section.id)}">${sectionItems.map(renderItem).join('')}</div>`;
  });
  if (canManage && ordered.length) html += `<div class="section-dropzone" data-drop-index="${ordered.length}"></div>`;
  const unsorted = sortItems(items.filter(item => item.section_id == null || !validIds.has(String(item.section_id))));
  if (showUnsorted) {
    html += renderSectionHeader({ count: unsorted.length, canManage: false, unsortedLabel });
    html += `<div class="section-todos" data-section-id="null">${unsorted.map(renderItem).join('')}</div>`;
  }
  if (canManage) {
    html += renderAddRow ? renderAddRow() : `<div class="add-section-row"><button type="button" class="btn btn-secondary btn-small" data-section-action="show-add">${iconSvg('plus')} ${escapeHtml(newLabel)}</button></div>`;
  }
  return html;
}

export function createSectionRootRegistry() {
  const adapters = new WeakMap();
  function sectionRoot(node) {
    return node?.closest?.('[data-section-root]') || null;
  }
  return {
    register(root, adapter) {
      if (!root || !adapter) return () => {};
      adapters.set(root, adapter);
      return () => adapters.delete(root);
    },
    unregister(root) {
      adapters.delete(root);
    },
    resolve(node) {
      const root = sectionRoot(node);
      return root ? adapters.get(root) || null : null;
    },
    resolveRoot: sectionRoot,
    resolveSectionId(node, id) {
      const adapter = this.resolve(node);
      return adapter?.resolveSectionId?.(id) ?? id;
    },
  };
}

export function resolveSectionDropAdapter({ registry, taskAdapter, sourceAdapter, target } = {}) {
  const targetAdapter = registry?.resolve?.(target) || taskAdapter || null;
  return targetAdapter && targetAdapter === sourceAdapter ? sourceAdapter : null;
}

export function resolveSectionDragSourceAdapter({ registry, taskAdapter, target } = {}) {
  const adapter = registry?.resolve?.(target) || taskAdapter || null;
  return adapter?.canManage?.() ? adapter : null;
}

export function createSectionController({
  registry,
  root = document,
  confirmDanger,
  labels = {},
} = {}) {
  let bound = false;

  function label(adapter, key) {
    const value = adapter?.labels?.[key] ?? labels[key];
    return typeof value === 'function' ? value() : (value || '');
  }

  function liveRoot(adapter) {
    return adapter?.getRoot?.() || null;
  }

  function focusLive(adapter, selector) {
    queueMicrotask(() => liveRoot(adapter)?.querySelector?.(selector)?.focus?.());
  }

  function render(adapter) {
    adapter?.render?.();
  }

  function showAdd(adapter) {
    if (!adapter?.canManage?.()) return false;
    const row = liveRoot(adapter)?.querySelector?.('.add-section-row');
    if (!row) return false;
    const inputId = adapter.newInputId?.() || 'new-section-name';
    row.innerHTML = `
      <div class="inline-section-form">
        <input type="text" id="${escapeHtmlAttr(inputId)}" data-section-input="new" placeholder="${escapeHtmlAttr(label(adapter, 'namePlaceholder'))}" autocomplete="off">
        <button type="button" class="btn btn-secondary btn-icon" data-section-action="save-new" title="${escapeHtmlAttr(label(adapter, 'save'))}">${iconSvg('check')}</button>
        <button type="button" class="btn btn-secondary btn-icon" data-section-action="cancel" title="${escapeHtmlAttr(label(adapter, 'cancel'))}">${iconSvg('x')}</button>
      </div>`;
    focusLive(adapter, '[data-section-input="new"]');
    return true;
  }

  function showEdit(adapter, id) {
    if (!adapter?.canManage?.()) return false;
    const section = adapter.getSections?.().find(candidate => sameId(candidate.id, id));
    const header = Array.from(liveRoot(adapter)?.querySelectorAll?.('.section-header[data-section-id]') || [])
      .find(candidate => sameId(candidate.dataset.sectionId, id));
    if (!section || !header) return false;
    const inputId = adapter.editInputId?.(section.id) || `edit-section-name-${section.id}`;
    header.innerHTML = `
      <div class="inline-edit-form">
        <input type="text" id="${escapeHtmlAttr(inputId)}" data-section-input="edit" data-section-id="${escapeHtmlAttr(section.id)}" value="${escapeHtmlAttr(section.name)}" autocomplete="off">
        <button type="button" class="btn btn-secondary btn-icon" data-section-action="save-edit" data-section-id="${escapeHtmlAttr(section.id)}" title="${escapeHtmlAttr(label(adapter, 'save'))}">${iconSvg('check')}</button>
        <button type="button" class="btn btn-secondary btn-icon" data-section-action="cancel" title="${escapeHtmlAttr(label(adapter, 'cancel'))}">${iconSvg('x')}</button>
      </div>`;
    focusLive(adapter, `[data-section-input="edit"][data-section-id="${CSS.escape(String(section.id))}"]`);
    return true;
  }

  async function saveNew(adapter, input) {
    if (!adapter?.canManage?.()) return false;
    const name = input?.value?.trim();
    if (!name) return false;
    try {
      const created = await adapter.createSection?.(name);
      if (!created) return false;
      render(adapter);
      focusLive(adapter, `.section-name[data-section-id="${CSS.escape(String(created.id))}"]`);
      return true;
    } catch (error) {
      render(adapter);
      focusLive(adapter, '[data-section-action="show-add"]');
      adapter.onError?.(error);
      return false;
    }
  }

  async function saveEdit(adapter, id, input) {
    if (!adapter?.canManage?.()) return false;
    const name = input?.value?.trim();
    if (!name) return false;
    try {
      const updated = await adapter.renameSection?.(id, name);
      if (!updated) return false;
      render(adapter);
      focusLive(adapter, `.section-name[data-section-id="${CSS.escape(String(updated.id))}"]`);
      return true;
    } catch (error) {
      render(adapter);
      focusLive(adapter, `.section-name[data-section-id="${CSS.escape(String(id))}"]`);
      adapter.onError?.(error);
      return false;
    }
  }

  async function remove(adapter, id) {
    if (!adapter?.canManage?.()) return false;
    const confirmed = await confirmDanger?.({
      title: label(adapter, 'deleteTitle'),
      message: label(adapter, 'deleteMessage'),
      confirmText: label(adapter, 'deleteConfirm'),
      returnFocus: () => Array.from(liveRoot(adapter)?.querySelectorAll?.('.section-delete[data-section-id]') || [])
        .find(button => sameId(button.dataset.sectionId, id)),
    });
    if (!confirmed || !adapter?.canManage?.()) return false;
    try {
      const deleted = await adapter.deleteSection?.(id);
      if (!deleted) return false;
      render(adapter);
      focusLive(adapter, '[data-section-action="show-add"]');
      return true;
    } catch (error) {
      render(adapter);
      focusLive(adapter, `.section-delete[data-section-id="${CSS.escape(String(id))}"]`);
      adapter.onError?.(error);
      return false;
    }
  }

  async function onClick(event) {
    const target = event.target?.closest?.('[data-section-action]');
    if (!target) return;
    const adapter = registry.resolve(target);
    if (!adapter) return;
    event.preventDefault();
    event.stopPropagation();
    const action = target.dataset.sectionAction;
    if (action === 'show-add') showAdd(adapter);
    else if (action === 'edit') showEdit(adapter, registry.resolveSectionId(target, target.dataset.sectionId));
    else if (action === 'delete') await remove(adapter, registry.resolveSectionId(target, target.dataset.sectionId));
    else if (action === 'save-new') await saveNew(adapter, liveRoot(adapter)?.querySelector?.('[data-section-input="new"]'));
    else if (action === 'save-edit') {
      const id = registry.resolveSectionId(target, target.dataset.sectionId);
      await saveEdit(adapter, id, liveRoot(adapter)?.querySelector?.(`[data-section-input="edit"][data-section-id="${CSS.escape(String(target.dataset.sectionId))}"]`));
    } else if (action === 'cancel') render(adapter);
  }

  async function onKeydown(event) {
    const input = event.target?.closest?.('[data-section-input]');
    if (!input || !['Enter', 'Escape'].includes(event.key)) return;
    const adapter = registry.resolve(input);
    if (!adapter) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      render(adapter);
      return;
    }
    if (input.dataset.sectionInput === 'new') await saveNew(adapter, input);
    else await saveEdit(adapter, registry.resolveSectionId(input, input.dataset.sectionId), input);
  }

  return {
    bind() {
      if (bound) return;
      bound = true;
      root.addEventListener('click', onClick);
      root.addEventListener('keydown', onKeydown);
    },
    showAdd,
    showEdit,
  };
}
