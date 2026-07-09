import { t } from '../i18n/index.js';
import { iconSvg, markerHtml, safeColor } from '../icons/lucide-icons.js';

const MODE_KEY = 'nia-calendar-view-mode';
const ANCHOR_KEY = 'nia-calendar-anchor-date';
const CONTROLS_KEY = 'nia-calendar-controls-open';
const MODES = ['day', 'week', 'month'];

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
  let toolbarResizeObserver = null;
  let stickyWeekHeaderBound = false;
  let stickyWeekHeaderFrame = 0;

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

  function startOfMonth(date) {
    return startOfDay(new Date(date.getFullYear(), date.getMonth(), 1));
  }

  function startOfMonthGrid(date) {
    return startOfWeek(startOfMonth(date));
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

  function renderNavControls(extraClass = '') {
    return `<div class="calendar-nav-actions calendar-control-group ${extraClass}" aria-label="${escapeHtmlAttr(t('calendar.navigation'))}">
      <button type="button" class="btn btn-secondary btn-icon" data-calendar-action="prev" title="${escapeHtmlAttr(t('calendar.prev'))}">${iconSvg('chevron-left')}</button>
      <button type="button" class="btn btn-secondary btn-small" data-calendar-action="today">${escapeHtml(t('calendar.today'))}</button>
      <button type="button" class="btn btn-secondary btn-icon" data-calendar-action="next" title="${escapeHtmlAttr(t('calendar.next'))}">${iconSvg('chevron-right')}</button>
    </div>`;
  }

  function renderModeControls(extraClass = '') {
    return `<div class="calendar-mode-switch calendar-control-group ${extraClass}" role="group" aria-label="${escapeHtmlAttr(t('calendar.mode'))}">
      ${MODES.map(item => `<button type="button" class="btn btn-secondary btn-small calendar-mode-btn ${mode === item ? 'active' : ''}" data-calendar-mode="${escapeHtmlAttr(item)}">${escapeHtml(t(`calendar.mode.${item}`))}</button>`).join('')}
    </div>`;
  }

  function renderToolbar() {
    return `
      <div class="overview-dashboard calendar-toolbar ${controlsOpen ? 'is-controls-open' : ''}" data-calendar-controls-layout="pending">
        <div class="overview-dashboard-header calendar-heading">
          <div class="overview-greeting">
            <span class="overview-avatar calendar-avatar" aria-hidden="true">${iconSvg('calendar-days')}</span>
            <div class="calendar-title-wrap">
              <h2>${escapeHtml(t('calendar.title'))}</h2>
            </div>
          </div>
          <div class="calendar-header-controls">
            <div class="calendar-inline-controls" aria-label="${escapeHtmlAttr(t('calendar.inlineControls'))}">
              ${renderNavControls('calendar-inline-nav')}
              ${renderModeControls('calendar-inline-mode')}
            </div>
            <button type="button" class="btn btn-secondary btn-small calendar-controls-toggle" data-calendar-action="toggle-controls" aria-expanded="${controlsOpen ? 'true' : 'false'}">
              ${iconSvg(controlsOpen ? 'chevron-up' : 'chevron-down')}
              <span>${escapeHtml(controlsOpen ? t('calendar.controls.hide') : t('calendar.controls.show'))}</span>
            </button>
          </div>
        </div>
        <div class="calendar-toolbar-actions" ${controlsOpen ? '' : 'hidden'}>
          ${renderNavControls('calendar-panel-nav')}
          ${renderModeControls('calendar-panel-mode')}
        </div>
      </div>`;
  }

  function scheduleToolbarLayout() {
    window.requestAnimationFrame(() => {
      const toolbar = document.querySelector('.calendar-view .calendar-toolbar');
      if (!toolbar) return;
      updateToolbarLayout(toolbar);
      if (!toolbarResizeObserver) {
        toolbarResizeObserver = new ResizeObserver(entries => {
          for (const entry of entries) updateToolbarLayout(entry.target);
        });
      }
      toolbarResizeObserver.disconnect();
      toolbarResizeObserver.observe(toolbar);
    });
  }

  function updateToolbarLayout(toolbar) {
    const heading = toolbar.querySelector('.calendar-heading');
    const greeting = toolbar.querySelector('.overview-greeting');
    const nav = toolbar.querySelector('.calendar-inline-nav');
    const modeSwitch = toolbar.querySelector('.calendar-inline-mode');
    const toggle = toolbar.querySelector('.calendar-controls-toggle');
    if (!heading || !greeting || !nav || !modeSwitch || !toggle) return;

    if (window.matchMedia('(max-width: 900px)').matches) {
      toolbar.dataset.calendarControlsLayout = 'collapsed';
      return;
    }

    toolbar.dataset.calendarControlsLayout = 'measure';
    const available = Math.max(0, heading.clientWidth - greeting.offsetWidth - 18);
    const navWidth = nav.scrollWidth;
    const modeWidth = modeSwitch.scrollWidth;
    const toggleWidth = toggle.scrollWidth;
    const gap = 8;

    if (navWidth + modeWidth + gap <= available) {
      toolbar.dataset.calendarControlsLayout = 'full';
    } else if (navWidth + toggleWidth + gap <= available) {
      toolbar.dataset.calendarControlsLayout = 'partial';
    } else {
      toolbar.dataset.calendarControlsLayout = 'collapsed';
    }
  }


  function scheduleStickyWeekHeaderState() {
    queueStickyWeekHeaderStateUpdate();
    if (stickyWeekHeaderBound) return;
    stickyWeekHeaderBound = true;
    document.addEventListener('scroll', queueStickyWeekHeaderStateUpdate, { capture: true, passive: true });
    document.addEventListener('wheel', queueStickyWeekHeaderStateUpdate, { passive: true });
    document.addEventListener('touchmove', queueStickyWeekHeaderStateUpdate, { passive: true });
    window.addEventListener('resize', queueStickyWeekHeaderStateUpdate, { passive: true });
  }

  function queueStickyWeekHeaderStateUpdate() {
    if (stickyWeekHeaderFrame) return;
    stickyWeekHeaderFrame = window.requestAnimationFrame(() => {
      stickyWeekHeaderFrame = 0;
      updateStickyWeekHeaderState();
    });
  }

  function updateStickyWeekHeaderState() {
    const header = document.querySelector('.calendar-view .calendar-week-timeline-header');
    if (!header || !window.matchMedia('(max-width: 900px)').matches) {
      document.querySelectorAll('.calendar-week-timeline-header.is-stuck').forEach(item => item.classList.remove('is-stuck'));
      return;
    }
    const topValue = window.getComputedStyle(header).top;
    const stickyTop = Number.parseFloat(topValue) || 0;
    header.classList.toggle('is-stuck', header.getBoundingClientRect().top <= stickyTop + 0.5);
  }

  function priorityColor(priority) {
    return { 1: '#ef4444', 2: '#f59e0b', 3: '#10b981', 4: '#94a3b8' }[priority] || '#94a3b8';
  }

  function eventCountInRange(events, start, endExclusive) {
    return events.filter(event => event.start >= start && event.start < endExclusive).length;
  }

  function renderPeriodHeader(title, count) {
    return `<div class="calendar-period-header">
      <div class="calendar-period-title">${escapeHtml(title)}</div>
      <span class="badge">${count}</span>
    </div>`;
  }

  function renderEvent(event, compact = false) {
    const projectMarker = event.project ? markerHtml(event.project) : `<span class="project-dot" style="background:${escapeHtmlAttr(event.color)}"></span>`;
    const time = event.allDay ? '' : `<span class="calendar-event-time">${escapeHtml(formatTime(event.start))}</span>`;
    const statusClass = event.status === 'done' ? 'done' : event.status === 'in_progress' ? 'in-progress' : '';
    const priority = Math.min(4, Math.max(1, Number(event.priority || 3)));
    return `
      <div class="todo-item calendar-event ${statusClass} ${compact ? 'compact' : ''} status-${escapeHtmlAttr(event.status)}" data-id="${escapeHtmlAttr(event.todoId)}" data-status="${escapeHtmlAttr(event.status)}" data-calendar-todo-id="${escapeHtmlAttr(event.todoId)}" draggable="false" style="--calendar-event-color:${escapeHtmlAttr(event.color)};--calendar-priority-color:${escapeHtmlAttr(priorityColor(priority))}">
        ${projectMarker}
        ${time}
        <span class="calendar-event-title-row">
          <span class="calendar-event-priority" title="${escapeHtmlAttr(t('todo.priority'))}"><span class="calendar-event-priority-dot" style="background:${escapeHtmlAttr(priorityColor(priority))}"></span></span>
          <span class="calendar-event-title">${escapeHtml(event.title)}</span>
        </span>
      </div>`;
  }

  function renderMonth(events) {
    const monthStart = startOfMonth(anchorDate);
    const monthEnd = addMonths(monthStart, 1);
    const start = startOfMonthGrid(anchorDate);
    const byDay = eventsByDay(events);
    const weekdays = Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(new Date()), index));
    let html = renderPeriodHeader(formatMonthTitle(anchorDate), eventCountInRange(events, monthStart, monthEnd));
    html += `<div class="calendar-weekdays">${weekdays.map(day => `<div>${escapeHtml(new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(day))}</div>`).join('')}</div>`;
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
    const end = addDays(start, 7);
    const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
    const byDay = eventsByDay(events);
    const dayEvents = days.map(day => byDay.get(dateKey(day)) || []);
    const dayAllDayEvents = dayEvents.map(items => items.filter(event => event.allDay));
    const dayTimedEvents = dayEvents.map(items => items.filter(event => !event.allDay));
    const hasAllDayEvents = dayAllDayEvents.some(items => items.length > 0);

    const desktopTimeline = `<div class="calendar-week-timeline" aria-label="${escapeHtmlAttr(t('calendar.weekTimeline'))}">
      <div class="calendar-week-timeline-header">
        <div class="calendar-week-timezone">${escapeHtml(t('calendar.timeColumn'))}</div>
        ${days.map((day, index) => `<button type="button" class="calendar-week-timeline-day ${isToday(day) ? 'today' : ''}" data-calendar-action="open-day" data-calendar-date="${escapeHtmlAttr(dateKey(day))}">
          <span>${escapeHtml(new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(day))}</span>
          <strong>${escapeHtml(new Intl.DateTimeFormat(locale(), { day: '2-digit' }).format(day))}</strong>
          <em>${dayEvents[index].length}</em>
        </button>`).join('')}
      </div>
      ${hasAllDayEvents ? `<div class="calendar-week-all-day-row">
        <div class="calendar-hour-label">${escapeHtml(t('calendar.allDay'))}</div>
        ${dayAllDayEvents.map(items => `<div class="calendar-week-day-column calendar-event-list">${items.map(event => renderEvent(event, true)).join('')}</div>`).join('')}
      </div>` : ''}
      <div class="calendar-week-timeline-body">
        ${Array.from({ length: 24 }, (_, hour) => `<div class="calendar-week-hour-row">
          <div class="calendar-hour-label">${String(hour).padStart(2, '0')}:00</div>
          ${dayTimedEvents.map(items => {
            const slotEvents = items.filter(event => event.start.getHours() === hour);
            return `<div class="calendar-week-hour-cell ${slotEvents.length ? 'has-events' : ''}">
              ${slotEvents.length ? slotEvents.map(event => renderEvent(event, true)).join('') : ''}
            </div>`;
          }).join('')}
        </div>`).join('')}
      </div>
    </div>`;

    return `${renderPeriodHeader(formatRangeTitle(start, addDays(end, -1)), eventCountInRange(events, start, end))}${desktopTimeline}`;
  }

  function renderDay(events) {
    const dayEvents = events.filter(event => isSameDay(event.start, anchorDate));
    const allDayEvents = dayEvents.filter(event => event.allDay);
    const timedEvents = dayEvents.filter(event => !event.allDay);
    const eventsByHour = new Map();
    for (const event of timedEvents) {
      const hour = event.start.getHours();
      if (!eventsByHour.has(hour)) eventsByHour.set(hour, []);
      eventsByHour.get(hour).push(event);
    }

    return `<section class="calendar-day-view">
      ${renderPeriodHeader(formatDayTitle(anchorDate), dayEvents.length)}
      ${allDayEvents.length ? `<div class="calendar-all-day-row">
        <div class="calendar-hour-label">${escapeHtml(t('calendar.allDay'))}</div>
        <div class="calendar-event-list calendar-all-day-events">${allDayEvents.map(event => renderEvent(event)).join('')}</div>
      </div>` : ''}
      <div class="calendar-day-timeline" aria-label="${escapeHtmlAttr(t('calendar.dayTimeline'))}">
        ${Array.from({ length: 24 }, (_, hour) => {
          const slotEvents = eventsByHour.get(hour) || [];
          return `<div class="calendar-hour-slot ${slotEvents.length ? 'has-events' : ''}">
            <div class="calendar-hour-label">${String(hour).padStart(2, '0')}:00</div>
            <div class="calendar-hour-body">
              ${slotEvents.length ? slotEvents.map(event => renderEvent(event)).join('') : '<div class="calendar-hour-line" aria-hidden="true"></div>'}
            </div>
          </div>`;
        }).join('')}
      </div>
    </section>`;
  }


  function renderMiniEmpty() {
    return `<div class="calendar-mini-empty">${escapeHtml(t('calendar.emptyMini'))}</div>`;
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
        event.stopImmediatePropagation?.();
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
    scheduleToolbarLayout();
    scheduleStickyWeekHeaderState();
    const events = normalizeEvents(todos, projects, hideDone);
    const body = mode === 'month'
      ? renderMonth(events)
      : mode === 'week'
        ? renderWeek(events)
        : renderDay(events);

    return `<section class="calendar-view" aria-label="${escapeHtmlAttr(t('calendar.title'))}">
      ${renderToolbar()}
      ${body}
    </section>`;
  }

  return { renderCalendarView };
}
