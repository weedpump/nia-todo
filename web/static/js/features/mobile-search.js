function isTypingTarget(element) {
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable;
}

export function createMobileSearchFeature({ renderStats, renderTodos, toggleTodayFocus, toggleMinimalTodos }) {
  function openMobileSearch() {
    const box = document.getElementById('search-box');
    const input = document.getElementById('search-input');
    box?.classList.add('open');
    requestAnimationFrame(() => {
      input?.focus();
      input?.select();
    });
  }

  function closeMobileSearch() {
    const box = document.getElementById('search-box');
    const input = document.getElementById('search-input');
    if (input?.value) {
      input.value = '';
      renderTodos();
    }
    box?.classList.remove('open');
    input?.blur();
  }

  function toggleMobileSearch() {
    const box = document.getElementById('search-box');
    if (box?.classList.contains('open')) closeMobileSearch();
    else openMobileSearch();
  }

  let mobileSearchEventsBound = false;
  function bindMobileSearchEvents() {
    if (mobileSearchEventsBound) return;
    mobileSearchEventsBound = true;
    document.getElementById('search-toggle-btn')?.addEventListener('click', () => toggleMobileSearch());
    document.getElementById('search-input')?.addEventListener('input', () => {
      renderStats();
      renderTodos();
    });
    document.getElementById('search-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMobileSearch();
    });
  }

  function bindTodayFocusHotkey() {
    if (document.documentElement.dataset.todayFocusHotkeyBound === '1') return;
    document.documentElement.dataset.todayFocusHotkeyBound = '1';
    document.addEventListener('keydown', (event) => {
      const key = event.key?.toLowerCase();
      if ((key !== 'f' && key !== 'm') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target) || document.querySelector('.modal.active')) return;
      event.preventDefault();
      if (key === 'f') toggleTodayFocus();
      else toggleMinimalTodos();
    });
  }

  return {
    openMobileSearch,
    closeMobileSearch,
    toggleMobileSearch,
    bindMobileSearchEvents,
    bindTodayFocusHotkey,
  };
}
