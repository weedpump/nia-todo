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
      <div id="${prefix}-mode" class="ui-segmented-control recipe-import-mode" role="group" aria-label="${escapeHtmlAttr(t('recipe.import.title'))}" data-i18n-aria-label-key="recipe.import.title" hidden><button type="button" class="ui-segmented-option" data-recipe-import-mode="link" aria-pressed="true">${text('recipe.import.modeLink')}</button><button type="button" class="ui-segmented-option" data-recipe-import-mode="text" aria-pressed="false">${iconSvg('sparkles')}${text('recipe.import.modeText')}</button></div>
      <div id="${prefix}-url-group" class="form-group"><label for="${prefix}-url">${text('recipe.import.urlLabel')}</label><input type="url" id="${prefix}-url" class="ui-field" required maxlength="2048" autocomplete="url" inputmode="url" placeholder="${escapeHtmlAttr(t('recipe.import.urlPlaceholder'))}" data-i18n-placeholder-key="recipe.import.urlPlaceholder"></div>
      <div id="${prefix}-text-group" class="form-group" hidden><label for="${prefix}-text">${text('recipe.ai.textLabel')}</label><textarea id="${prefix}-text" class="ui-field" rows="9" maxlength="32000" disabled placeholder="${escapeHtmlAttr(t('recipe.ai.textPlaceholder'))}" data-i18n-placeholder-key="recipe.ai.textPlaceholder"></textarea></div>
      <label id="${prefix}-image-option" class="recipe-import-image-option"><span class="ui-checkbox-label ui-checkbox-round"><input type="checkbox" id="${prefix}-include-image" checked><span class="ui-checkbox-box" aria-hidden="true">${iconSvg('check')}</span></span>${text('recipe.import.includeImage')}</label>
      <p class="recipe-step-hint">${text('recipe.import.reviewHint')}</p>
      <p id="${prefix}-status" class="form-error" role="status" aria-live="polite"></p>
    </form>`,
  });
}

const aiErrorKeys = new Set(['unavailable', 'notConfigured', 'invalidInput', 'failed', 'invalidResponse', 'tooLarge', 'busy', 'rateLimited', 'offline'].map(key => `recipe.ai.${key}`));
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
  editor, getBrainDumpAccess = () => false, onError = console.error, isOnline = () => globalThis.navigator?.onLine !== false,
} = {}) {
  const el = suffix => root.getElementById(`${prefix}-${suffix}`);
  let bound = false, generation = 0, session = null, bookRef = null, busy = null, errorKey = '', mode = 'link';
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
  const readState = () => mode === 'text' ? { text: el('text')?.value.trim() || '' } : { url: el('url')?.value.trim() || '', include_image: Boolean(el('include-image')?.checked) };
  const validInput = state => mode === 'text' ? getBrainDumpAccess() && Boolean(state.text) && state.text.length <= 32000 : validUrl(state.url);
  function refresh() {
    const available = permitted(), textMode = mode === 'text';
    if (el('mode')) el('mode').hidden = !getBrainDumpAccess();
    for (const button of el('mode')?.querySelectorAll('[data-recipe-import-mode]') || []) {
      button.setAttribute('aria-pressed', String(button.dataset.recipeImportMode === mode));
      button.disabled = Boolean(busy) || !available;
    }
    if (el('url-group')) el('url-group').hidden = textMode;
    if (el('text-group')) el('text-group').hidden = !textMode;
    if (el('image-option')) el('image-option').hidden = textMode;
    if (el('url')) { el('url').disabled = textMode || Boolean(busy) || !available; el('url').required = !textMode; }
    if (el('text')) { el('text').disabled = !textMode || Boolean(busy) || !available; el('text').required = textMode; }
    if (el('include-image')) el('include-image').disabled = textMode || Boolean(busy) || !available;
    const submitKey = textMode ? 'recipe.ai.create' : 'recipe.import.submit';
    if (el('save-btn')) el('save-btn').innerHTML = text(submitKey);
    el('form')?.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (el('status')) el('status').textContent = busy ? t(textMode ? 'recipe.ai.creating' : 'recipe.import.loading')
      : errorKey ? t(errorKey) : !isOnline() ? t(textMode ? 'recipe.ai.offline' : 'recipe.import.offline') : '';
    modal.refreshSaveState();
  }
  function setMode(next) {
    if (!['link', 'text'].includes(next) || (next === 'text' && !getBrainDumpAccess()) || !active() || !permitted()) return false;
    invalidate(); mode = next; errorKey = ''; refresh();
    el(mode === 'text' ? 'text' : 'url')?.focus();
    return true;
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
    if (!isOnline()) { errorKey = mode === 'text' ? 'recipe.ai.offline' : 'recipe.import.offline'; refresh(); return; }
    const input = readState();
    if (!validInput(input)) { errorKey = mode === 'text' ? 'recipe.ai.invalidInput' : 'recipe.import.invalidUrl'; refresh(); return; }
    if (mode === 'text' && (!getBrainDumpAccess() || typeof api?.aiPreview !== 'function')) { errorKey = 'recipe.ai.unavailable'; refresh(); return; }
    if (!el('form').reportValidity()) return;
    const captured = generation, capturedSession = session, capturedMode = mode;
    const token = { controller: typeof AbortController === 'undefined' ? null : new AbortController() };
    const isCurrent = () => captured === generation && capturedSession === getSessionIdentity() && active() && permitted() && busy === token && mode === capturedMode && (capturedMode !== 'text' || getBrainDumpAccess());
    busy = token; errorKey = ''; refresh();
    try {
      const response = await (capturedMode === 'text' ? api.aiPreview(input, { signal: token.controller?.signal }) : api.importPreview(input, { signal: token.controller?.signal }));
      if (!isCurrent()) return;
      // Opening another editor while this page is being read always wins.
      if (root.getElementById('recipe-modal')?.classList.contains('active')) { deactivate(); return; }
      const target = currentBook();
      const draft = response?.draft && validateRecipeChanges(response.draft, true);
      if (!draft) throw new Error('Invalid import response');
      const warnings = Array.isArray(response.warnings) ? response.warnings.filter(key => typeof key === 'string' && /^(?:recipe\.import\.|recipe\.ai\.)/u.test(key)) : [];
      invalidate();
      const handoffGeneration = generation;
      modal.close({ afterClose: () => {
        if (generation !== handoffGeneration || active() || capturedSession !== getSessionIdentity() || ![true, 1].includes(currentBook()?.can_edit)
          || !sameEntityId(currentBook()?.id, target.id)
          || root.getElementById('recipe-modal')?.classList.contains('active') || (capturedMode === 'text' && !getBrainDumpAccess())) return;
        editor.showImport(draft, target.id, { warnings, reviewHint: capturedMode === 'text' ? 'recipe.ai.reviewHint' : 'recipe.import.reviewHint' });
      } });
    } catch (error) {
      if (!isCurrent()) return;
      const code = error.code || error.data?.detail?.code;
      errorKey = (capturedMode === 'text' ? aiErrorKeys : errorKeys).has(code) ? code : capturedMode === 'text' ? 'recipe.ai.failed' : 'recipe.import.failed';
      onError(error);
    } finally { if (busy === token) { busy = null; refresh(); } }
  }
  const modal = createEntityEditorModalController({ prefix, document: root, requireChanges: false,
    readState, isValid: validInput, canSubmit: () => active() && permitted() && isOnline() && !busy && (mode !== 'text' || getBrainDumpAccess()),
    resolveView: () => ({ mode: 'action', titleKey: 'recipe.import.title', canDelete: false,
      restoreFocus: () => root.querySelector('[data-recipe-action="import"]') }),
    renderDomain: () => { mode = 'link'; el('url').value = ''; el('text').value = ''; el('include-image').checked = true; }, onSubmit: submit, onError,
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
    if (mode === 'text' && !getBrainDumpAccess()) { invalidate(); mode = 'link'; errorKey = 'recipe.ai.unavailable'; }
    refresh(); return false;
  }
  function remapCookbookId(from, to) {
    if (!sameEntityId(bookRef?.id, from)) return false;
    bookRef.id = to; reconcile(); return true;
  }
  function bind() {
    if (bound) return; bound = true; modal.bind();
    el('mode')?.addEventListener('click', event => { const button = event.target.closest('[data-recipe-import-mode]'); if (button && !button.disabled) setMode(button.dataset.recipeImportMode); });
    const win = root.defaultView || globalThis.window;
    win?.addEventListener('nia-language-change', () => { translatePage(el('modal')); refresh(); });
    win?.addEventListener('online', refresh); win?.addEventListener('offline', refresh);
    if (win?.MutationObserver && el('modal')) new win.MutationObserver(() => {
      if (!active() && busy) { invalidate(); refresh(); }
    }).observe(el('modal'), { attributes: true, attributeFilter: ['class'] });
  }
  return { bind, show, deactivate, reconcile, remapCookbookId, submit, setMode };
}
