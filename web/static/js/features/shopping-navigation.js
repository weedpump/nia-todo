import {
  bindEntitySidebarNavigation,
  classifyEntityOwnership,
  renderEntitySidebarRow,
  renderEntitySidebarSection,
} from './entity-sidebar.js';
import { escapeHtml, escapeHtmlAttr } from '../core/utils.js';
import { iconSvg, markerHtml } from '../icons/lucide-icons.js';
import { niaIconSvg } from '../icons/nia-product-icons.js';
import { getActiveLocale, t } from '../i18n/index.js';
import { renderSectionCollection } from './section-ui.js';
import { renderShoppingItem } from './shopping-items.js';
import { bindShoppingStoreCreator, renderShoppingStoreCreator } from './shopping-store-creator.js';
import { closeOpenDropdown, hydrateSelect } from '../ui/dropdowns.js';

export const SHOPPING_ACTIVE_LIST_KEY = 'nia-shopping-active-list';
export const SHOPPING_STORE_FILTER_KEY_PREFIX = 'nia-shopping-store-filter:';

function compareLists(left, right) {
  const leftOrder = Number.isFinite(Number(left?.sort_order)) ? Number(left.sort_order) : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(Number(right?.sort_order)) ? Number(right.sort_order) : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(left?.name || '').localeCompare(String(right?.name || '')) || String(left?.id || '').localeCompare(String(right?.id || ''));
}

