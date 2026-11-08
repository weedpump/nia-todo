import { t } from '../i18n/index.js';
import { escapeHtml } from '../core/utils.js';
import { niaIconSvg } from '../icons/nia-product-icons.js';
import { bindEntitySidebarNavigation, classifyEntityOwnership, renderEntitySidebarAddRow, renderEntitySidebarRow, renderEntitySidebarSection } from './entity-sidebar.js';
import { createEntityInvitationsFeature, renderEntityInvitationsHost } from './entity-invitations.js';
import { createEntityAccessPrivacyController } from './entity-access-privacy.js';

export const COOKBOOK_ACTIVE_KEY = 'nia-recipes-active-cookbook';
const sameId = (left, right) => left != null && right != null && String(left) === String(right);
const ordered = values => [...values].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)
  || String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id)));

export function createCookbookNavigationFeature({
  getCookbooks = () => [], setCookbooks = () => {},
  getActorId = null,
  root = globalThis.document, eventTarget = globalThis.window,
  storage = globalThis.localStorage, historyTarget = globalThis.history,
  closeSidebar = () => false, onAdd = () => {}, onDetail = () => {},
  onCookbookIdRemap = () => {}, onDeactivate = () => {}, onRender = () => {},
  cookbookApi, loadAuthoritativeProjection = async () => null,
  recipeView = null,
  removePendingEntities = async () => {}, onError = console.error,
} = {}) {
  let activeId = null, bound = false, suspended = false, query = '';
  let sidebarBinding;
  let catalogReady = false;
  let accessibleCookbookIds = [];
  const receipts = new Map();
  const emptyIcon = niaIconSvg('recipes');
  const byId = id => getCookbooks().find(book => sameId(book.id, id));
  const ownReceipt = book => getActorId == null || (getActorId() != null && sameId(book?.created_by_user_id, getActorId()));
  const privacy = createEntityAccessPrivacyController({
    evictEntities: (ids, options) => removePendingEntities(ids, {
      ...options, getAccessibleEntities: () => ({ accessibleCookbookIds }),
    }), onError,
  });
  const invitations = createEntityInvitationsFeature({
    entityType: 'cookbook', root,
    listInvitations: async () => {
      const response = await cookbookApi.listInvites();
      privacy.beginGeneration();
      return (response?.invitations ?? response?.invites ?? response ?? []).filter(invite => invite.entity_type === 'cookbook');
    },
    normalizeInvitation: invite => ({ ...invite, entityId: invite.entity_id, name: invite.entity_name ?? invite.name }),
    respondInvitation: (invite, accept) => cookbookApi.respondInvite(invite.entityId, invite.id, accept),
    loadAuthoritativeProjection,
    applyAuthoritativeProjection: (projection, invitation, context) => {
      const books = projection?.cookbooks ?? projection;
      if (!Array.isArray(books) || context?.isCurrent?.() === false) throw new Error('Cookbook projection was not applicable');
      replaceCookbooks(books);
      commitAuthoritativeSnapshot(books);
    },
    render: state => {
      if (!suspended) privacy.schedulePending(state.invitations.map(invite => invite.entityId));
      renderEntityInvitationsHost({ document: root, sectionId: 'cookbook-invites-section', listId: 'cookbook-invites-list', entityType: 'cookbook', state });
    },
  });
  function persist() {
    try { if (activeId == null) storage?.removeItem?.(COOKBOOK_ACTIVE_KEY); else storage?.setItem?.(COOKBOOK_ACTIVE_KEY, String(activeId)); } catch { /* Optional preference. */ }
  }
  function route(replace = false) {
    const state = { ...(historyTarget?.state || {}), niaCookbookRoute: true, cookbookId: activeId, ...(recipeView ? { niaRecipeRoute: true, recipeId: recipeView.getActiveRecipeId() } : {}) };
    historyTarget?.[replace ? 'replaceState' : 'pushState']?.(state, '', `${eventTarget?.location?.pathname || '/'}${eventTarget?.location?.search || ''}`);
  }
  function resolve(id) {
    const exact = byId(id);
    if (exact) return exact;
    const seen = new Set();
    while (receipts.has(String(id)) && !seen.has(String(id))) { seen.add(String(id)); id = receipts.get(String(id)); }
    const book = byId(id);
    if (seen.size) return book && ownReceipt(book) ? book : null;
    // Canonical numeric IDs never become mutation aliases after access is lost.
    if (/^\d+$/.test(String(id))) return null;
    return getCookbooks().find(book => ownReceipt(book) && sameId(book.client_mutation_id, id));
  }
  function choose() {
    if (!catalogReady && getCookbooks().length === 0) return;
    if (byId(activeId)) return;
    let stored;
    try { stored = storage?.getItem?.(COOKBOOK_ACTIVE_KEY); } catch { /* Optional preference. */ }
    const values = ordered(getCookbooks());
    const fromHistory = activeId == null && historyTarget?.state?.niaCookbookRoute && historyTarget.state.moduleId === 'recipes' ? resolve(historyTarget.state.cookbookId)?.id : null;
    activeId = fromHistory ?? resolve(stored)?.id ?? ['personal', 'household', 'shared'].map(group => values.find(book => classifyEntityOwnership(book) === group)?.id).find(id => id != null) ?? null;
    persist();
  }
  function render() {
    choose();
    const sidebar = root?.getElementById?.('cookbook-sidebar');
    if (sidebar) {
      const html = ['personal', 'household', 'shared'].map(group => {
        const rows = ordered(getCookbooks()).filter(book => classifyEntityOwnership(book) === group
          && (recipeView || !query.trim() || `${book.name || ''} ${book.description || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))).map(book => renderEntitySidebarRow({
          entity: book, entityType: 'cookbook', active: sameId(book.id, activeId), count: book.recipe_count || 0,
        })).join('');
        return rows || group === 'personal' ? renderEntitySidebarSection({ section: group, rows,
          title: group === 'household' ? t('common.household') : group === 'shared' ? t('common.sharedWithMe') : '',
          icon: group === 'household' ? 'house-heart' : '' }) : '';
      }).join('');
      if (sidebar.innerHTML !== html) sidebar.innerHTML = html;
    }
    const main = root?.getElementById?.('cookbook-navigation-main');
    if (main) {
      const book = byId(activeId);
      if (book && recipeView) {
        recipeView.render({ cookbook: book, searchQuery: query });
      } else {
      recipeView?.clear?.();
      main.classList.remove('recipe-page'); main.classList.add('module-empty-page');
      main.classList.toggle('module-collection-page', Boolean(book));
      const noMatches = query.trim() && !getCookbooks().some(book => `${book.name || ''} ${book.description || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
      const html = `<div class="module-empty-icon" aria-hidden="true">${emptyIcon}</div>
        <h1>${escapeHtml(book?.name || t('cookbook.empty.title'))}</h1>
        ${book?.description ? `<p class="module-page-description">${escapeHtml(book.description)}</p>` : ''}
        <p>${escapeHtml(noMatches ? t('cookbook.search.empty') : book ? t('cookbook.recipes.empty') : t('cookbook.empty.body'))}</p>
        ${!book ? renderEntitySidebarAddRow({ entityType: 'cookbook', label: t('cookbook.sidebar.add'), labelKey: 'cookbook.sidebar.add' }) : ''}`;
      if (main.innerHTML !== html) main.innerHTML = html;
      }
    }
    onRender();
  }
  function selectCookbook(id, { replaceHistory = false, updateNavigation = true } = {}) {
    const book = resolve(id);
    if (!book) return false;
    activeId = book.id;
    recipeView?.showOverview?.({ updateNavigation: false });
    persist();
    if (updateNavigation) route(replaceHistory);
    render();
    return true;
  }
  function replaceCookbooks(books) {
    const previous = activeId;
    const previousBooks = [...getCookbooks()];
    catalogReady = true;
    setCookbooks(Array.isArray(books) ? books : []);
    for (const book of getCookbooks()) {
      if (ownReceipt(book) && book.client_mutation_id != null) {
        const old = previousBooks.find(candidate => ownReceipt(candidate)
          && String(candidate.id).startsWith('temp-') && !sameId(candidate.id, book.id)
          && sameId(candidate.client_mutation_id, book.client_mutation_id));
        const fromIds = new Set([old?.id, book.client_mutation_id].filter(id => id != null));
        for (const from of fromIds) {
          if (sameId(from, book.id)) continue;
          const exact = byId(from);
          if (/^\d+$/.test(String(from)) || (exact && !sameId(exact.id, book.id))) continue;
          if (!sameId(receipts.get(String(from)), book.id)) {
            receipts.set(String(from), book.id);
            onCookbookIdRemap(from, book.id);
          }
          if (sameId(previous, from)) activeId = book.id;
        }
      }
    }
    choose();
    render();
    if (String(previous) !== String(activeId)) route(true);
  }
  function handleHistory(event) {
    if (event.state?.niaModuleRoute && event.state.moduleId !== 'recipes') return;
    const id = event.state?.niaCookbookRoute ? event.state.cookbookId : null;
    if (id != null && resolve(id) && !sameId(resolve(id).id, activeId)) selectCookbook(id, { updateNavigation: false });
    recipeView?.applyHistory?.(event.state);
  }
  function remapCookbookId(from, to) {
    if (from == null || to == null || sameId(from, to)) return false;
    const target = byId(to);
    const exact = byId(from);
    if (exact && (!String(exact.id).startsWith('temp-') || !ownReceipt(exact)
      || !sameId(exact.client_mutation_id, target?.client_mutation_id))) return false;
    if (!target || !ownReceipt(target) || /^\d+$/.test(String(from))) return false;
    if (!sameId(target.client_mutation_id, from) && !sameId(receipts.get(String(from)), to)
      && !(exact && sameId(exact.client_mutation_id, target.client_mutation_id))) return false;
    receipts.set(String(from), to);
    if (!sameId(activeId, from) || !byId(to)) return false;
    activeId = byId(to).id; persist(); route(true); render();
    return true;
  }
  function bind() {
    if (bound) return;
    bound = true;
    invitations.bind();
    sidebarBinding = bindEntitySidebarNavigation({ root, entityType: 'cookbook', closeSidebar,
      onSelect: (id, context) => selectCookbook(id, { replaceHistory: context?.sidebarClosed }),
      onAdd, onDetail: id => { const book = resolve(id); if (book) onDetail(book.id); } });
    eventTarget?.addEventListener?.('popstate', handleHistory);
    eventTarget?.addEventListener?.('nia-language-change', render);
  }
  function deactivate() { recipeView?.deactivate?.(); onDeactivate(); }
  async function suspendAccessPrivacy() {
    suspended = true;
    const drain = privacy.suspend();
    invitations.destroy(); invitations.setInvitations([]);
    activeId = null; catalogReady = false; query = ''; accessibleCookbookIds = []; receipts.clear(); recipeView?.clear?.(); deactivate();
    await drain;
  }
  function resumeAccessPrivacy() { suspended = false; privacy.resume(); invitations.bind(); }
  function commitAuthoritativeSnapshot(books, revokedIds = []) {
    accessibleCookbookIds = (books || []).map(book => book.id);
    privacy.commitAccessible((books || []).map(book => book.id));
    privacy.schedulePending(revokedIds);
    render();
  }
  return { bind, render, activate: () => { bind(); recipeView?.activate?.(); render(); }, deactivate, replaceCookbooks,
    reconcile: render, getActiveCookbookId: () => activeId, selectCookbook, remapCookbookId,
    setRecipeView: view => { recipeView = view; view?.bind?.(); render(); },
    normalizeActiveCookbookNavigation: () => route(true),
    focusActiveCookbookAction: () => {
      const actions = Array.from(root?.querySelectorAll?.('[data-entity-sidebar-action][data-entity-type="cookbook"]') || []);
      actions.find(button => activeId == null ? button.dataset.entitySidebarAction === 'add'
        : button.dataset.entitySidebarAction === 'detail' && sameId(button.dataset.entityId, activeId))?.focus?.();
    },
    setSearchQuery: value => { query = String(value || ''); render(); },
    loadInvites: () => suspended ? Promise.resolve({ ok: false, stale: true }) : invitations.load(),
    setInvites: values => { if (suspended) return; privacy.beginGeneration(); invitations.setInvitations(values); },
    commitAuthoritativeSnapshot, suspendAccessPrivacy, resumeAccessPrivacy,
    destroy: () => { sidebarBinding?.destroy(); invitations.destroy(); eventTarget?.removeEventListener?.('popstate', handleHistory); eventTarget?.removeEventListener?.('nia-language-change', render); bound = false; },
  };
}
