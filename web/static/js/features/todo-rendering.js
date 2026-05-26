import { escapeHtml, formatDate, renderMarkdown, truncateWords } from '../core/utils.js';
import { t as i18nT } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';

export function renderTodoItem(t) {
  const isOverdue = t.due_date && t.status !== 'done' && new Date(t.due_date) < new Date();
  const dueStr = t.due_date ? formatDate(t.due_date) : '';
  const prioColor = { 1: '#ef4444', 2: '#f59e0b', 3: '#10b981', 4: '#94a3b8' }[t.priority] || '#94a3b8';
  const hasMeta = dueStr || t.remind_at;
  const desc = t.description ? truncateWords(t.description, 12) : '';
  const hasDesc = desc && desc.length > 0;

  return `
    <div class="todo-item ${t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in-progress' : ''}" data-id="${t.id}" data-status="${escapeHtml(t.status)}" draggable="true" onclick="editTodo(${t.id})"
      ondragstart="handleTodoDragStart(event)" ondragend="handleTodoDragEnd(event)">
      <div class="todo-check" onclick="event.stopPropagation(); toggleTodo(${t.id})">
        ${t.status === 'done' ? iconSvg('check') : t.status === 'in_progress' ? iconSvg('flame') : ''}
      </div>
      <div class="todo-body ${hasMeta || hasDesc ? 'has-meta' : ''}">
        <div class="todo-main">
          <span class="todo-prio priority-dot" title="${escapeHtml(i18nT('todo.priority'))}" style="background:${prioColor}"></span>
          <span class="todo-title">${escapeHtml(t.title)}</span>
        </div>
        ${hasMeta || hasDesc ? `
        <div class="todo-meta-row">
          ${dueStr ? `<span class="todo-due ${isOverdue ? 'overdue' : ''}">${iconSvg('calendar')} ${dueStr}${isOverdue ? ` (${escapeHtml(i18nT('todo.overdue'))})` : ''}</span>` : ''}
          ${desc ? `<span class="todo-desc-preview">${renderMarkdown(desc)}</span>` : ''}
        </div>
        ` : ''}
      </div>
      <div class="todo-actions" onclick="event.stopPropagation()">
        <button onclick="deleteTodo(${t.id})" title="${escapeHtml(i18nT('common.delete'))}">${iconSvg('trash-2')}</button>
      </div>
    </div>
  `;
}
