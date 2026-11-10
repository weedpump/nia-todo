import { t, translatePage } from '../i18n/index.js';
import { escapeHtmlAttr } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { renderDetailModalFrame } from '../ui/detail-modal.js';
import { renderEntityDetailHeader } from './entity-detail-header.js';
import { createEntityEditorModalController } from './entity-editor-modal.js';
import { closeUiLayerNow } from './ui-history.js';
import { sameEntityId } from './entity-metadata.js';
import { validateRecipeChanges } from './recipe-pending.js';

const prefix = 'recipe-import';
const text = key => `<span data-i18n-key="${escapeHtmlAttr(key)}">${escapeHtmlAttr(t(key))}</span>`;
export function renderRecipeImportModal() {
  return renderDetailModalFrame({ id: `${prefix}-modal`,
    rootAttributes: { role: 'dialog', 'aria-modal': 'true', 'aria-hidden': 'true', 'aria-labelledby': `${prefix}-modal-title` },
    contentClasses: ['modal-content', 'entity-modal-content', 'ui-detail-modal-content', 'recipe-import-content'],
    headerHtml: renderEntityDetailHeader({ icon: 'download', title: { id: `${prefix}-modal-title`, key: 'recipe.import.title' },
      subtitle: { key: 'recipe.import.description' }, actionsHtml: `<button type="submit" form="${prefix}-form" id="${prefix}-save-btn" class="btn btn-primary">${text('recipe.import.submit')}</button><button type="button" class="modal-close-x" data-close-modal="${prefix}-modal" aria-label="${escapeHtmlAttr(t('common.close'))}" data-i18n-aria-label-key="common.close">${iconSvg('x')}</button>` }),
    bodyHtml: `<form id="${prefix}-form" class="entity-modal-form ui-detail-shell">
      <div class="form-group"><label for="${prefix}-url">${text('recipe.import.urlLabel')}</label><input type="url" id="${prefix}-url" class="ui-field" required maxlength="2048" autocomplete="url" inputmode="url" placeholder="${escapeHtmlAttr(t('recipe.import.urlPlaceholder'))}" data-i18n-placeholder-key="recipe.import.urlPlaceholder"></div>
      <label class="recipe-import-image-option"><span class="ui-checkbox-label ui-checkbox-round"><input type="checkbox" id="${prefix}-include-image" checked><span class="ui-checkbox-box" aria-hidden="true">${iconSvg('check')}</span></span>${text('recipe.import.includeImage')}</label>
      <p class="recipe-step-hint">${text('recipe.import.reviewHint')}</p>
      <p id="${prefix}-status" class="form-error" role="status" aria-live="polite"></p>
    </form>`,
  });
}

const errorKeys = new Set(['invalidUrl', 'blockedUrl', 'downloadFailed', 'tooLarge', 'unsupportedContent', 'notFound', 'invalidRecipe', 'busy', 'rateLimited', 'offline', 'targetUnavailable', 'failed'].map(key => `recipe.import.${key}`));
function validUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && raw.length <= 2048;
  } catch { return false; }
}

