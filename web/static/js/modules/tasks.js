import { TASK_DIALOGS_HTML } from './tasks-dialogs.js';
import { TASK_DESKTOP_HOTKEYS_HTML, TASK_SETTINGS_HTML, TASK_SETTINGS_NAV_HTML } from './tasks-settings.js';
import { TASK_SHORTCUTS_HTML } from './tasks-shortcuts.js';
import { renderEntitySidebarAddRow } from '../features/entity-sidebar.js';
import { t } from '../i18n/index.js';

export const tasksModule = Object.freeze({
  id: 'tasks',
  labelKey: 'module.tasks.label',
  descriptionKey: 'module.tasks.description',
  icon: 'tasks',
  searchEnabled: true,
  searchPlaceholderKey: 'topbar.searchTodo',
  capabilities: Object.freeze({ workspaces: true }),

  mount({ slots }) {
    slots.sidebar.innerHTML = `
      <nav class="nav-section">
        <div class="nav-title" data-i18n-key="nav.view">Ansicht</div>
        <button class="nav-btn ui-nav-pill" data-filter="all" aria-label="Dashboard" data-i18n-aria-label-key="nav.dashboard" title="Dashboard" data-i18n-title-key="nav.dashboard">
          <span data-icon="layout-dashboard"></span> <span data-i18n-key="nav.dashboard">Dashboard</span>
          <span class="badge" id="count-all">0</span>
        </button>
        <button class="nav-btn ui-nav-pill" data-filter="focus" aria-label="Filter" data-i18n-aria-label-key="nav.focus" title="Filter" data-i18n-title-key="nav.focus">
          <span data-icon="funnel"></span> <span data-i18n-key="nav.focus">Filter</span>
          <span class="badge" id="count-focus">0</span>
        </button>
        <button class="nav-btn ui-nav-pill" data-filter="calendar" aria-label="Calendar" data-i18n-aria-label-key="nav.calendar" title="Calendar" data-i18n-title-key="nav.calendar">
          <span data-icon="calendar-days"></span> <span data-i18n-key="nav.calendar">Kalender</span>
          <span class="badge" id="count-calendar">0</span>
        </button>
        <button class="nav-btn ui-nav-pill" data-filter="in_progress" aria-label="In progress" data-i18n-aria-label-key="nav.inProgress" title="In progress" data-i18n-title-key="nav.inProgress">
          <span data-icon="flame"></span> <span data-i18n-key="nav.inProgress">In progress</span>
          <span class="badge" id="count-in_progress">0</span>
        </button>
        <button class="nav-btn ui-nav-pill" data-filter="done" aria-label="Done" data-i18n-aria-label-key="nav.done" title="Done" data-i18n-title-key="nav.done">
          <span data-icon="check-circle"></span> <span data-i18n-key="nav.done">Erledigt</span>
          <span class="badge" id="count-done">0</span>
        </button>
      </nav>

      <nav class="nav-section">
        <div class="nav-title" data-i18n-key="nav.projects">Projects</div>
        <div id="project-list"></div>
        ${renderEntitySidebarAddRow({ entityType: 'project', label: t('nav.addProject'), labelKey: 'nav.addProject' })}
      </nav>

      <nav class="nav-section" id="invites-section" style="display:none;">
        <div class="nav-title" data-i18n-key="nav.invitations">Einladungen</div>
        <div id="invites-list"></div>
      </nav>
    `;

    slots.topbar.innerHTML = `
      <button type="button" class="today-focus-btn" id="today-focus-btn" title="Heute-Ansicht" data-i18n-title-key="todayFocus.toggleTitle"><span class="today-calendar-icon" aria-hidden="true"></span><span data-i18n-key="todayFocus.short">Heute</span></button>
      <button type="button" class="minimal-todos-btn" id="minimal-todos-btn" title="Ruhige Ansicht" data-i18n-title-key="minimalTodos.toggleTitle"><span data-icon="leaf"></span><span data-i18n-key="minimalTodos.short">Ruhe</span></button>
    `;

    slots.main.innerHTML = `
      <div class="stats-bar" id="stats-bar"></div>
      <div class="todo-list" id="todo-list"></div>
      ${TASK_DIALOGS_HTML}
    `;

    slots.floating.innerHTML = `
      <button class="fab-add-todo" type="button" data-todo-action="new" aria-label="Create new todo" data-i18n-aria-label-key="todo.create" title="New todo" data-i18n-title-key="todo.new">
        <span>+</span>
      </button>
    `;

    slots.userMenu.innerHTML = `
      <button type="button" class="ui-menu-item user-menu-item" id="sort-toggle-btn" data-user-menu-action="sort" role="menuitem"><span class="menu-item-icon">P1</span><span class="menu-item-label" data-i18n-key="menu.sort.priority">Sort: Priority</span></button>
      <button type="button" class="ui-menu-item user-menu-item" id="toggle-done-btn" data-user-menu-action="toggle-done" role="menuitem"><span class="menu-item-icon" data-icon="ban"></span><span class="menu-item-label">Erledigte anzeigen</span></button>
      <button type="button" class="ui-menu-item user-menu-item" id="dashboard-preferences-menu-btn" data-dashboard-preferences-action="open" role="menuitem"><span class="menu-item-icon" data-icon="sliders-horizontal"></span><span class="menu-item-label" data-i18n-key="dashboard.preferences.open">Dashboard anpassen</span></button>
    `;

    slots.shortcuts.innerHTML = TASK_SHORTCUTS_HTML;
    slots.settingsNav.innerHTML = TASK_SETTINGS_NAV_HTML;
    slots.settings.innerHTML = TASK_SETTINGS_HTML;
    slots.desktopHotkeys.innerHTML = TASK_DESKTOP_HOTKEYS_HTML;
  },
});
