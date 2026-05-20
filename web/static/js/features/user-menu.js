export function createUserMenuFeature({ getCurrentUser }) {
  function closeUserMenu() {
    const menu = document.getElementById('user-menu');
    const button = document.getElementById('user-menu-button');
    menu?.classList.remove('active');
    button?.setAttribute('aria-expanded', 'false');
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

  function updateUserMenu() {
    const user = getCurrentUser();
    const name = user?.display_name || user?.username || 'User';
    const email = user?.email || user?.username || '';
    const initial = (name.trim()[0] || 'U').toUpperCase();

    const avatarInitial = document.getElementById('user-avatar-initial');
    const menuAvatarInitial = document.getElementById('user-menu-avatar-initial');
    const menuName = document.getElementById('user-menu-name');
    const menuEmail = document.getElementById('user-menu-email');
    if (avatarInitial) avatarInitial.textContent = initial;
    if (menuAvatarInitial) menuAvatarInitial.textContent = initial;
    if (menuName) menuName.textContent = name;
    if (menuEmail) menuEmail.textContent = email;
  }

  function bindUserMenu() {
    document.addEventListener('click', (event) => {
      const menuWrap = event.target?.closest?.('.user-menu-wrap');
      if (!menuWrap) closeUserMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeUserMenu();
    });
  }

  return { toggleUserMenu, closeUserMenu, updateUserMenu, bindUserMenu };
}