/** Public-page analysis creates only a local editor draft. No recipe is saved here. */
export function createRecipeImportFeature({ root = globalThis.document, api,
  getSessionIdentity = () => null, getCookbooks = () => [], getActiveCookbookId = () => null,
  editor, onError = console.error, isOnline = () => globalThis.navigator?.onLine !== false,
} = {}) {
  const el = suffix => root.getElementById(`${prefix}-${suffix}`);
  let bound = false, generation = 0, session = null, bookRef = null, busy = null, errorKey = '';
  const active = () => Boolean(el('modal')?.classList.contains('active'));
  const currentBook = () => {
    const books = getCookbooks();
    const exact = books.find(book => sameEntityId(book.id, bookRef?.id));
    if (exact) return exact;
    if (bookRef?.mutation == null || bookRef?.actor == null || !String(bookRef.id).startsWith('temp-')) return null;
    return books.find(book => sameEntityId(book.client_mutation_id, bookRef.mutation)
      && sameEntityId(book.created_by_user_id, bookRef.actor)) || null;
  };
  const permitted = () => session != null && session === getSessionIdentity()
    && [true, 1].includes(currentBook()?.can_edit);
  const readState = () => ({ url: el('url')?.value.trim() || '', include_image: Boolean(el('include-image')?.checked) });
  function refresh() {
    const available = permitted();
    if (el('url')) el('url').disabled = Boolean(busy) || !available;
    if (el('include-image')) el('include-image').disabled = Boolean(busy) || !available;
    el('form')?.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (el('status')) el('status').textContent = busy ? t('recipe.import.loading')
      : errorKey ? t(errorKey) : !isOnline() ? t('recipe.import.offline') : '';
    modal.refreshSaveState();
  }
  function invalidate() { generation++; busy?.controller?.abort(); busy = null; }
  function deactivate() {
    invalidate(); session = null; bookRef = null; errorKey = '';
    if (!closeUiLayerNow(`${prefix}-modal`, { reason: 'module-deactivate' })) modal.close({ fromHistory: true });
    refresh();
  }
  async function submit(event) {
    event?.preventDefault?.();
    if (!active() || !permitted() || busy) return;
    if (!isOnline()) { errorKey = 'recipe.import.offline'; refresh(); return; }
    const input = readState();
    if (!validUrl(input.url)) { errorKey = 'recipe.import.invalidUrl'; refresh(); return; }
    if (!el('form').reportValidity()) return;
    const captured = generation, capturedSession = session;
    const token = { controller: typeof AbortController === 'undefined' ? null : new AbortController() };
    const isCurrent = () => captured === generation && capturedSession === getSessionIdentity() && active() && permitted() && busy === token;
    busy = token; errorKey = ''; refresh();
    try {
      const response = await api.importPreview(input, { signal: token.controller?.signal });
      if (!isCurrent()) return;
      // Opening another editor while this page is being read always wins.
      if (root.getElementById('recipe-modal')?.classList.contains('active')) { deactivate(); return; }
      const target = currentBook();
      const draft = response?.draft && validateRecipeChanges(response.draft, true);
      if (!draft) throw new Error('Invalid import response');
      const warnings = Array.isArray(response.warnings) ? response.warnings.filter(key => typeof key === 'string' && key.startsWith('recipe.import.')) : [];
      invalidate();
      const handoffGeneration = generation;
      modal.close({ afterClose: () => {
        if (generation !== handoffGeneration || active() || capturedSession !== getSessionIdentity() || ![true, 1].includes(currentBook()?.can_edit)
          || !sameEntityId(currentBook()?.id, target.id)
          || root.getElementById('recipe-modal')?.classList.contains('active')) return;
        editor.showImport(draft, target.id, { warnings });
      } });
    } catch (error) {
      if (!isCurrent()) return;
      const code = error.code || error.data?.detail?.code;
      errorKey = errorKeys.has(code) ? code : 'recipe.import.failed';
      onError(error);
    } finally { if (busy === token) { busy = null; refresh(); } }
  }
  const modal = createEntityEditorModalController({ prefix, document: root, requireChanges: false,
    readState, isValid: state => validUrl(state.url), canSubmit: () => active() && permitted() && isOnline() && !busy,
    resolveView: () => ({ mode: 'action', titleKey: 'recipe.import.title', canDelete: false,
      restoreFocus: () => root.querySelector('[data-recipe-action="import"]') }),
    renderDomain: () => { el('url').value = ''; el('include-image').checked = true; }, onSubmit: submit, onError,
  });
  function show(cookbookId = getActiveCookbookId()) {
    const book = getCookbooks().find(row => sameEntityId(row.id, cookbookId));
    if (![true, 1].includes(book?.can_edit) || getSessionIdentity() == null
      || root.getElementById('recipe-modal')?.classList.contains('active')) return false;
    invalidate(); session = getSessionIdentity();
    bookRef = { id: book.id, mutation: book.client_mutation_id, actor: book.created_by_user_id };
    errorKey = ''; const opened = modal.open(null); refresh();
    if (opened) el('url')?.focus();
    return opened;
  }
  function reconcile() {
    if (!active()) return false;
    if (!permitted()) { deactivate(); return true; }
    refresh(); return false;
  }
  function remapCookbookId(from, to) {
    if (!sameEntityId(bookRef?.id, from)) return false;
    bookRef.id = to; reconcile(); return true;
  }
  function bind() {
    if (bound) return; bound = true; modal.bind();
    const win = root.defaultView || globalThis.window;
    win?.addEventListener('nia-language-change', () => { translatePage(el('modal')); refresh(); });
    win?.addEventListener('online', refresh); win?.addEventListener('offline', refresh);
    if (win?.MutationObserver && el('modal')) new win.MutationObserver(() => {
      if (!active() && busy) { invalidate(); refresh(); }
    }).observe(el('modal'), { attributes: true, attributeFilter: ['class'] });
  }
  return { bind, show, deactivate, reconcile, remapCookbookId, submit };
}
