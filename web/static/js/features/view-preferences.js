export function createViewPreferencesFeature({ getHideDone, setHideDone, getSortMode, setSortMode, getShowProjectWidget, setShowProjectWidget, renderTodos }) {
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
    const icon = hidden ? '🚫' : '✅';
    const title = hidden ? 'Erledigte anzeigen' : 'Erledigte ausblenden';
    if (iconEl && labelEl) {
      iconEl.textContent = icon;
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
    const icon = visible ? '📊' : '▭';
    const title = visible ? 'Projekt-Widget ausblenden' : 'Projekt-Widget anzeigen';
    if (iconEl && labelEl) {
      iconEl.textContent = icon;
      labelEl.textContent = title;
    } else {
      btn.textContent = icon;
    }
    btn.title = title;
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
      order: { icon: '⇅', title: 'Sortierung: Reihenfolge' },
      priority: { icon: 'P1', title: 'Sortierung: Priorität (hoch→niedrig)' },
      alpha: { icon: 'AZ', title: 'Sortierung: Alphabetisch (A→Z)' },
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
    const sortMode = getSortMode();
    if (sortMode === 'priority') {
      const prioOrder = { 1: 0, 2: 1, 3: 2, 4: 3 };
      return [...list].sort((a, b) => {
        const pa = prioOrder[a.priority] ?? 4;
        const pb = prioOrder[b.priority] ?? 4;
        if (pa !== pb) return pa - pb;
        return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      });
    }
    if (sortMode === 'alpha') {
      return [...list].sort((a, b) =>
        (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase())
      );
    }
    return [...list].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }

  return { toggleHideDone, updateToggleDoneButton, toggleProjectWidget, updateProjectWidgetButton, cycleSort, updateSortButton, sortTodoList };
}
