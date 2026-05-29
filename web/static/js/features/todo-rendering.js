import { escapeHtml, escapeHtmlAttr, formatDate, renderMarkdown, truncateWords } from '../core/utils.js';
import { t as i18nT } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';

export function renderTodoItem(t) {
  const dueDate = t.due_date ? new Date(t.due_date) : null;
  const now = new Date();
  const isOverdue = dueDate && t.status !== 'done' && dueDate < now;
  let dueTone = '';
  if (dueDate && !isOverdue && t.status !== 'done') {
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const soonEnd = new Date(todayStart);
    soonEnd.setDate(soonEnd.getDate() + 3);
    soonEnd.setHours(23, 59, 59, 999);
    dueTone = dueDate <= soonEnd ? 'soon' : 'neutral';
  }
  const dueStr = t.due_date ? formatDate(t.due_date) : '';
  const prioColor = { 1: '#ef4444', 2: '#f59e0b', 3: '#10b981', 4: '#94a3b8' }[t.priority] || '#94a3b8';
  const hasMeta = dueStr || t.remind_at;
  const desc = t.description ? truncateWords(t.description, 12) : '';
  const hasDesc = desc && desc.length > 0;
  const idArg = JSON.stringify(t.id);
  const pinned = Boolean(t.is_pinned);

  return `
    <div class="todo-item ${t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in-progress' : ''} ${pinned ? 'pinned' : ''}" data-id="${escapeHtmlAttr(String(t.id))}" data-status="${escapeHtml(t.status)}" draggable="true"
      ondragstart="handleTodoDragStart(event)" ondragend="handleTodoDragEnd(event)">
      <button type="button" class="todo-check" onclick='event.stopPropagation(); toggleTodo(${idArg})' aria-label="${escapeHtmlAttr(i18nT('todo.status'))}">
        ${t.status === 'done' ? iconSvg('check') : t.status === 'in_progress' ? iconSvg('flame') : ''}
      </button>
      <div class="todo-body ${hasMeta || hasDesc ? 'has-meta' : ''}">
        <div class="todo-main">
          <span class="todo-prio priority-dot" title="${escapeHtml(i18nT('todo.priority'))}" style="background:${prioColor}"></span>
          ${pinned ? `<span class="todo-pin-marker" title="${escapeHtml(i18nT('todo.pinned'))}">${iconSvg('star')}</span>` : ''}
          <span class="todo-title">${escapeHtml(t.title)}</span>
        </div>
        ${hasMeta || hasDesc ? `
        <div class="todo-meta-row">
          ${dueStr ? `<span class="todo-due ${isOverdue ? 'overdue' : dueTone}">${iconSvg('calendar')} ${dueStr}${isOverdue ? ` (${escapeHtml(i18nT('todo.overdue'))})` : ''}</span>` : ''}
          ${desc ? `<span class="todo-desc-preview">${renderMarkdown(desc)}</span>` : ''}
        </div>
        ` : ''}
      </div>
      <div class="todo-actions" onclick="event.stopPropagation()">
        <details class="todo-status-menu" onclick="event.stopPropagation()">
          <summary aria-label="${escapeHtml(i18nT('todo.status'))}" title="${escapeHtml(i18nT('todo.status'))}">
            <span>${escapeHtml(i18nT(t.status === 'done' ? 'todo.status.done' : t.status === 'in_progress' ? 'todo.status.inProgress' : 'todo.status.pending'))}</span>
            ${iconSvg('chevron-down')}
          </summary>
          <div class="todo-status-options">
            <button type="button" class="${t.status === 'pending' ? 'active' : ''}" onclick='this.closest("details")?.removeAttribute("open"); setTodoStatus(${idArg}, "pending")'>${escapeHtml(i18nT('todo.status.pending'))}</button>
            <button type="button" class="${t.status === 'in_progress' ? 'active' : ''}" onclick='this.closest("details")?.removeAttribute("open"); setTodoStatus(${idArg}, "in_progress")'>${escapeHtml(i18nT('todo.status.inProgress'))}</button>
            <button type="button" class="${t.status === 'done' ? 'active' : ''}" onclick='this.closest("details")?.removeAttribute("open"); setTodoStatus(${idArg}, "done")'>${escapeHtml(i18nT('todo.status.done'))}</button>
          </div>
        </details>
        <details class="todo-snooze-menu" onclick="event.stopPropagation()">
          <summary aria-label="${escapeHtml(i18nT('todo.snooze'))}" title="${escapeHtml(i18nT('todo.snooze'))}">${iconSvg('clock')}</summary>
          <div class="todo-status-options">
            <button type="button" onclick='this.closest("details")?.removeAttribute("open"); snoozeTodo(${idArg}, "hour")'>${escapeHtml(i18nT('todo.snooze.hour'))}</button>
            <button type="button" onclick='this.closest("details")?.removeAttribute("open"); snoozeTodo(${idArg}, "evening")'>${escapeHtml(i18nT('todo.snooze.evening'))}</button>
            <button type="button" onclick='this.closest("details")?.removeAttribute("open"); snoozeTodo(${idArg}, "tomorrow")'>${escapeHtml(i18nT('todo.snooze.tomorrow'))}</button>
            <button type="button" onclick='this.closest("details")?.removeAttribute("open"); snoozeTodo(${idArg}, "weekend")'>${escapeHtml(i18nT('todo.snooze.weekend'))}</button>
            <button type="button" onclick='this.closest("details")?.removeAttribute("open"); snoozeTodo(${idArg}, "next-week")'>${escapeHtml(i18nT('todo.snooze.nextWeek'))}</button>
          </div>
        </details>
        <button type="button" onclick='toggleTodoPin(${idArg})' class="todo-pin-btn ${pinned ? 'active' : ''}" title="${escapeHtml(pinned ? i18nT('todo.unpin') : i18nT('todo.pin'))}">${iconSvg('star')}</button>
        <button type="button" onclick='deleteTodo(${idArg})' title="${escapeHtml(i18nT('common.delete'))}">${iconSvg('trash-2')}</button>
      </div>
    </div>
  `;
}
