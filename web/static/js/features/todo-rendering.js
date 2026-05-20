import { escapeHtml, formatDate, renderMarkdown, truncateWords } from '../core/utils.js';

export function renderTodoItem(t) {
  const isOverdue = t.due_date && t.status !== 'done' && new Date(t.due_date) < new Date();
  const dueStr = t.due_date ? formatDate(t.due_date) : '';
  const prioEmoji = { 1: '🔴', 2: '🟡', 3: '🟢', 4: '⚪' }[t.priority] || '⚪';
  const hasMeta = dueStr || t.remind_at;
  const desc = t.description ? truncateWords(t.description, 12) : '';
  const hasDesc = desc && desc.length > 0;

  return `
    <div class="todo-item ${t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in-progress' : ''}" data-id="${t.id}" draggable="true" onclick="editTodo(${t.id})"
      ondragstart="handleTodoDragStart(event)" ondragend="handleTodoDragEnd(event)">
      <div class="todo-check" onclick="event.stopPropagation(); toggleTodo(${t.id})">
        ${t.status === 'done' ? '✓' : t.status === 'in_progress' ? '●' : ''}
      </div>
      <div class="todo-body ${hasMeta || hasDesc ? 'has-meta' : ''}">
        <div class="todo-main">
          <span class="todo-prio" title="Priorität">${prioEmoji}</span>
          <span class="todo-title">${escapeHtml(t.title)}</span>
        </div>
        ${hasMeta || hasDesc ? `
        <div class="todo-meta-row">
          ${dueStr ? `<span class="todo-due ${isOverdue ? 'overdue' : ''}">📅 ${dueStr}${isOverdue ? ' (überfällig)' : ''}</span>` : ''}
          ${desc ? `<span class="todo-desc-preview">${renderMarkdown(desc)}</span>` : ''}
        </div>
        ` : ''}
      </div>
      <div class="todo-actions" onclick="event.stopPropagation()">
        <button onclick="deleteTodo(${t.id})" title="Löschen">🗑️</button>
      </div>
    </div>
  `;
}
