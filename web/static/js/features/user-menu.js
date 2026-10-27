import { apiResourceUrl } from '../core/config.js';
import { loadAuthenticatedImage, releaseAuthenticatedImage } from '../core/authenticated-image.js';
import { openUiLayer, registerUiLayer, replaceUiLayer, requestCloseUiLayer } from './ui-history.js';

export function createUserMenuFeature({
  getCurrentUser,
  openSettingsModal = null,
  openHouseholdSettings = null,
  openShortcutHelpModal = null,
  openAboutModal = null,
  cycleTheme = null,
  toggleAccentPresetMenu = null,
  cycleSort = null,
  toggleHideDone = null,
  toggleProjectWidget = null,
  logout = null,
}) {
  function closeUserMenu({ fromHistory = false, afterClose = null } = {}) {
    const menu = document.getElementById('user-menu');
    const button = document.getElementById('user-menu-button');
    if (menu?.classList.contains('active') && !fromHistory && requestCloseUiLayer('user-menu', { reason: 'ui' }, { afterClose })) return;
    menu?.classList.remove('active');
    button?.setAttribute('aria-expanded', 'false');
    document.getElementById('accent-preset-panel')?.classList.remove('active');
    document.getElementById('accent-preset-row')?.setAttribute('aria-expanded', 'false');
    afterClose?.();
  }

  registerUiLayer('user-menu', () => closeUserMenu({ fromHistory: true }));

  function openFromUserMenu(layerId, open) {
    if (replaceUiLayer('user-menu', layerId)) {
      closeUserMenu({ fromHistory: true });
      open?.();
      return;
    }
    closeUserMenu({ afterClose: open });
  }

  function syncSidebarUserMenuMaxHeight() {
    const menu = document.getElementById('user-menu');
    const button = document.getElementById('user-menu-button');
    const sidebar = button?.closest?.('.sidebar');
    if (!menu || !button || !sidebar) return;
    const sidebarTopPadding = Number.parseFloat(getComputedStyle(sidebar).paddingTop) || 0;
    const availableHeight = Math.floor(
      button.getBoundingClientRect().top
      - sidebar.getBoundingClientRect().top
      - sidebarTopPadding
      - 10
    );
    menu.style.setProperty('--sidebar-user-menu-available-height', `${Math.max(0, availableHeight)}px`);
  }

  function toggleUserMenu(event) {
    event?.stopPropagation?.();
    const menu = document.getElementById('user-menu');
    const button = document.getElementById('user-menu-button');
    if (!menu || !button) return;
    const nextOpen = !menu.classList.contains('active');
    if (nextOpen) {
      syncSidebarUserMenuMaxHeight();
      menu.classList.add('active');
      openUiLayer('user-menu');
    } else {
      closeUserMenu();
    }
    button.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  }

  function avatarSrc(user) {
    if (!user?.avatar_url) return '';
    const version = user.avatar_updated_at ? encodeURIComponent(user.avatar_updated_at) : '';
    const src = apiResourceUrl(user.avatar_url);
    return version ? `${src}?v=${version}` : src;
  }

  function renderAvatar(target, initial, src, user) {
    if (!target) return;
    if (src) {
      let img = target.querySelector('img');
      if (!img) {
        target.innerHTML = `<img alt="Avatar">`;
        img = target.querySelector('img');
      }
      loadAuthenticatedImage(img, src, { userId: user?.id, version: user?.avatar_updated_at });
    } else {
      const img = target.querySelector('img');
      if (img) releaseAuthenticatedImage(img);
      target.textContent = initial;
    }
  }

  function updateUserMenu() {
    const user = getCurrentUser();
    const name = user?.display_name || user?.username || 'User';
    const email = user?.email || user?.username || '';
    const initial = (name.trim()[0] || 'U').toUpperCase();
    const src = avatarSrc(user);

    renderAvatar(document.getElementById('user-menu-button-avatar'), initial, src, user);
    renderAvatar(document.getElementById('user-menu-avatar'), initial, src, user);
    const menuName = document.getElementById('user-menu-name');
    const menuEmail = document.getElementById('user-menu-email');
    const sidebarName = document.getElementById('sidebar-user-name');
    const sidebarEmail = document.getElementById('sidebar-user-email');
    if (menuName) menuName.textContent = name;
    if (menuEmail) menuEmail.textContent = email;
    if (sidebarName) sidebarName.textContent = name;
    if (sidebarEmail) sidebarEmail.textContent = email || 'Account';
  }

  function handleUserMenuAction(action, event) {
    if (action === 'toggle') {
      toggleUserMenu(event);
      return;
    }
    if (action === 'settings') {
      openFromUserMenu('settings-modal', () => openSettingsModal?.());
      return;
    }
    if (action === 'household') {
      openFromUserMenu('settings-modal', () => openHouseholdSettings?.());
      return;
    }
    if (action === 'shortcuts') {
      openFromUserMenu('shortcuts-modal', () => openShortcutHelpModal?.({ returnFocusTo: document.getElementById('user-menu-button') }));
      return;
    }
    if (action === 'about') {
      openFromUserMenu('about-modal', () => openAboutModal?.({ returnFocusTo: document.getElementById('user-menu-button') }));
      return;
    }
    if (action === 'theme') cycleTheme?.();
    if (action === 'accent-preset') toggleAccentPresetMenu?.(event);
    if (action === 'sort') cycleSort?.();
    if (action === 'toggle-done') toggleHideDone?.();
    if (action === 'project-widget') toggleProjectWidget?.();
    if (action === 'logout') logout?.();
  }

  let userMenuBound = false;
  function bindUserMenu() {
    if (userMenuBound) return;
    userMenuBound = true;
    document.addEventListener('click', (event) => {
      const actionTarget = event.target?.closest?.('[data-user-menu-action]');
      if (actionTarget) {
        event.preventDefault();
        handleUserMenuAction(actionTarget.dataset.userMenuAction, event);
        return;
      }
      if (event.target?.closest?.('[data-sidebar-toggle]')) return;
      const menuWrap = event.target?.closest?.('.user-menu-wrap');
      if (!menuWrap) closeUserMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeUserMenu();
    });
    const syncOpenMenuHeight = () => {
      if (document.getElementById('user-menu')?.classList.contains('active')) syncSidebarUserMenuMaxHeight();
    };
    window.addEventListener('resize', syncOpenMenuHeight);
    const sidebarFooter = document.querySelector('.sidebar-footer');
    if (sidebarFooter && typeof ResizeObserver === 'function') {
      const resizeObserver = new ResizeObserver(syncOpenMenuHeight);
      resizeObserver.observe(sidebarFooter);
    }
  }

  return { toggleUserMenu, closeUserMenu, updateUserMenu, bindUserMenu };
}
