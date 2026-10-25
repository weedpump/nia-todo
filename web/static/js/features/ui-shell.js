import { hideAutoScrollbars } from './auto-scrollbars.js';
import { closeUiLayerNow, openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';
import { t } from '../i18n/index.js';

const DESKTOP_SIDEBAR_MODES = ['expanded', 'rail', 'hidden'];
const DESKTOP_SIDEBAR_MODE_STORAGE_KEY = 'nia-desktop-sidebar-mode';

function loadDesktopSidebarMode() {
  try {
    const storedMode = localStorage.getItem(DESKTOP_SIDEBAR_MODE_STORAGE_KEY);
    return DESKTOP_SIDEBAR_MODES.includes(storedMode) ? storedMode : 'expanded';
  } catch {
    return 'expanded';
  }
}

function persistDesktopSidebarMode(mode) {
  try {
    localStorage.setItem(DESKTOP_SIDEBAR_MODE_STORAGE_KEY, mode);
  } catch {
    // Keep the current in-memory mode when storage is unavailable.
  }
}

function hideSidebarScrollbars() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) hideAutoScrollbars(sidebar);
}

export function createUiShell({ renderMarkdown, showTodoModal }) {
  let desktopSidebarMode = loadDesktopSidebarMode();

  function isMobileLayout() {
    return window.matchMedia?.('(max-width: 768px)').matches;
  }

  function syncSidebarToggleButton() {
    const button = document.getElementById('sidebar-toggle-btn');
    if (!button) return;

    let labelKey = 'topbar.openMenu';
    if (isMobileLayout()) {
      const isOpen = document.getElementById('sidebar')?.classList.contains('open');
      labelKey = isOpen ? 'topbar.closeMenu' : 'topbar.openMenu';
      button.setAttribute('aria-expanded', String(Boolean(isOpen)));
    } else {
      const nextMode = DESKTOP_SIDEBAR_MODES[(DESKTOP_SIDEBAR_MODES.indexOf(desktopSidebarMode) + 1) % DESKTOP_SIDEBAR_MODES.length];
      labelKey = nextMode === 'rail'
        ? 'sidebar.reduceToIcons'
        : nextMode === 'hidden'
          ? 'sidebar.hide'
          : 'sidebar.show';
      button.setAttribute('aria-expanded', String(desktopSidebarMode !== 'hidden'));
    }

    button.dataset.i18nAriaLabelKey = labelKey;
    button.dataset.i18nTitleKey = labelKey;
    button.setAttribute('aria-label', t(labelKey));
    button.setAttribute('title', t(labelKey));
  }

  function setDesktopSidebarMode(mode, { persist = false } = {}) {
    desktopSidebarMode = DESKTOP_SIDEBAR_MODES.includes(mode) ? mode : 'expanded';
    if (persist) persistDesktopSidebarMode(desktopSidebarMode);
    const app = document.getElementById('app');
    if (!app) return;
    app.dataset.desktopSidebarMode = desktopSidebarMode;
    closeFloatingMenus();
    syncSidebarToggleButton();
  }

  function cycleDesktopSidebarMode() {
    const currentIndex = DESKTOP_SIDEBAR_MODES.indexOf(desktopSidebarMode);
    setDesktopSidebarMode(DESKTOP_SIDEBAR_MODES[(currentIndex + 1) % DESKTOP_SIDEBAR_MODES.length], { persist: true });
  }

  function closeFloatingMenus() {
    document.getElementById('module-switcher-menu')?.classList.remove('open');
    document.getElementById('module-switcher-button')?.setAttribute('aria-expanded', 'false');
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
    syncSidebarToggleButton();
    openUiLayer('sidebar');
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const nextOpen = !sidebar?.classList.contains('open');
    if (nextOpen) {
      sidebar?.classList.add('open');
      overlay?.classList.add('active');
      openUiLayer('sidebar');
    } else {
      closeSidebar();
    }
    if (nextOpen) closeFloatingMenus();
    syncSidebarToggleButton();
  }

  function closeSidebar({ fromHistory = false, preserveHistory = false } = {}) {
    const sidebar = document.getElementById('sidebar');
    const wasOpen = sidebar?.classList.contains('open');
    if (wasOpen && preserveHistory && closeUiLayerNow('sidebar', { reason: 'navigation' })) return true;
    if (wasOpen && !fromHistory && requestCloseUiLayer('sidebar', { reason: 'ui' })) return true;
    sidebar?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('active');
    if (wasOpen) hideSidebarScrollbars();
    closeFloatingMenus();
    syncSidebarToggleButton();
    return Boolean(wasOpen);
  }

  registerUiLayer('sidebar', () => closeSidebar({ fromHistory: true }));
  registerUiLayer('settings-modal', () => {
    const modal = document.getElementById('settings-modal');
    if (modal?.classList.contains('mfa-enrollment-locked')) {
      openUiLayer('settings-modal');
      return;
    }
    closeModal('settings-modal', { fromHistory: true });
  });

  function closeModal(modalId, { fromHistory = false } = {}) {
    const modal = document.getElementById(modalId);
    if (modalId === 'settings-modal' && modal?.classList.contains('mfa-enrollment-locked')) return;
    if (modal?.classList.contains('active') && !fromHistory && requestCloseUiLayer(modalId, { reason: 'ui' })) return;
    modal?.classList.remove('active');

    const activeElement = document.activeElement;
    if (activeElement?.matches?.('.nav-edit, [data-project-action="edit"], [data-workspace-action="edit"]')) {
      activeElement.blur();
    }
  }

  let modalCloseControlsBound = false;
  function bindModalCloseControls() {
    if (modalCloseControlsBound) return;
    modalCloseControlsBound = true;
    document.addEventListener('click', (event) => {
      const target = event.target?.closest?.('[data-close-modal]');
      if (!target) return;
      event.preventDefault();
      closeModal(target.dataset.closeModal);
    });
  }

  function setupDescPreview() {
    const textarea = document.getElementById('todo-desc');
    const preview = document.getElementById('todo-desc-preview');
    if (!textarea || !preview) return;
    preview.innerHTML = renderMarkdown(textarea.value);
    textarea.oninput = () => { preview.innerHTML = renderMarkdown(textarea.value); };
  }

  function bindSidebarControls() {
    if (document.documentElement.dataset.sidebarControlsBound === '1') return;
    document.documentElement.dataset.sidebarControlsBound = '1';
    document.addEventListener('click', (event) => {
      const toggle = event.target?.closest?.('[data-sidebar-toggle]');
      if (!toggle) return;
      event.preventDefault();
      if (toggle.id === 'sidebar-overlay' || isMobileLayout()) toggleSidebar();
      else cycleDesktopSidebarMode();
    });
    document.getElementById('app')?.setAttribute('data-desktop-sidebar-mode', desktopSidebarMode);
    syncSidebarToggleButton();
    window.addEventListener('resize', syncSidebarToggleButton);
    window.addEventListener('nia-language-change', syncSidebarToggleButton);
  }

  function bindSidebarEdgeSwipe() {
    // Android often reserves the very left edge for system/browser Back.
    // Keep the app gesture slightly wider so users can start just inside that zone.
    const edgeWidth = 78;
    const openDistance = 64;
    const maxVerticalDrift = 55;
    let gesture = null;


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
    const selector = 'button, [role="button"], .nav-btn, .workspace-current-btn, .user-menu-item, .todo-item, .overview-project-item, .section-name';
    const interactiveWithinTodo = 'button, input, textarea, select, a, summary, details, .todo-check, .todo-actions, [role="button"]';
    const clear = (el) => {
      if (!el) return;
      window.clearTimeout(el.__niaTouchFeedbackTimer);
      el.__niaTouchFeedbackTimer = window.setTimeout(() => el.classList.remove('touch-feedback'), 240);
    };
    document.addEventListener('pointerdown', (event) => {
      if (!document.documentElement.classList.contains('native-android')) return;
      if (event.pointerType && event.pointerType !== 'touch') return;
      const target = event.target?.closest?.(selector);
      if (!target || target.disabled) return;
      if (target.classList?.contains('todo-item') && event.target?.closest?.(interactiveWithinTodo)) return;
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
      const canUseGlobalShortcut = !isTypingTarget(document.activeElement)
        && !document.querySelector('.modal.active, .ui-menu.active')
        && document.getElementById('login-overlay')?.classList.contains('hidden');
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && canUseGlobalShortcut) {
        e.preventDefault();
        await showTodoModal();
      }
      if (e.key === 'Escape') {
        if (document.getElementById('attachment-preview-modal')?.classList.contains('active')) {
          e.preventDefault();
          window.closeAttachmentPreview?.();
          return;
        }
        closeModal('todo-modal');
        closeModal('project-modal');
      }
    });
  }

  return { openSidebar, toggleSidebar, closeSidebar, closeModal, bindModalCloseControls, setupDescPreview, bindSidebarControls, bindSidebarEdgeSwipe, bindTouchFeedback, bindKeyboardShortcuts };
}
