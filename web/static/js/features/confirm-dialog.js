import { t } from '../i18n/index.js';

export function createConfirmDialogFeature() {
  let pendingResolve = null;

  function close(result = false) {
    const modal = document.getElementById('confirm-modal');
    modal?.classList.remove('active');
    const resolve = pendingResolve;
    pendingResolve = null;
    if (resolve) resolve(result);
  }

  function confirmDanger({ title = t('confirm.deleteTitle'), message = '', confirmText = t('todo.delete'), cancelText = t('common.cancel') } = {}) {
    if (pendingResolve) close(false);
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
    }
    modal.classList.add('active');

    return new Promise((resolve) => {
      pendingResolve = resolve;
      setTimeout(() => document.getElementById('confirm-confirm-btn')?.focus(), 50);
    });
  }

  function bindConfirmDialog() {
    document.getElementById('confirm-cancel-btn')?.addEventListener('click', () => close(false));
    document.getElementById('confirm-confirm-btn')?.addEventListener('click', () => close(true));
    document.getElementById('confirm-modal-overlay')?.addEventListener('click', () => close(false));
    document.addEventListener('keydown', (event) => {
      if (!document.getElementById('confirm-modal')?.classList.contains('active')) return;
      if (event.key === 'Escape') close(false);
    });
  }

  return { confirmDanger, closeConfirmDialog: close, bindConfirmDialog };
}
