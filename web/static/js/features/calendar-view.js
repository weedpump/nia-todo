import { t } from '../i18n/index.js';
import { iconSvg, markerHtml, safeColor } from '../icons/lucide-icons.js';

const MODE_KEY = 'nia-calendar-view-mode';
const ANCHOR_KEY = 'nia-calendar-anchor-date';
const CONTROLS_KEY = 'nia-calendar-controls-open';
const MODES = ['month', 'week', 'day', 'agenda'];

export function createCalendarViewFeature({
  escapeHtml,
  escapeHtmlAttr,
  renderTodos,
  openTodo,
}) {
  let mode = normalizeMode(localStorage.getItem(MODE_KEY));
  let anchorDate = parseStoredDate(localStorage.getItem(ANCHOR_KEY)) || startOfDay(new Date());
  let controlsOpen = localStorage.getItem(CONTROLS_KEY) === 'true';
  let actionsBound = false;

  function normalizeMode(value) {
    return MODES.includes(value) ? value : 'month';
  }

  function parseStoredDate(value) {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function startOfDay(date) {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  function addDays(date, amount) {
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
  }

  function addMonths(date, amount) {
    const next = new Date(date);
    next.setMonth(next.getMonth() + amount);
    return next;
  }

  function startOfWeek(date) {
    const next = startOfDay(date);
    const day = next.getDay() || 7;
    next.setDate(next.getDate() - day + 1);
    return next;
  }

  function startOfMonthGrid(date) {
    return startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1));
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function isSameDay(a, b) {
    return dateKey(a) === dateKey(b);
  }

  function isToday(date) {
    return isSameDay(date, new Date());
  }

  function parseTodoDueDate(todo) {
    if (!todo?.due_date) return null;
    const raw = String(todo.due_date);
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const normalized = allDay ? `${raw}T00:00:00` : raw.replace(' ', 'T');
    const date = new Date(normalized);
    if (!Number.isFinite(date.getTime())) return null;
    return { date, allDay };
  }

  function formatMonthTitle(date) {
    return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(date);
  }

  function formatDayTitle(date) {
    return new Intl.DateTimeFormat(locale(), { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(date);
  }

  function formatRangeTitle(start, end) {
    const currentLocale = locale();
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    if (sameMonth) {
      const first = new Intl.DateTimeFormat(currentLocale, { day: '2-digit' }).format(start);
      const last = new Intl.DateTimeFormat(currentLocale, { day: '2-digit', month: 'long', year: 'numeric' }).format(end);
      return `${first}. – ${last}`;
    }
    const formatter = new Intl.DateTimeFormat(currentLocale, { day: '2-digit', month: 'short', year: 'numeric' });
    return `${formatter.format(start)} – ${formatter.format(end)}`;
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function formatShortDay(date) {
    return new Intl.DateTimeFormat(locale(), { weekday: 'short', day: '2-digit' }).format(date);
  }

  function locale() {
    return document.documentElement.lang === 'en' ? 'en-US' : 'de-DE';
  }

  function normalizeEvents(todos, projects, hideDone) {
    const projectById = new Map(projects.map(project => [Number(project.id), project]));
    return todos
      .filter(todo => todo?.due_date && (!hideDone || todo.status !== 'done'))
      .map(todo => {
        const due = parseTodoDueDate(todo);
        if (!due) return null;
        const project = projectById.get(Number(todo.project_id));
        return {
          id: `todo:${todo.id}`,
          todoId: todo.id,
          source: 'todo',
          title: todo.title || t('todo.title'),
          start: due.date,
          allDay: due.allDay,
          status: todo.status || 'pending',
          priority: Number(todo.priority || 3),
          project,
          color: project?.color ? safeColor(project.color) : 'var(--accent)',
          readonly: false,
        };
      })
      .filter(Boolean)
      .sort(compareEvents);
  }

  function compareEvents(a, b) {
    const timeDiff = a.start.getTime() - b.start.getTime();
    if (timeDiff) return timeDiff;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.status !== b.status) {
      const order = { in_progress: 0, pending: 1, done: 2 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    }
    return a.priority - b.priority || a.title.localeCompare(b.title);
  }

  function eventsByDay(events) {
    const map = new Map();
    for (const event of events) {
      const key = dateKey(event.start);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(event);
    }
    return map;
  }

  function renderToolbar(title) {
    return `
      <div class="overview-dashboard calendar-toolbar ${controlsOpen ? 'is-controls-open' : ''}">
        <div class="overview-dashboard-header calendar-heading">
          <div class="overview-greeting">
            <span class="overview-avatar calendar-avatar" aria-hidden="true">${iconSvg('calendar-days')}</span>
            <div class="calendar-title-wrap">
              <h2>${escapeHtml(t('calendar.title'))}</h2>
              <div class="overview-subtitle">${escapeHtml(title)}</div>
            </div>
          </div>
        </div>
        <button type="button" class="btn btn-secondary btn-small calendar-controls-toggle" data-calendar-action="toggle-controls" aria-expanded="${controlsOpen ? 'true' : 'false'}">
          ${iconSvg(controlsOpen ? 'chevron-up' : 'chevron-down')}
          <span>${escapeHtml(controlsOpen ? t('calendar.controls.hide') : t('calendar.controls.show'))}</span>
        </button>
        <div class="calendar-toolbar-actions" ${controlsOpen ? '' : 'hidden'}>
          <div class="calendar-nav-actions" aria-label="${escapeHtmlAttr(t('calendar.navigation'))}">
            <button type="button" class="btn btn-secondary btn-icon" data-calendar-action="prev" title="${escapeHtmlAttr(t('calendar.prev'))}">${iconSvg('chevron-left')}</button>
            <button type="button" class="btn btn-secondary btn-small" data-calendar-action="today">${escapeHtml(t('calendar.today'))}</button>
            <button type="button" class="btn btn-secondary btn-icon" data-calendar-action="next" title="${escapeHtmlAttr(t('calendar.next'))}">${iconSvg('chevron-right')}</button>
          </div>
          <div class="calendar-mode-switch" role="group" aria-label="${escapeHtmlAttr(t('calendar.mode'))}">
            ${MODES.map(item => `<button type="button" class="btn btn-secondary btn-small calendar-mode-btn ${mode === item ? 'active' : ''}" data-calendar-mode="${escapeHtmlAttr(item)}">${escapeHtml(t(`calendar.mode.${item}`))}</button>`).join('')}
          </div>
        </div>
      </div>`;
  }

  function renderEvent(event, compact = false) {
    const projectMarker = event.project ? markerHtml(event.project) : `<span class="project-dot" style="background:${escapeHtmlAttr(event.color)}"></span>`;
    const time = event.allDay ? '' : `<span class="calendar-event-time">${escapeHtml(formatTime(event.start))}</span>`;
    return `
      <button type="button" class="calendar-event ${compact ? 'compact' : ''} status-${escapeHtmlAttr(event.status)}" data-calendar-todo-id="${escapeHtmlAttr(event.todoId)}" style="--calendar-event-color:${escapeHtmlAttr(event.color)}">
        ${projectMarker}
        ${time}
        <span class="calendar-event-title">${escapeHtml(event.title)}</span>
        ${event.priority === 1 ? `<span class="calendar-event-priority">P1</span>` : ''}
      </button>`;
  }

  function renderMonth(events) {
    const start = startOfMonthGrid(anchorDate);
    const byDay = eventsByDay(events);
    const weekdays = Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(new Date()), index));
    let html = `<div class="calendar-weekdays">${weekdays.map(day => `<div>${escapeHtml(new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(day))}</div>`).join('')}</div>`;
    html += '<div class="calendar-month-grid">';
    for (let index = 0; index < 42; index += 1) {
      const day = addDays(start, index);
      const key = dateKey(day);
      const dayEvents = byDay.get(key) || [];
      const visibleEvents = dayEvents.slice(0, 3);
      html += `
        <section class="calendar-day-cell ${day.getMonth() !== anchorDate.getMonth() ? 'outside-month' : ''} ${isToday(day) ? 'today' : ''}" data-calendar-day="${escapeHtmlAttr(key)}">
          <button type="button" class="calendar-day-number" data-calendar-action="open-day" data-calendar-date="${escapeHtmlAttr(key)}">${day.getDate()}</button>
          <div class="calendar-day-events">
            ${visibleEvents.map(event => renderEvent(event, true)).join('')}
            ${dayEvents.length > visibleEvents.length ? `<button type="button" class="calendar-more-btn" data-calendar-action="open-day" data-calendar-date="${escapeHtmlAttr(key)}">+${dayEvents.length - visibleEvents.length} ${escapeHtml(t('calendar.more'))}</button>` : ''}
          </div>
        </section>`;
    }
    html += '</div>';
    return html;
  }

  function renderWeek(events) {
    const start = startOfWeek(anchorDate);
    const byDay = eventsByDay(events);
    return `<div class="calendar-week-grid">
      ${Array.from({ length: 7 }, (_, index) => {
        const day = addDays(start, index);
        const dayEvents = byDay.get(dateKey(day)) || [];
        return `<section class="calendar-week-day ${isToday(day) ? 'today' : ''}">
          <button type="button" class="calendar-week-day-header" data-calendar-action="open-day" data-calendar-date="${escapeHtmlAttr(dateKey(day))}">
            <span>${escapeHtml(formatShortDay(day))}</span>
            <strong>${dayEvents.length}</strong>
          </button>
          <div class="calendar-agenda-events">${dayEvents.length ? dayEvents.map(event => renderEvent(event)).join('') : renderMiniEmpty()}</div>
        </section>`;
      }).join('')}
    </div>`;
  }

  function renderDay(events) {
    const dayEvents = events.filter(event => isSameDay(event.start, anchorDate));
    return `<section class="calendar-day-view">
      <div class="calendar-day-view-header">
        <div class="calendar-day-view-date">${escapeHtml(formatDayTitle(anchorDate))}</div>
        <span class="badge">${dayEvents.length}</span>
      </div>
      <div class="calendar-agenda-events calendar-day-events-list">
        ${dayEvents.length ? dayEvents.map(event => renderEvent(event)).join('') : renderEmpty(t('calendar.emptyDayTitle'), t('calendar.emptyDayHint'))}
      </div>
    </section>`;
  }

  function renderAgenda(events) {
    const today = startOfDay(new Date());
    const agendaEvents = events.filter(event => event.start >= addDays(today, -30)).slice(0, 80);
    if (!agendaEvents.length) return renderEmpty(t('calendar.emptyTitle'), t('calendar.emptyHint'));
    const byDay = eventsByDay(agendaEvents);
    return `<div class="calendar-agenda-list">
      ${Array.from(byDay.entries()).map(([key, dayEvents]) => {
        const date = parseStoredDate(key);
        const overdue = date < today;
        return `<section class="calendar-agenda-day ${isToday(date) ? 'today' : ''} ${overdue ? 'overdue' : ''}">
          <div class="calendar-agenda-day-title">
            <span>${escapeHtml(overdue ? `${t('calendar.overdue')} · ${formatDayTitle(date)}` : formatDayTitle(date))}</span>
            <span class="badge">${dayEvents.length}</span>
          </div>
          <div class="calendar-agenda-events">${dayEvents.map(event => renderEvent(event)).join('')}</div>
        </section>`;
      }).join('')}
    </div>`;
  }

  function renderMiniEmpty() {
    return `<div class="calendar-mini-empty">${escapeHtml(t('calendar.emptyMini'))}</div>`;
  }

  function renderEmpty(title, hint) {
    return `<div class="empty-state calendar-empty">
      <div class="emoji">${iconSvg('calendar-days')}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(hint)}</p>
    </div>`;
  }

  function currentTitle() {
    if (mode === 'month') return formatMonthTitle(anchorDate);
    if (mode === 'week') return formatRangeTitle(startOfWeek(anchorDate), addDays(startOfWeek(anchorDate), 6));
    if (mode === 'day') return formatDayTitle(anchorDate);
    return t('calendar.mode.agenda');
  }

  function shiftAnchor(direction) {
    if (mode === 'month') anchorDate = addMonths(anchorDate, direction);
    else if (mode === 'week') anchorDate = addDays(anchorDate, direction * 7);
    else anchorDate = addDays(anchorDate, direction);
    persistAnchor();
  }

  function persistAnchor() {
    localStorage.setItem(ANCHOR_KEY, dateKey(anchorDate));
  }

  function bindActions() {
    if (actionsBound) return;
    actionsBound = true;
    document.addEventListener('click', (event) => {
      const calendarTodo = event.target?.closest?.('[data-calendar-todo-id]');
      if (calendarTodo) {
        event.preventDefault();
        openTodo?.(calendarTodo.dataset.calendarTodoId);
        return;
      }

      const modeButton = event.target?.closest?.('[data-calendar-mode]');
      if (modeButton) {
        event.preventDefault();
        mode = normalizeMode(modeButton.dataset.calendarMode);
        localStorage.setItem(MODE_KEY, mode);
        renderTodos?.();
        return;
      }

      const actionButton = event.target?.closest?.('[data-calendar-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.calendarAction;
      if (!actionButton.closest('.calendar-view')) return;
      event.preventDefault();
      if (action === 'prev') shiftAnchor(-1);
      if (action === 'next') shiftAnchor(1);
      if (action === 'today') {
        anchorDate = startOfDay(new Date());
        persistAnchor();
      }
      if (action === 'toggle-controls') {
        controlsOpen = !controlsOpen;
        localStorage.setItem(CONTROLS_KEY, controlsOpen ? 'true' : 'false');
      }
      if (action === 'open-day') {
        const date = parseStoredDate(actionButton.dataset.calendarDate);
        if (date) {
          anchorDate = date;
          mode = 'day';
          localStorage.setItem(MODE_KEY, mode);
          persistAnchor();
        }
      }
      renderTodos?.();
    });
  }

  function renderCalendarView({ todos, projects, hideDone }) {
    bindActions();
    const events = normalizeEvents(todos, projects, hideDone);
    const body = mode === 'month'
      ? renderMonth(events)
      : mode === 'week'
        ? renderWeek(events)
        : mode === 'day'
          ? renderDay(events)
          : renderAgenda(events);

    return `<section class="calendar-view" aria-label="${escapeHtmlAttr(t('calendar.title'))}">
      ${renderToolbar(currentTitle())}
      ${events.length ? body : renderEmpty(t('calendar.emptyTitle'), t('calendar.emptyHint'))}
    </section>`;
  }

  return { renderCalendarView };
}
