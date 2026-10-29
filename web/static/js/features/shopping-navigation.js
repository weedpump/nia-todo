import {
  bindEntitySidebarNavigation,
  classifyEntityOwnership,
  renderEntitySidebarRow,
  renderEntitySidebarSection,
} from './entity-sidebar.js';
import { escapeHtml } from '../core/utils.js';
import { iconSvg, markerHtml } from '../icons/lucide-icons.js';
import { niaIconSvg } from '../icons/nia-product-icons.js';
import { t } from '../i18n/index.js';
import { renderSectionCollection } from './section-ui.js';

export const SHOPPING_ACTIVE_LIST_KEY = 'nia-shopping-active-list';

function compareLists(left, right) {
  const leftOrder = Number.isFinite(Number(left?.sort_order)) ? Number(left.sort_order) : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(Number(right?.sort_order)) ? Number(right.sort_order) : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(left?.name || '').localeCompare(String(right?.name || '')) || String(left?.id || '').localeCompare(String(right?.id || ''));
}

function openItemCount(list) {
  return (list?.items || []).filter(item => !item.completed).length;
}

export function resolveActiveShoppingListId(lists, storedId = null) {
  const ordered = [...(lists || [])].sort(compareLists);
  const stored = ordered.find(list => String(list.id) === String(storedId));
  if (stored) return stored.id;
  for (const group of ['personal', 'household', 'shared']) {
    const first = ordered.find(list => classifyEntityOwnership(list) === group);
    if (first) return first.id;
  }
  return null;
}

export function renderShoppingSidebar({ lists = [], activeListId = null, labels } = {}) {
  const grouped = { personal: [], household: [], shared: [] };
  [...lists].sort(compareLists).forEach(list => {
    grouped[classifyEntityOwnership(list)].push(list);
  });

  const rowsFor = group => grouped[group].map(list => renderEntitySidebarRow({
    entity: list,
    entityType: 'shopping-list',
    active: String(list.id) === String(activeListId),
    count: openItemCount(list),
    rowClass: 'shopping-list-sidebar-item',
  })).join('');

  let html = renderEntitySidebarSection({
    section: 'personal',
    rows: rowsFor('personal'),
  });
  if (grouped.household.length) {
    html += renderEntitySidebarSection({
      section: 'household',
      title: labels.household,
      icon: 'house-heart',
      rows: rowsFor('household'),
    });
  }
  if (grouped.shared.length) {
    html += renderEntitySidebarSection({
      section: 'shared',
      title: labels.shared,
      rows: rowsFor('shared'),
    });
  }
  return html;
}

