function isNativeAndroid() {
  return /Android/i.test(navigator.userAgent || '') && (
    new URLSearchParams(location.search).get('nativeApp') === 'tauri' || Boolean(window.__TAURI__?.core?.invoke)
  );
}

function describeElement(el) {
  if (!el) return 'none';
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().replace(/\s+/g, '.')}` : '';
  return `${el.tagName?.toLowerCase() || 'node'}${id}${cls}`;
}

function ensureBadge() {
  let badge = document.getElementById('android-touch-debug');
  if (badge) return badge;
  badge = document.createElement('div');
  badge.id = 'android-touch-debug';
  badge.style.cssText = [
    'position:fixed',
    'left:8px',
    'bottom:8px',
    'z-index:2147483647',
    'max-width:calc(100vw - 16px)',
    'padding:6px 8px',
    'border-radius:8px',
    'background:rgba(15,23,42,0.88)',
    'color:#e2e8f0',
    'font:11px/1.25 monospace',
    'pointer-events:none',
    'box-shadow:0 4px 14px rgba(0,0,0,0.25)',
  ].join(';');
  badge.textContent = 'touch-debug ready';
  document.body.appendChild(badge);
  return badge;
}

function updateBadge(text) {
  const badge = ensureBadge();
  badge.textContent = text;
}

function getPoint(event) {
  const touch = event.changedTouches?.[0] || event.touches?.[0];
  if (touch) return { x: touch.clientX, y: touch.clientY };
  return { x: event.clientX, y: event.clientY };
}

function fallbackAction(event, top) {
  const target = event.target instanceof Element ? event.target : top;
  const el = target?.closest?.('.hamburger, .fab-add-todo, #sidebar-overlay, .nav-btn, .todo-item, .todo-check, .modal-close-x, .btn, .user-menu-button, .user-menu-item');
  if (!el) return false;

  // Do not double-run normal click handlers unless this is a touch/pointer fallback.
  if (event.type === 'click') return false;

  if (el.matches('.hamburger')) {
    event.preventDefault();
    window.toggleSidebar?.();
    updateBadge(`${event.type}: fallback hamburger`);
    return true;
  }
  if (el.matches('.fab-add-todo')) {
    event.preventDefault();
    window.showTodoModal?.();
    updateBadge(`${event.type}: fallback fab`);
    return true;
  }
  if (el.matches('#sidebar-overlay')) {
    event.preventDefault();
    window.toggleSidebar?.();
    updateBadge(`${event.type}: fallback overlay`);
    return true;
  }
  if (el.matches('.user-menu-button')) {
    event.preventDefault();
    window.toggleUserMenu?.(event);
    updateBadge(`${event.type}: fallback user menu`);
    return true;
  }
  return false;
}

export function initAndroidTouchDebug() {
  if (!isNativeAndroid()) return;
  document.documentElement.classList.add('android-touch-debug-enabled');
  ensureBadge();

  for (const type of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'click']) {
    document.addEventListener(type, (event) => {
      const { x, y } = getPoint(event);
      const stack = Number.isFinite(x) && Number.isFinite(y)
        ? document.elementsFromPoint(x, y).slice(0, 4).map(describeElement).join(' > ')
        : describeElement(event.target);
      updateBadge(`${type} ${Math.round(x || 0)},${Math.round(y || 0)} ${stack}`);
      const top = Number.isFinite(x) && Number.isFinite(y) ? document.elementsFromPoint(x, y)[0] : null;
      fallbackAction(event, top);
    }, { capture: true, passive: false });
  }

  window.__niaTouchDebug = () => ({
    href: location.href,
    className: document.documentElement.className,
    lastBadge: document.getElementById('android-touch-debug')?.textContent || '',
    globals: {
      toggleSidebar: typeof window.toggleSidebar,
      showTodoModal: typeof window.showTodoModal,
      setFilter: typeof window.setFilter,
    },
    topAtFab: document.elementsFromPoint(innerWidth - 40, innerHeight - 40).map(describeElement),
    topAtHamburger: document.elementsFromPoint(24, 42).map(describeElement),
  });
}
