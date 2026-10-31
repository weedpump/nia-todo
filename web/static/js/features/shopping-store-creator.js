import { escapeHtmlAttr } from '../core/utils.js';
import { t } from '../i18n/index.js';
import { validShoppingStoreName } from './shopping-stores.js';

export function renderShoppingStoreCreator({ prefix, className = '' } = {}) {
  const classes = ['shopping-store-creator', className].filter(Boolean).join(' ');
  return `
    <div class="${escapeHtmlAttr(classes)}" id="${escapeHtmlAttr(prefix)}-new-store" hidden>
      <label for="${escapeHtmlAttr(prefix)}-new-store-name" data-i18n-key="shopping.store.name">${escapeHtmlAttr(t('shopping.store.name'))}</label>
      <div class="shopping-store-creator-row">
        <input class="ui-field" type="text" id="${escapeHtmlAttr(prefix)}-new-store-name" maxlength="120" autocomplete="off" data-i18n-placeholder-key="shopping.store.namePlaceholder" placeholder="${escapeHtmlAttr(t('shopping.store.namePlaceholder'))}">
        <button type="button" class="btn btn-primary" data-shopping-store-creator="${escapeHtmlAttr(prefix)}" data-shopping-store-creator-action="save" data-i18n-key="common.add">${escapeHtmlAttr(t('common.add'))}</button>
        <button type="button" class="btn btn-secondary" data-shopping-store-creator="${escapeHtmlAttr(prefix)}" data-shopping-store-creator-action="cancel" data-i18n-key="common.cancel">${escapeHtmlAttr(t('common.cancel'))}</button>
      </div>
      <div class="settings-field-error" id="${escapeHtmlAttr(prefix)}-store-error" role="alert"></div>
    </div>
  `;
}

export function bindShoppingStoreCreator({
  document: doc = globalThis.document,
  prefix,
  selectId = null,
  storeController,
  authorize = () => true,
  getContext = () => null,
  onCreated = () => {},
  onError = console.error,
} = {}) {
  const byId = suffix => doc?.getElementById?.(`${prefix}-${suffix}`);
  const actionButtons = () => Array.from(doc?.querySelectorAll?.(`[data-shopping-store-creator="${prefix}"]`) || []);
  let submitting = false;
  let creationContext = null;

  function setError(key = '') {
    const target = byId('store-error');
    if (target) target.textContent = key ? t(key) : '';
  }

  function setInvalid(invalid) {
    const input = byId('new-store-name');
    if (!input) return;
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function show() {
    const container = byId('new-store');
    const input = byId('new-store-name');
    if (!container || !input) return false;
    container.hidden = false;
    input.value = '';
    creationContext = getContext();
    setInvalid(false);
    setError();
    input.focus?.();
    return true;
  }

  function hide({ restoreFocus = false } = {}) {
    const container = byId('new-store');
    const input = byId('new-store-name');
    if (container) container.hidden = true;
    if (input) input.value = '';
    setInvalid(false);
    setError();
    if (restoreFocus && selectId) doc?.querySelector?.(`[data-select-id="${selectId}"] .ui-select-trigger`)?.focus?.();
  }

  async function save() {
    if (submitting) return null;
    const input = byId('new-store-name');
    const name = validShoppingStoreName(input?.value);
    if (!name) {
      setInvalid(true);
      setError('shopping.store.error.invalidName');
      input?.focus?.();
      return null;
    }
    setInvalid(false);
    setError();
    submitting = true;
    actionButtons().forEach(button => { button.disabled = true; });
    try {
      const context = creationContext;
      const shoppingListId = context?.id ?? context?.client_mutation_id ?? context;
      const store = await storeController?.create?.(name, {
        authorize: () => authorize(context),
        shoppingListId,
      });
      if (!store) return null;
      hide();
      onCreated(store, context);
      if (selectId) doc?.querySelector?.(`[data-select-id="${selectId}"] .ui-select-trigger`)?.focus?.();
      return store;
    } catch (error) {
      onError(error);
      setError('shopping.store.error.saveFailed');
      input?.focus?.();
      return null;
    } finally {
      submitting = false;
      actionButtons().forEach(button => { button.disabled = false; });
    }
  }

  function handleClick(event) {
    const button = event.target?.closest?.(`[data-shopping-store-creator="${prefix}"]`);
    if (!button) return;
    event.preventDefault?.();
    if (button.dataset.shoppingStoreCreatorAction === 'save') void save();
    if (button.dataset.shoppingStoreCreatorAction === 'cancel') hide({ restoreFocus: true });
  }

  function handleKeydown(event) {
    if (event.key !== 'Enter' || event.target?.id !== `${prefix}-new-store-name`) return;
    event.preventDefault();
    void save();
  }

  doc?.addEventListener?.('click', handleClick);
  doc?.addEventListener?.('keydown', handleKeydown);

  return {
    show,
    hide,
    save,
    destroy() {
      doc?.removeEventListener?.('click', handleClick);
      doc?.removeEventListener?.('keydown', handleKeydown);
    },
  };
}
