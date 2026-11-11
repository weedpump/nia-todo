import { openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';

function isTypingTarget(element) {
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable;
}

export function createMobileSearchFeature({ onSearch, toggleTodayFocus, toggleMinimalTodos, getActiveModule = () => 'tasks' }) {
  function openMobileSearch() {
    const box = document.getElementById('search-box');
    const input = document.getElementById('search-input');
    box?.classList.add('open');
    openUiLayer('mobile-search');
    requestAnimationFrame(() => {
      input?.focus();
      input?.select();
    });
  }

  function closeMobileSearch({ fromHistory = false } = {}) {
    const box = document.getElementById('search-box');
    const input = document.getElementById('search-input');
    if (box?.classList.contains('open') && !fromHistory && requestCloseUiLayer('mobile-search', { reason: 'ui' })) return;
    if (input?.value) {
      input.value = '';
      onSearch?.('');
    }
    box?.classList.remove('open');
    input?.blur();
  }

  registerUiLayer('mobile-search', () => closeMobileSearch({ fromHistory: true }));

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
      onSearch?.(document.getElementById('search-input')?.value || '');
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
      if ((key !== 't' && key !== 'c') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (getActiveModule() !== 'tasks') return;
      if (isTypingTarget(event.target) || document.querySelector('.modal.active')) return;
      event.preventDefault();
      if (key === 't') toggleTodayFocus();
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
