import { t } from '../i18n/index.js';
import { openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';

export function createConfirmDialogFeature() {
  let pendingResolve = null;
  let pendingReturnFocus = null;

  function close(result = false, { fromHistory = false } = {}) {
    const modal = document.getElementById('confirm-modal');
    if (modal?.classList.contains('active') && !fromHistory && requestCloseUiLayer('confirm-modal', { result })) return;
    modal?.classList.remove('active');
    document.getElementById('confirm-cancel-btn')?.style.removeProperty('display');
    const resolve = pendingResolve;
    const returnFocus = pendingReturnFocus;
    pendingResolve = null;
    pendingReturnFocus = null;
    if (resolve) resolve(result);
    if (!result) globalThis.setTimeout?.(() => returnFocus?.()?.focus?.(), 0);
  }

  function confirmDanger({
    title = t('confirm.deleteTitle'),
    message = '',
    confirmText = t('todo.delete'),
    cancelText = t('common.cancel'),
    hideCancel = false,
    returnFocus = null,
  } = {}) {
    if (pendingResolve) close(false, { fromHistory: true });
    const modal = document.getElementById('confirm-modal');
    if (!modal) return Promise.resolve(window.confirm(message || title));

    const titleEl = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    const confirmEl = document.getElementById('confirm-confirm-btn');
    const cancelEl = document.getElementById('confirm-cancel-btn');
    if (titleEl) {
      titleEl.removeAttribute('data-i18n-key');
      titleEl.textContent = title;
    }
    if (messageEl) {
      messageEl.removeAttribute('data-i18n-key');
      messageEl.textContent = message;
    }
    if (confirmEl) {
      confirmEl.removeAttribute('data-i18n-key');
      confirmEl.textContent = confirmText;
    }
    if (cancelEl) {
      cancelEl.removeAttribute('data-i18n-key');
      cancelEl.textContent = cancelText;
      cancelEl.style.display = hideCancel ? 'none' : '';
    }
    modal.classList.add('active');
    openUiLayer('confirm-modal');

    return new Promise((resolve) => {
      pendingResolve = resolve;
      const initialFocus = document.activeElement;
      pendingReturnFocus = typeof returnFocus === 'function'
        ? returnFocus
        : () => returnFocus || initialFocus;
      setTimeout(() => document.getElementById('confirm-confirm-btn')?.focus(), 50);
    });
  }

  function bindConfirmDialog() {
    document.getElementById('confirm-cancel-btn')?.addEventListener('click', () => close(false));
    document.getElementById('confirm-confirm-btn')?.addEventListener('click', () => close(true));
    document.getElementById('confirm-modal-overlay')?.addEventListener('click', () => close(false));
    document.addEventListener('keydown', (event) => {
      if (!document.getElementById('confirm-modal')?.classList.contains('active')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(false);
      }
    });
  }

  function alertInfo({ title = t('common.error'), message = '', confirmText = t('common.close') } = {}) {
    return confirmDanger({ title, message, confirmText, hideCancel: true });
  }

  registerUiLayer('confirm-modal', payload => close(Boolean(payload?.result), { fromHistory: true }));

  return { confirmDanger, alertInfo, closeConfirmDialog: close, bindConfirmDialog };
}
