import { apiResourceUrl } from '../core/config.js';

export function createUserMenuFeature({
  getCurrentUser,
  openSettingsModal = null,
  cycleTheme = null,
  toggleAccentPresetMenu = null,
  cycleSort = null,
  toggleHideDone = null,
  toggleProjectWidget = null,
  logout = null,
}) {
  function closeUserMenu() {
    const menu = document.getElementById('user-menu');
    const button = document.getElementById('user-menu-button');
    menu?.classList.remove('active');
    button?.setAttribute('aria-expanded', 'false');
    document.getElementById('accent-preset-panel')?.classList.remove('active');
    document.getElementById('accent-preset-row')?.setAttribute('aria-expanded', 'false');
  }

  function toggleUserMenu(event) {
    event?.stopPropagation?.();
    const menu = document.getElementById('user-menu');
    const button = document.getElementById('user-menu-button');
    if (!menu || !button) return;
    const nextOpen = !menu.classList.contains('active');
    menu.classList.toggle('active', nextOpen);
    button.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  }

  function avatarSrc(user) {
    if (!user?.avatar_url) return '';
    const version = user.avatar_updated_at ? encodeURIComponent(user.avatar_updated_at) : '';
    const src = apiResourceUrl(user.avatar_url);
    return version ? `${src}?v=${version}` : src;
  }

  function renderAvatar(target, initial, src) {
    if (!target) return;
    if (src) {
      target.innerHTML = `<img src="${src}" alt="Avatar">`;
    } else {
      target.textContent = initial;
    }
  }

  function updateUserMenu() {
    const user = getCurrentUser();
    const name = user?.display_name || user?.username || 'User';
    const email = user?.email || user?.username || '';
    const initial = (name.trim()[0] || 'U').toUpperCase();
    const src = avatarSrc(user);

    renderAvatar(document.getElementById('user-menu-button-avatar'), initial, src);
    renderAvatar(document.getElementById('user-menu-avatar'), initial, src);
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
      closeUserMenu();
      openSettingsModal?.();
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
      const menuWrap = event.target?.closest?.('.user-menu-wrap');
      if (!menuWrap) closeUserMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeUserMenu();
    });
  }

  return { toggleUserMenu, closeUserMenu, updateUserMenu, bindUserMenu };
}
