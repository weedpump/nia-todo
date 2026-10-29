import {
  bindEntitySidebarNavigation,
  classifyEntityOwnership,
  renderEntitySidebarRow,
  renderEntitySidebarSection,
} from './entity-sidebar.js';
import { escapeHtml } from '../core/utils.js';
import { markerHtml } from '../icons/lucide-icons.js';
import { niaIconSvg } from '../icons/nia-product-icons.js';
import { t } from '../i18n/index.js';

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
} = {}) {
  let localLists = null;
  let activeListId = null;
  let bound = false;
  let binding = null;
  let applyingHistory = false;

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
    const state = { ...(historyTarget.state || {}), niaShoppingList: true, shoppingListId: String(id) };
    if (replace || historyTarget.state?.niaShoppingList !== true) historyTarget.replaceState(state, '', navigationUrl(id));
    else historyTarget.pushState(state, '', navigationUrl(id));
  }

  function renderMain() {
    const main = getElementById('shopping-navigation-main');
    if (!main) return;
    const selected = lists().find(list => String(list.id) === String(activeListId));
    if (!selected) {
      main.dataset.shoppingNavigationState = 'empty';
      main.innerHTML = `
        <div class="module-empty-icon" aria-hidden="true">${niaIconSvg('shopping')}</div>
        <h1>${escapeHtml(t('shopping.sidebar.emptyTitle'))}</h1>
        <p>${escapeHtml(t('shopping.sidebar.emptyHint'))}</p>
      `;
      return;
    }
    main.dataset.shoppingNavigationState = 'selected';
    main.innerHTML = `
      <div class="module-empty-icon" aria-hidden="true">${markerHtml(selected)}</div>
      <h1>${escapeHtml(selected.name || '')}</h1>
    `;
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
    getActiveListId: () => activeListId,
    destroy() {
      binding?.destroy?.();
      eventTarget?.removeEventListener?.('popstate', handlePopState);
      binding = null;
      bound = false;
    },
  };
}
