export function createUserMenuFeature({ getCurrentUser }) {
  function closeUserMenu() {
    const menu = document.getElementById('user-menu');
    const button = document.getElementById('user-menu-button');
    menu?.classList.remove('active');
    button?.setAttribute('aria-expanded', 'false');
  }

  function positionUserMenu() {
    const menu = document.getElementById('user-menu');
    const wrap = document.querySelector('.sidebar-user-menu-wrap');
    if (!menu || !wrap || !menu.classList.contains('active')) return;

    const margin = 16;
    const gap = 10;
    const rect = wrap.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - menuRect.width - margin;
    const left = Math.max(margin, Math.min(rect.left, maxLeft));
    const preferredTop = rect.top - menuRect.height - gap;
    const maxTop = window.innerHeight - menuRect.height - margin;
    const top = Math.max(margin, Math.min(preferredTop, maxTop));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function toggleUserMenu(event) {
    event?.stopPropagation?.();
    const menu = document.getElementById('user-menu');
    const button = document.getElementById('user-menu-button');
    if (!menu || !button) return;
    const nextOpen = !menu.classList.contains('active');
    menu.classList.toggle('active', nextOpen);
    button.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    if (nextOpen) requestAnimationFrame(positionUserMenu);
  }

  function avatarSrc(user) {
    if (!user?.avatar_url) return '';
    const version = user.avatar_updated_at ? encodeURIComponent(user.avatar_updated_at) : Date.now();
    return `${user.avatar_url}?v=${version}`;
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

    renderAvatar(document.getElementById('user-menu-button'), initial, src);
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

  function bindUserMenu() {
    document.addEventListener('click', (event) => {
      const menuWrap = event.target?.closest?.('.user-menu-wrap');
      if (!menuWrap) closeUserMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeUserMenu();
    });
    window.addEventListener('resize', positionUserMenu);
    document.getElementById('sidebar')?.addEventListener('scroll', positionUserMenu, { passive: true });
  }

  return { toggleUserMenu, closeUserMenu, updateUserMenu, bindUserMenu };
}
