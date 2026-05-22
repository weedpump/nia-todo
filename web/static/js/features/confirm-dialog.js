export function createConfirmDialogFeature() {
  let pendingResolve = null;

  function close(result = false) {
    const modal = document.getElementById('confirm-modal');
    modal?.classList.remove('active');
    const resolve = pendingResolve;
    pendingResolve = null;
    if (resolve) resolve(result);
  }

  function confirmDanger({ title = 'Wirklich löschen?', message = '', confirmText = 'Löschen', cancelText = 'Abbrechen' } = {}) {
    if (pendingResolve) close(false);
    const modal = document.getElementById('confirm-modal');
    if (!modal) return Promise.resolve(window.confirm(message || title));

    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-confirm-btn').textContent = confirmText;
    document.getElementById('confirm-cancel-btn').textContent = cancelText;
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
