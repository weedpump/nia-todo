export function createUiShell({ renderMarkdown, showTodoModal }) {
  function closeFloatingMenus() {
    const userMenu = document.getElementById('user-menu');
    const userButton = document.getElementById('user-menu-button');
    userMenu?.classList.remove('active');
    userButton?.setAttribute('aria-expanded', 'false');
    document.getElementById('accent-preset-panel')?.classList.remove('active');
    document.getElementById('accent-preset-row')?.setAttribute('aria-expanded', 'false');
  }

  function openSidebar() {
    document.getElementById('sidebar')?.classList.add('open');
    document.getElementById('sidebar-overlay')?.classList.add('active');
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const nextOpen = !sidebar?.classList.contains('open');
    sidebar?.classList.toggle('open', nextOpen);
    overlay?.classList.toggle('active', nextOpen);
    closeFloatingMenus();
  }

  function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('active');
    closeFloatingMenus();
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modalId === 'settings-modal' && modal?.classList.contains('mfa-enrollment-locked')) return;
    modal?.classList.remove('active');
  }

  function setupDescPreview() {
    const textarea = document.getElementById('todo-desc');
    const preview = document.getElementById('todo-desc-preview');
    if (!textarea || !preview) return;
    preview.innerHTML = renderMarkdown(textarea.value);
    textarea.oninput = () => { preview.innerHTML = renderMarkdown(textarea.value); };
  }

  function bindSidebarEdgeSwipe() {
    // Android often reserves the very left edge for system/browser Back.
    // Keep the app gesture slightly wider so users can start just inside that zone.
    const edgeWidth = 78;
    const openDistance = 64;
    const maxVerticalDrift = 55;
    let gesture = null;

    function isMobileLayout() {
      return window.matchMedia?.('(max-width: 768px)').matches;
    }

    document.addEventListener('touchstart', (event) => {
      if (!isMobileLayout()) return;
      if (event.touches.length !== 1) return;
      if (document.getElementById('sidebar')?.classList.contains('open')) return;

      const touch = event.touches[0];
      if (touch.clientX > edgeWidth) return;
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        tracking: true,
        claimed: false,
      };
    }, { passive: true });

    document.addEventListener('touchmove', (event) => {
      if (!gesture?.tracking || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;

      if (Math.abs(dy) > maxVerticalDrift && Math.abs(dy) > dx) {
        gesture = null;
        return;
      }

      if (dx > 24 && dx > Math.abs(dy) * 1.35) {
        gesture.claimed = true;
        event.preventDefault();
      }
    }, { passive: false });

    document.addEventListener('touchend', (event) => {
      if (!gesture?.tracking) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      const shouldOpen = gesture.claimed && dx >= openDistance && Math.abs(dy) <= maxVerticalDrift;
      gesture = null;
      if (shouldOpen) openSidebar();
    }, { passive: true });

    document.addEventListener('touchcancel', () => { gesture = null; }, { passive: true });
  }

  let touchFeedbackBound = false;

  function bindTouchFeedback() {
    if (touchFeedbackBound || typeof document === 'undefined') return;
    touchFeedbackBound = true;
    const selector = 'button, [role="button"], .nav-btn, .workspace-current-btn, .user-menu-item, .todo-item';
    const clear = (el) => {
      if (!el) return;
      window.clearTimeout(el.__niaTouchFeedbackTimer);
      el.__niaTouchFeedbackTimer = window.setTimeout(() => el.classList.remove('touch-feedback'), 150);
    };
    document.addEventListener('pointerdown', (event) => {
      if (!document.documentElement.classList.contains('native-android')) return;
      if (event.pointerType && event.pointerType !== 'touch') return;
      const target = event.target?.closest?.(selector);
      if (!target || target.disabled) return;
      target.classList.add('touch-feedback');
      window.clearTimeout(target.__niaTouchFeedbackTimer);
    }, { passive: true });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => {
      document.addEventListener(type, (event) => clear(event.target?.closest?.(selector)), { passive: true });
    });
  }

  function isTypingTarget(element) {
    const tag = element?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || element?.isContentEditable;
  }

  function bindKeyboardShortcuts() {
    document.addEventListener('keydown', async (e) => {
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(document.activeElement)) {
        e.preventDefault();
        await showTodoModal();
      }
      if (e.key === 'Escape') {
        closeModal('todo-modal');
        closeModal('project-modal');
      }
    });
  }

  return { openSidebar, toggleSidebar, closeSidebar, closeModal, setupDescPreview, bindSidebarEdgeSwipe, bindTouchFeedback, bindKeyboardShortcuts };
}
