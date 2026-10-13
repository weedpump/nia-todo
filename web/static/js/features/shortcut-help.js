import { openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';

export function createShortcutHelpFeature() {
  let actionsBound = false;
  let lastFocusedElement = null;

  function isTypingTarget(element) {
    const tag = element?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable;
  }

  function openShortcutHelpModal({ returnFocusTo = null } = {}) {
    const modal = document.getElementById('shortcuts-modal');
    if (!modal) return;
    if (returnFocusTo) lastFocusedElement = returnFocusTo;
    else if (!modal.contains(document.activeElement)) lastFocusedElement = document.activeElement;
    modal.classList.add('active');
    modal.removeAttribute('aria-hidden');
    openUiLayer('shortcuts-modal');
    modal.querySelector('.modal-close-x')?.focus();
  }

  function closeShortcutHelpModal({ restoreFocus = true, fromHistory = false } = {}) {
    const modal = document.getElementById('shortcuts-modal');
    if (modal?.classList.contains('active') && !fromHistory && requestCloseUiLayer('shortcuts-modal', { restoreFocus })) return;
    modal?.classList.remove('active');
    modal?.setAttribute('aria-hidden', 'true');
    if (restoreFocus && lastFocusedElement?.isConnected) lastFocusedElement.focus();
  }

  registerUiLayer('shortcuts-modal', payload => closeShortcutHelpModal({
    restoreFocus: payload?.restoreFocus ?? false,
    fromHistory: true,
  }));

  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const modal = document.getElementById('shortcuts-modal');
    if (!modal?.classList.contains('active')) return;
    const focusable = Array.from(modal.querySelectorAll('button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.closest('[hidden]'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function bindShortcutHelpActions() {
    if (actionsBound) return;
    actionsBound = true;
    document.addEventListener('click', (event) => {
      if (event.target?.closest?.('[data-close-modal="shortcuts-modal"]')) closeShortcutHelpModal();
    });
    document.addEventListener('keydown', (event) => {
      const modal = document.getElementById('shortcuts-modal');
      if (!modal?.classList.contains('active')) {
        if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
        if (isTypingTarget(event.target)) return;
        if (document.querySelector('.modal.active, .ui-menu.active')) return;
        if (!document.getElementById('login-overlay')?.classList.contains('hidden')) return;
        event.preventDefault();
        openShortcutHelpModal({ returnFocusTo: document.activeElement });
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeShortcutHelpModal();
        return;
      }
      trapFocus(event);
    });
  }

  return { openShortcutHelpModal, bindShortcutHelpActions };
}
