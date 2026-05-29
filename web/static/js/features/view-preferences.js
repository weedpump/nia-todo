import { t } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';

export function createViewPreferencesFeature({ getHideDone, setHideDone, getSortMode, setSortMode, getShowProjectWidget, setShowProjectWidget, getTodayFocus, setTodayFocus, renderTodos }) {
  function toggleHideDone() {
    const next = !getHideDone();
    setHideDone(next);
    localStorage.setItem('nia-hide-done', next ? 'true' : 'false');
    updateToggleDoneButton();
    renderTodos();
  }

  function updateToggleDoneButton() {
    const btn = document.getElementById('toggle-done-btn');
    if (!btn) return;
    const iconEl = btn.querySelector('.menu-item-icon');
    const labelEl = btn.querySelector('.menu-item-label');
    const hidden = getHideDone();
    btn.classList.toggle('active', !hidden);
    const icon = hidden ? iconSvg('ban') : iconSvg('check-circle');
    const title = hidden ? t('menu.showDone') : t('menu.hideDone');
    if (iconEl && labelEl) {
      iconEl.innerHTML = icon;
      labelEl.textContent = title;
    } else {
      btn.textContent = icon;
    }
    btn.title = title;
  }

  function toggleProjectWidget() {
    if (!getShowProjectWidget || !setShowProjectWidget) return;
    const next = !getShowProjectWidget();
    setShowProjectWidget(next);
    localStorage.setItem('nia-project-widget', next ? 'true' : 'false');
    updateProjectWidgetButton();
    renderTodos();
  }

  function updateProjectWidgetButton() {
    const btn = document.getElementById('project-widget-toggle-btn');
    if (!btn || !getShowProjectWidget) return;
    const iconEl = btn.querySelector('.menu-item-icon');
    const labelEl = btn.querySelector('.menu-item-label');
    const visible = getShowProjectWidget();
    const icon = visible ? iconSvg('layout-dashboard') : iconSvg('circle');
    const title = t('menu.projectWidget');
    if (iconEl && labelEl) {
      iconEl.innerHTML = icon;
      labelEl.textContent = title;
    } else {
      btn.textContent = icon;
    }
    btn.title = title;
  }

  function toggleTodayFocus() {
    if (!getTodayFocus || !setTodayFocus) return;
    const next = !getTodayFocus();
    setTodayFocus(next);
    localStorage.setItem('nia-today-focus', next ? 'true' : 'false');
    updateTodayFocusButton();
    renderTodos();
  }

  function updateTodayFocusButton() {
    const btn = document.getElementById('today-focus-btn');
    if (!btn || !getTodayFocus) return;
    const active = getTodayFocus();
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.title = active ? t('todayFocus.disable') : t('todayFocus.enable');
    const label = btn.querySelector('[data-i18n-key="todayFocus.short"]');
    if (label) label.textContent = active ? t('todayFocus.on') : t('todayFocus.short');
  }

  function cycleSort() {
    const modes = ['order', 'priority', 'alpha'];
    const idx = modes.indexOf(getSortMode());
    const next = modes[(idx + 1) % modes.length];
    setSortMode(next);
    localStorage.setItem('nia-sort', next);
    updateSortButton();
    renderTodos();
  }

  function updateSortButton() {
    const btn = document.getElementById('sort-toggle-btn');
    if (!btn) return;
    const config = {
      order: { icon: '⇅', title: t('menu.sort.order') },
      priority: { icon: 'P1', title: t('menu.sort.priority') },
      alpha: { icon: 'AZ', title: t('menu.sort.alpha') },
    };
    const c = config[getSortMode()] || config.order;
    const iconEl = btn.querySelector('.menu-item-icon');
    const labelEl = btn.querySelector('.menu-item-label');
    if (iconEl && labelEl) {
      iconEl.textContent = c.icon;
      labelEl.textContent = c.title;
    } else {
      btn.textContent = c.icon;
    }
    btn.title = c.title;
  }

  function sortTodoList(list) {
    const withPinsFirst = (items) => [...items].sort((a, b) => Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)));
    const sortMode = getSortMode();
    if (sortMode === 'priority') {
      const prioOrder = { 1: 0, 2: 1, 3: 2, 4: 3 };
      return [...list].sort((a, b) => {
        const pinned = Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned));
        if (pinned) return pinned;
        const pa = prioOrder[a.priority] ?? 4;
        const pb = prioOrder[b.priority] ?? 4;
        if (pa !== pb) return pa - pb;
        return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      });
    }
    if (sortMode === 'alpha') {
      return [...list].sort((a, b) => {
        const pinned = Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned));
        if (pinned) return pinned;
        return (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase());
      });
    }
    return withPinsFirst(list).sort((a, b) => {
      const pinned = Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned));
      if (pinned) return pinned;
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    });
  }

  return { toggleHideDone, updateToggleDoneButton, toggleProjectWidget, updateProjectWidgetButton, toggleTodayFocus, updateTodayFocusButton, cycleSort, updateSortButton, sortTodoList };
}