function openItemCount(list) {
  return (list?.items || []).filter(item => !item.completed).length;
}

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function compareStores(left, right) {
  const leftOrder = Number.isFinite(Number(left?.sort_order)) ? Number(left.sort_order) : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(Number(right?.sort_order)) ? Number(right.sort_order) : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(left?.name || '').localeCompare(String(right?.name || '')) || String(left?.id || '').localeCompare(String(right?.id || ''));
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
  getStores = () => [],
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
  onRender = () => {},
  sectionRegistry = null,
  sectionAdapter = null,
  itemController = null,
  storeController = null,
} = {}) {
  let localLists = null;
  let activeListId = null;
  let bound = false;
  let binding = null;
  let applyingHistory = false;
  let registeredSectionRoot = null;
  let storeCreator = null;
  let searchQuery = '';

  function normalizedSearch(value) {
    return String(value || '').trim().toLocaleLowerCase();
  }

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

  function storeFilterKey(list) {
    const identity = list?.client_mutation_id ?? list?.id;
    return identity == null ? null : `${SHOPPING_STORE_FILTER_KEY_PREFIX}${identity}`;
  }

  function activeStores() {
    return [...(getStores() || [])].filter(store => store?.active !== false).sort(compareStores);
  }

  function storeFilterForList(list, stores = activeStores()) {
    const key = storeFilterKey(list);
    if (!key) return null;
    let storedId = null;
    try {
      storedId = storage?.getItem?.(key) || null;
    } catch {
      return null;
    }
    if (storedId == null) return null;
    const store = stores.find(candidate => sameId(candidate.id, storedId) || sameId(candidate.client_mutation_id, storedId));
    if (!store) {
      if ((getStores() || []).length === 0) return storedId;
      try {
        storage?.removeItem?.(key);
      } catch {
        // Keep rendering without a filter when localStorage cleanup fails.
      }
      return null;
    }
    if (!sameId(store.id, storedId)) {
      try {
        storage?.setItem?.(key, String(store.id));
      } catch {
        // The resolved filter remains usable for this render.
      }
    }
    return store.id;
  }

  function sameList(left, right) {
    if (!left || !right) return false;
    return sameId(left.id, right.id)
      || sameId(left.client_mutation_id, right.id)
      || sameId(left.id, right.client_mutation_id)
      || sameId(left.client_mutation_id, right.client_mutation_id);
  }

  function setStoreFilterForList(list, value) {
    if (!list) return null;
    const stores = activeStores();
    const selected = value === undefined || value === null || String(value) === ''
      ? null
      : stores.find(store => sameId(store.id, value) || sameId(store.client_mutation_id, value)) || null;
    if (value !== undefined && value !== null && String(value) !== '' && !selected) return storeFilterForList(list, stores);
    const key = storeFilterKey(list);
    try {
      if (selected) storage?.setItem?.(key, String(selected.id));
      else storage?.removeItem?.(key);
    } catch {
      // A localStorage failure must not enter any durable or synchronized path.
    }
    const activeList = lists().find(candidate => sameId(candidate.id, activeListId));
    if (sameList(activeList, list)) renderMain();
    return selected?.id ?? null;
  }

  function setStoreFilter(value) {
    const list = lists().find(candidate => sameId(candidate.id, activeListId));
    return setStoreFilterForList(list, value);
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
    storeCreator?.destroy?.();
    storeCreator = null;
    const previousStoreSelect = getElementById('shopping-store-filter');
    if (previousStoreSelect?.nextElementSibling?.classList?.contains('is-open')) closeOpenDropdown('rerender');
    const selected = lists().find(list => String(list.id) === String(activeListId));
    if (!selected) {
      itemController?.bindRoot?.(null);
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
    const stores = activeStores();
    const storedStoreId = storeFilterForList(selected, stores);
    const selectedStore = stores.find(store => sameId(store.id, storedStoreId)) || null;
    const selectedStoreId = selectedStore?.id ?? null;
    const marketItems = selectedStoreId == null
      ? items
      : items.filter(item => {
        const storeIds = Array.isArray(item.store_ids) ? item.store_ids : [];
        return storeIds.some(storeId => sameId(storeId, selectedStoreId) || sameId(storeId, selectedStore?.client_mutation_id));
      });
    const search = normalizedSearch(searchQuery);
    const visibleItems = search
      ? marketItems.filter(item => normalizedSearch(item.name).includes(search))
      : marketItems;
    const hideEmptySections = selected.preferences?.hide_empty_sections === true;
    const visibleSections = hideEmptySections || search
      ? sections.filter(section => visibleItems.some(item => String(item.section_id) === String(section.id)))
      : sections;
    const hasItems = visibleItems.length > 0;
    const hasSectionContent = hasItems || visibleSections.length > 0;
    const validSectionIds = new Set(sections.map(section => String(section.id)));
    const hasUnsortedItems = visibleItems.some(item => item.section_id == null || !validSectionIds.has(String(item.section_id)));
    const sectionHtml = renderSectionCollection({
      sections: visibleSections,
      items: visibleItems,
      canManage: selected.can_manage === true,
      unsortedLabel: t('shopping.section.unsorted'),
      deleteLabel: t('section.delete'),
      newLabel: t('section.new'),
      renderItem: item => renderShoppingItem({
        item,
        canEdit: selected.can_edit === true,
        locale: getActiveLocale(),
        labels: {
          markCompleted: t('shopping.item.markCompleted', { name: item.name || '' }),
          markOpen: t('shopping.item.markOpen', { name: item.name || '' }),
          swipeComplete: t('shopping.item.swipeComplete'),
          swipeReopen: t('shopping.item.swipeReopen'),
          edit: t('shopping.item.edit', { name: item.name || '' }),
        },
      }),
      showUnsorted: hasUnsortedItems,
    });
    main.dataset.shoppingNavigationState = 'selected';
    const emptyContentState = search ? 'search-empty' : (selectedStoreId != null ? 'filter-empty' : 'empty');
    main.dataset.shoppingContentState = hasSectionContent ? 'populated' : emptyContentState;
    main.className = 'module-page shopping-list-content-page';
    const storeOptions = stores.map(store => `
      <option value="${escapeHtmlAttr(store.id)}" ${sameId(store.id, selectedStoreId) ? 'selected' : ''}>${escapeHtml(store.name || '')}</option>
    `).join('');
    main.innerHTML = `
      <header class="shopping-list-content-header">
        <div class="shopping-list-content-identity">
          <span class="shopping-list-content-marker" aria-hidden="true">${markerHtml(selected)}</span>
          <h1>${escapeHtml(selected.name || '')}</h1>
        </div>
        <div class="shopping-list-store-filter">
          <label class="visually-hidden" for="shopping-store-filter">${escapeHtml(t('shopping.filter.store.label'))}</label>
          <select id="shopping-store-filter" data-ui-select>
            <option value="" ${selectedStoreId == null ? 'selected' : ''}>${escapeHtml(t('shopping.filter.store.all'))}</option>
            ${storeOptions}
          </select>
        </div>
        ${renderShoppingStoreCreator({ prefix: 'shopping-filter-store', className: 'shopping-list-store-creator' })}
      </header>
      <div class="shopping-list-content-body" data-section-root="shopping">
        ${sectionHtml}
        ${hasSectionContent ? '' : `
          <div class="empty-state ${search ? 'shopping-search-empty-state' : (selectedStoreId != null ? 'shopping-store-filter-empty-state' : 'shopping-list-empty-state')}">
            <div class="emoji" aria-hidden="true">${iconSvg(search ? 'search' : (selectedStoreId != null ? 'store' : 'shopping-cart'))}</div>
            <h3>${escapeHtml(t(search ? 'shopping.search.empty' : (selectedStoreId != null ? 'shopping.filter.store.empty' : 'shopping.list.emptyTitle')))}</h3>
            ${search || selectedStoreId != null ? '' : `<p>${escapeHtml(t('shopping.list.emptyHint'))}</p>`}
          </div>
        `}
      </div>
    `;
    const storeSelect = getElementById('shopping-store-filter');
    if (storeSelect) {
      storeCreator = bindShoppingStoreCreator({
        document: root,
        prefix: 'shopping-filter-store',
        selectId: 'shopping-store-filter',
        storeController,
        getContext: () => ({ id: selected.id, client_mutation_id: selected.client_mutation_id }),
        onCreated: (store, list) => setStoreFilterForList(list, store.client_mutation_id ?? store.id),
      });
      storeSelect.addEventListener('change', () => {
        setStoreFilter(storeSelect.value);
      });
      hydrateSelect(storeSelect, {
        action: {
          label: t('shopping.item.store.add'),
          ariaLabel: t('shopping.item.store.add'),
          icon: 'plus',
          onActivate: () => storeCreator?.show?.(),
        },
      });
    }
    const nextSectionRoot = main.querySelector?.('[data-section-root="shopping"]') || null;
    if (registeredSectionRoot && registeredSectionRoot !== nextSectionRoot) sectionRegistry?.unregister?.(registeredSectionRoot);
    if (nextSectionRoot && sectionAdapter) sectionRegistry?.register?.(nextSectionRoot, sectionAdapter);
    registeredSectionRoot = nextSectionRoot;
    itemController?.bindRoot?.(nextSectionRoot);
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
    onRender();
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

  function setSearchQuery(value) {
    const next = String(value || '');
    if (next === searchQuery) return;
    searchQuery = next;
    renderMain();
  }

  function handlePopState(event) {
    const id = resolveActiveShoppingListId(lists(), listIdFromNavigation(event) ?? readStoredActiveListId());
    if (id == null || String(id) === String(activeListId)) return;
    applyingHistory = true;
    selectList(id, { updateNavigation: false });
    applyingHistory = false;
  }

  function handleLanguageChange() {
    renderMain();
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
    eventTarget?.addEventListener?.('nia-language-change', handleLanguageChange);
  }

  return {
    bind,
    activate,
    render,
    replaceLists,
    setSearchQuery,
    selectList,
    setStoreFilter,
    normalizeActiveListNavigation,
    focusActiveListAction,
    getActiveListId: () => activeListId,
    getStoreFilter: () => {
      const list = lists().find(candidate => sameId(candidate.id, activeListId));
      return list ? storeFilterForList(list) : null;
    },
    destroy() {
      binding?.destroy?.();
      eventTarget?.removeEventListener?.('popstate', handlePopState);
      eventTarget?.removeEventListener?.('nia-language-change', handleLanguageChange);
      storeCreator?.destroy?.();
      storeCreator = null;
      itemController?.bindRoot?.(null);
      binding = null;
      bound = false;
    },
  };
}
