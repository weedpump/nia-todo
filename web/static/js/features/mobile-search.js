function isTypingTarget(element) {
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable;
}

export function createMobileSearchFeature({ renderTodos, toggleTodayFocus, toggleMinimalTodos }) {
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
    bindTodayFocusHotkey,
  };
}