export function createShoppingNavigationFeature({
  getLists = () => [],
  setLists = null,
  root = document,
  getElementById = id => document.getElementById(id),
  storage = globalThis.localStorage,
  historyTarget = globalThis.history,
  locationTarget = globalThis.location,
  eventTarget = globalThis.window,
  closeSidebar,
  onAdd,
  onDetail,
  onListIdRemap = () => {},
  sectionRegistry = null,
  sectionAdapter = null,
} = {}) {
  let localLists = null;
  let activeListId = null;
  let bound = false;
  let binding = null;
  let applyingHistory = false;
  let registeredSectionRoot = null;

  function lists() {
    return localLists ?? getLists() ?? [];
  }

  function readStoredActiveListId() {
    try {
      return storage?.getItem?.(SHOPPING_ACTIVE_LIST_KEY) || null;
    } catch {
      return null;
    }
  }

  function persistActiveListId() {
    try {
      if (activeListId == null) storage?.removeItem?.(SHOPPING_ACTIVE_LIST_KEY);
      else storage?.setItem?.(SHOPPING_ACTIVE_LIST_KEY, String(activeListId));
    } catch {
      // Keep the in-memory selection when storage is unavailable.
    }
  }

  function listIdFromNavigation(event = null) {
    if (event?.state?.niaShoppingList === true) return event.state.shoppingListId;
    if (historyTarget?.state?.niaShoppingList === true) return historyTarget.state.shoppingListId;
    return new URLSearchParams(locationTarget?.search || '').get('shoppingList');
  }

  function navigationUrl(id) {
    const params = new URLSearchParams(locationTarget?.search || '');
    if (id == null) params.delete('shoppingList');
    else params.set('shoppingList', String(id));
    const search = params.toString();
    return `${locationTarget?.pathname || '/'}${search ? `?${search}` : ''}${locationTarget?.hash || ''}`;
  }

  function updateHistory(id, replace = false) {
    if (applyingHistory || !historyTarget) return;
    const state = {
      ...(historyTarget.state || {}),
      niaShoppingList: true,
      shoppingListId: id == null ? null : String(id),
    };
    if (replace || historyTarget.state?.niaShoppingList !== true) historyTarget.replaceState(state, '', navigationUrl(id));
    else historyTarget.pushState(state, '', navigationUrl(id));
  }

  function renderMain() {
    const main = getElementById('shopping-navigation-main');
    if (!main) return;
    const selected = lists().find(list => String(list.id) === String(activeListId));
    if (!selected) {
      main.dataset.shoppingNavigationState = 'empty';
      main.dataset.shoppingContentState = 'no-list';
      main.className = 'module-page module-empty-page';
      main.innerHTML = `
        <div class="module-empty-icon" aria-hidden="true">${niaIconSvg('shopping')}</div>
        <h1>${escapeHtml(t('shopping.sidebar.emptyTitle'))}</h1>
        <p>${escapeHtml(t('shopping.sidebar.emptyHint'))}</p>
      `;
      return;
    }
    const sections = Array.isArray(selected.sections) ? selected.sections : [];
    const items = Array.isArray(selected.items) ? selected.items : [];
    const hasItems = items.length > 0;
    const hasSectionContent = hasItems || sections.length > 0;
    const validSectionIds = new Set(sections.map(section => String(section.id)));
    const hasUnsortedItems = items.some(item => item.section_id == null || !validSectionIds.has(String(item.section_id)));
    const sectionHtml = renderSectionCollection({
      sections,
      items,
      canManage: selected.can_manage === true,
      unsortedLabel: t('shopping.section.unsorted'),
      deleteLabel: t('section.delete'),
      newLabel: t('section.new'),
      renderItem: item => `<div class="section-item-name">${escapeHtml(item.name || '')}</div>`,
      showUnsorted: hasUnsortedItems,
    });
    main.dataset.shoppingNavigationState = 'selected';
    main.dataset.shoppingContentState = hasSectionContent ? 'populated' : 'empty';
    main.className = 'module-page shopping-list-content-page';
    main.innerHTML = `
      <header class="shopping-list-content-header">
        <span class="shopping-list-content-marker" aria-hidden="true">${markerHtml(selected)}</span>
        <h1>${escapeHtml(selected.name || '')}</h1>
      </header>
      <div class="shopping-list-content-body" data-section-root="shopping">
        ${sectionHtml}
        ${hasSectionContent ? '' : `
          <div class="empty-state shopping-list-empty-state">
            <div class="emoji" aria-hidden="true">${iconSvg('shopping-cart')}</div>
            <h3>${escapeHtml(t('shopping.list.emptyTitle'))}</h3>
            <p>${escapeHtml(t('shopping.list.emptyHint'))}</p>
          </div>
        `}
      </div>
    `;
    const nextSectionRoot = main.querySelector?.('[data-section-root="shopping"]') || null;
    if (registeredSectionRoot && registeredSectionRoot !== nextSectionRoot) sectionRegistry?.unregister?.(registeredSectionRoot);
    if (nextSectionRoot && sectionAdapter) sectionRegistry?.register?.(nextSectionRoot, sectionAdapter);
    registeredSectionRoot = nextSectionRoot;
  }

  function render() {
    const nextActiveId = resolveActiveShoppingListId(lists(), activeListId ?? listIdFromNavigation() ?? readStoredActiveListId());
    if (String(nextActiveId ?? '') !== String(activeListId ?? '')) {
      activeListId = nextActiveId;
      persistActiveListId();
    } else if (nextActiveId == null) {
      activeListId = null;
      persistActiveListId();
    }
    const sidebar = getElementById('shopping-list-sidebar');
    if (sidebar) {
      sidebar.innerHTML = renderShoppingSidebar({
        lists: lists(),
        activeListId,
        labels: {
          personal: t('shopping.sidebar.personal'),
          household: t('common.household'),
          shared: t('common.sharedWithMe'),
          add: t('shopping.sidebar.add'),
        },
      });
    }
    renderMain();
  }

  function activate() {
    render();
    if (activeListId == null) return;
    const navigationId = listIdFromNavigation();
    if (historyTarget?.state?.niaShoppingList !== true || String(navigationId) !== String(activeListId)) {
      updateHistory(activeListId, true);
    }
  }

  function selectList(id, { replaceHistory = false, updateNavigation = true } = {}) {
    const selected = lists().find(list => String(list.id) === String(id));
    if (!selected) return false;
    activeListId = selected.id;
    persistActiveListId();
    if (updateNavigation) updateHistory(activeListId, replaceHistory);
    render();
    return true;
  }

  function normalizeActiveListNavigation() {
    updateHistory(activeListId, true);
  }

  function focusActiveListAction() {
    const target = activeListId == null
      ? root?.querySelector?.('[data-entity-sidebar-action="add"][data-entity-type="shopping-list"]')
      : Array.from(root?.querySelectorAll?.('[data-entity-sidebar-action="detail"][data-entity-type="shopping-list"]') || [])
        .find(button => String(button.dataset.entityId) === String(activeListId));
    target?.focus?.();
    return Boolean(target);
  }

  function replaceLists(nextLists) {
    const previousActiveListId = activeListId;
    const previousIds = new Set(lists().map(list => String(list.id)));
    const focusedDetailId = root?.activeElement?.matches?.('[data-entity-sidebar-action="detail"][data-entity-type="shopping-list"]')
      ? root.activeElement.dataset.entityId
      : null;
    localLists = Array.isArray(nextLists) ? nextLists : [];
    setLists?.(localLists);
    const remappedLists = localLists.filter(list => (
      list.client_mutation_id != null
      && previousIds.has(String(list.client_mutation_id))
      && !previousIds.has(String(list.id))
    ));
    const focusedRemap = remappedLists.find(list => String(list.client_mutation_id) === String(focusedDetailId));
    for (const remapped of remappedLists) onListIdRemap(remapped.client_mutation_id, remapped.id);
    const activeStillExists = localLists.some(list => String(list.id) === String(previousActiveListId));
    if (!activeStillExists && previousActiveListId != null) {
      const remapped = remappedLists.find(list => String(list.client_mutation_id) === String(previousActiveListId));
      if (remapped) {
        activeListId = remapped.id;
        persistActiveListId();
        updateHistory(activeListId, true);
      }
    }
    render();
    if (focusedRemap) {
      Array.from(root?.querySelectorAll?.('[data-entity-sidebar-action="detail"][data-entity-type="shopping-list"]') || [])
        .find(button => String(button.dataset.entityId) === String(focusedRemap.id))
        ?.focus?.();
    }
  }

  function handlePopState(event) {
    const id = resolveActiveShoppingListId(lists(), listIdFromNavigation(event) ?? readStoredActiveListId());
    if (id == null || String(id) === String(activeListId)) return;
    applyingHistory = true;
    selectList(id, { updateNavigation: false });
    applyingHistory = false;
  }

  function bind() {
    if (bound) return;
    bound = true;
    binding = bindEntitySidebarNavigation({
      root,
      entityType: 'shopping-list',
      onSelect: (id, { sidebarClosed } = {}) => selectList(id, { replaceHistory: sidebarClosed }),
      onDetail,
      onAdd,
      closeSidebar,
    });
    eventTarget?.addEventListener?.('popstate', handlePopState);
  }

  return {
    bind,
    activate,
    render,
    replaceLists,
    selectList,
    normalizeActiveListNavigation,
    focusActiveListAction,
    getActiveListId: () => activeListId,
    destroy() {
      binding?.destroy?.();
      eventTarget?.removeEventListener?.('popstate', handlePopState);
      binding = null;
      bound = false;
    },
  };
}
