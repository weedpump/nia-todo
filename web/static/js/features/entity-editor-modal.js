import { escapeHtmlAttr } from '../core/utils.js';
import { renderDetailModalFrame } from '../ui/detail-modal.js';
import { t } from '../i18n/index.js';
import { renderEntityAppearanceFields } from './entity-appearance.js';
import { renderEntityDetailHeader } from './entity-detail-header.js';
import { createFormSaveState } from './form-save-state.js';
import { openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';
import { isDropdownOpen } from '../ui/dropdowns.js';

function keyText(key) {
  return escapeHtmlAttr(t(key));
}

export function renderEntityEditorModal({
  prefix,
  icon,
  createTitleKey,
  subtitleKey,
  deleteKey,
  formContentHtml = '',
  sharingHtml = '',
  contentClassNames = [],
  headerClassNames = [],
} = {}) {
  if (!prefix || !icon || !createTitleKey || !subtitleKey || !deleteKey) {
    throw new TypeError('prefix, icon, createTitleKey, subtitleKey and deleteKey are required');
  }
  const modalId = `${prefix}-modal`;
  const formId = `${prefix}-form`;
  const menuId = `${prefix}-detail-header-menu`;
  return renderDetailModalFrame({
    id: modalId,
    contentClasses: ['modal-content', 'entity-modal-content', ...contentClassNames, 'ui-detail-modal-content'],
    rootAttributes: { role: 'dialog', 'aria-modal': 'true', 'aria-hidden': 'true', 'aria-labelledby': `${prefix}-modal-title` },
    headerHtml: renderEntityDetailHeader({
        headerClassNames,
        icon,
        title: { id: `${prefix}-modal-title`, key: createTitleKey },
        subtitle: { key: subtitleKey },
        actionsHtml: `
          <button type="submit" form="${escapeHtmlAttr(formId)}" class="btn btn-primary" id="${escapeHtmlAttr(prefix)}-save-btn" data-i18n-key="common.save">${keyText('common.save')}</button>
          <details class="ui-detail-header-menu-toggle" id="${escapeHtmlAttr(menuId)}" hidden>
            <summary id="${escapeHtmlAttr(menuId)}-trigger" aria-label="${keyText('common.more')}" data-i18n-aria-label-key="common.more"><span data-icon="menu"></span></summary>
            <div class="ui-detail-header-menu ui-menu" role="menu">
              <button type="button" class="ui-menu-item danger" id="${escapeHtmlAttr(prefix)}-delete-btn" role="menuitem"><span data-icon="trash-2"></span> <span data-i18n-key="${escapeHtmlAttr(deleteKey)}">${keyText(deleteKey)}</span></button>
            </div>
          </details>
          <button type="button" class="modal-close-x" data-close-modal="${escapeHtmlAttr(modalId)}" aria-label="${keyText('common.close')}" data-i18n-aria-label-key="common.close"><span data-icon="x"></span></button>
        `,
      }),
    bodyHtml: `
        <form id="${escapeHtmlAttr(formId)}" class="entity-modal-form ui-detail-shell">
          <input type="hidden" id="${escapeHtmlAttr(prefix)}-id">
          ${renderEntityAppearanceFields({ prefix })}
          ${formContentHtml}
        </form>
        ${sharingHtml}
    `,
  });
}

export function createEntityEditorModalController({
  prefix,
  document: doc = globalThis.document,
  appearanceController,
  ownershipController = null,
  sharingController = null,
  readState,
  isValid = state => Boolean(state?.name) && String(state.name).length <= 200,
  canSubmit = () => true,
  resolveView,
  renderDomain = () => {},
  applyDomainPermissions = () => {},
  clearError = () => {},
  onSubmit = () => {},
  onDelete = () => {},
  onError = console.error,
} = {}) {
  if (!prefix || !appearanceController || typeof readState !== 'function' || typeof resolveView !== 'function') {
    throw new TypeError('prefix, appearanceController, readState and resolveView are required');
  }

  const ids = {
    modal: `${prefix}-modal`,
    form: `${prefix}-form`,
    entityId: `${prefix}-id`,
    title: `${prefix}-modal-title`,
    name: `${prefix}-name`,
    save: `${prefix}-save-btn`,
    menu: `${prefix}-detail-header-menu`,
    menuTrigger: `${prefix}-detail-header-menu-trigger`,
    delete: `${prefix}-delete-btn`,
  };
  let bound = false;
  let saveState = null;
  let restoreFocus = null;
  let currentEntity = null;
  let currentContext = null;
  let currentView = null;
  let focusGeneration = 0;

  function element(id) {
    return doc?.getElementById?.(id) || null;
  }

  function ensureSaveState() {
    const form = element(ids.form);
    const button = element(ids.save);
    if (!form || !button) return null;
    if (!saveState || saveState.form !== form) {
      saveState?.destroy?.();
      saveState = createFormSaveState({ form, button, readState, isValid, canSubmit });
      saveState.form = form;
    }
    return saveState;
  }

  function syncDeleteMenu(canDelete) {
    const menu = element(ids.menu);
    const button = element(ids.delete);
    if (menu) {
      menu.hidden = !canDelete;
      if (!canDelete) menu.removeAttribute('open');
    }
    if (button) button.disabled = !canDelete;
  }

  function hide({ afterClose = null } = {}) {
    focusGeneration += 1;
    const modal = element(ids.modal);
    element(ids.menu)?.removeAttribute?.('open');
    modal?.classList?.remove?.('active');
    modal?.setAttribute?.('aria-hidden', 'true');
    const target = restoreFocus?.();
    restoreFocus = null;
    target?.focus?.();
    afterClose?.();
  }

  function close({ fromHistory = false, afterClose = null } = {}) {
    const modal = element(ids.modal);
    if (modal?.classList?.contains?.('active') && !fromHistory && requestCloseUiLayer(ids.modal, { reason: 'ui' }, { afterClose })) return true;
    hide({ afterClose });
    return true;
  }

  function applyView(entity, context, view, { resetBaseline = true } = {}) {
    const modal = element(ids.modal);
    const form = element(ids.form);
    if (!modal || !form) return false;
    const focusAtOpen = doc.activeElement;

    currentEntity = entity;
    currentContext = context;
    currentView = view;
    const requestedFocusGeneration = ++focusGeneration;
    element(ids.menu)?.removeAttribute?.('open');
    form.reset?.();
    const entityId = element(ids.entityId);
    if (entityId) entityId.value = entity?.id ?? '';
    renderDomain({ entity, context, view });
    appearanceController.setValues(view.appearance || {}, { editable: view.appearanceEditable !== false });
    const name = element(ids.name);
    if (name) {
      name.disabled = view.appearanceEditable === false;
      name.setAttribute?.('aria-readonly', view.appearanceEditable === false ? 'true' : 'false');
    }
    ownershipController?.render?.(entity, { canManage: view.ownershipCanManage !== false });
    Promise.resolve(sharingController?.setEntity?.(entity)).catch(onError);
    applyDomainPermissions({ entity, context, view });

    const title = element(ids.title);
    if (title && view.titleKey) {
      title.dataset.i18nKey = view.titleKey;
      title.textContent = t(view.titleKey);
    }
    form.classList?.toggle?.('entity-editor-readonly', Boolean(view.readOnly));
    syncDeleteMenu(Boolean(view.canDelete));
    clearError();
    restoreFocus = typeof view.restoreFocus === 'function' ? view.restoreFocus : null;

    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    if (resetBaseline) ensureSaveState()?.reset?.();

    globalThis.setTimeout?.(() => {
      if (requestedFocusGeneration !== focusGeneration || !modal.classList.contains('active')) return;
      if (doc.activeElement !== focusAtOpen && doc.activeElement !== doc.body && doc.activeElement?.isConnected) return;
      if (view.readOnly) modal.querySelector?.('.modal-close-x')?.focus?.();
      else if (view.mode === 'create' || view.mode === 'create-child') appearanceController.focusName?.();
    }, 0);
    return true;
  }

  function open(entity = null, context = {}) {
    const view = resolveView({ entity, context });
    if (!view) return false;
    const opened = applyView(entity, context, view);
    if (opened) openUiLayer(ids.modal);
    return opened;
  }

  function reconcile(entity = currentEntity, context = currentContext || {}) {
    const view = resolveView({ entity, context });
    if (!view) return false;
    return applyView(entity, context, view, { resetBaseline: false });
  }

  function bind() {
    if (bound) return;
    bound = true;
    const modal = element(ids.modal);
    if (modal) modal.dataset.entityEditorBound = 'true';
    ensureSaveState();
    element(ids.form)?.addEventListener?.('submit', onSubmit);
    element(ids.delete)?.addEventListener?.('click', event => {
      event.preventDefault?.();
      element(ids.menu)?.removeAttribute?.('open');
      onDelete(event);
    });
    registerUiLayer(ids.modal, () => hide());
    doc.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || !modal?.classList.contains('active')) return;
      if (doc.getElementById('confirm-modal')?.classList.contains('active')) return;
      const focusedModal = doc.activeElement?.closest?.('.modal.active');
      if (focusedModal && focusedModal !== modal) return;
      if (event.key === 'Escape') {
        if (isDropdownOpen()) return;
        event.preventDefault();
        const menu = modal.querySelector('details[open]');
        if (menu) { menu.removeAttribute('open'); menu.querySelector('summary')?.focus(); }
        else close();
        return;
      }
      if (event.key !== 'Tab' || isDropdownOpen()) return;
      const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])'))
        .filter(control => control.tabIndex >= 0 && !control.closest('[hidden], [inert]') && control.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if (!first) return;
      if (!modal.contains(doc.activeElement) || (event.shiftKey ? doc.activeElement === first : doc.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    });
  }

  return {
    bind,
    open,
    close,
    reconcile,
    canSave: () => ensureSaveState()?.canSave?.() || false,
    refreshSaveState: () => ensureSaveState()?.refresh?.(),
    resetSaveState: () => ensureSaveState()?.reset?.(),
    syncDeleteMenu,
    getCurrentEntity: () => currentEntity,
    getCurrentContext: () => currentContext,
    getCurrentView: () => currentView,
    ids,
  };
}
