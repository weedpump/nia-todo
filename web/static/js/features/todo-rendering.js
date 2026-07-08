import { escapeHtml, escapeHtmlAttr, formatDate, renderMarkdown, truncateWords } from '../core/utils.js';
import { t as i18nT } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';

function locationReminderLabel(todo) {
  const reminder = todo?.location_reminder || todo?.location_reminders?.find?.((entry) => entry && entry.enabled !== 0 && entry.enabled !== false) || null;
  if (!reminder || reminder.enabled === 0 || reminder.enabled === false) return '';
  const trigger = String(reminder.trigger_type || reminder.triggerType || '').toLowerCase();
  const triggerKey = trigger === 'departure' ? 'todo.location.departureShort' : 'todo.location.arrivalShort';
  const place = String(reminder.place_name || reminder.placeName || reminder.address || '').trim();
  const prefix = i18nT(triggerKey);
  return place ? `${prefix}: ${place}` : prefix;
}

function recurringLabel(rule) {
  if (!rule || typeof rule !== 'object') return '';
  const frequency = String(rule.frequency || '').toLowerCase();
  const interval = Number.parseInt(rule.interval || 1, 10) || 1;
  const key = `todo.recurring.label.${frequency}`;
  const label = i18nT(key, { interval });
  return label === key ? '' : label;
}

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
  const reminderTime = t.remind_at || t.reminders?.find?.(r => !r.sent_at)?.remind_at || t.reminders?.[0]?.remind_at || '';
  const prioColor = { 1: '#ef4444', 2: '#f59e0b', 3: '#10b981', 4: '#94a3b8' }[t.priority] || '#94a3b8';
  const remindStr = reminderTime ? formatDate(reminderTime) : '';
  const recurrenceStr = recurringLabel(t.recurring_rule);
  const locationStr = locationReminderLabel(t);
  const subtasks = Array.isArray(t.subtasks) ? t.subtasks : [];
  const doneSubtasks = subtasks.filter(subtask => Boolean(subtask.is_done)).length;
  const hasSubtasks = subtasks.length > 0;
  const subtaskProgress = hasSubtasks ? i18nT('todo.subtasks.progress', { done: doneSubtasks, total: subtasks.length }) : '';
  const commentsCount = Number(t.comments_count ?? (Array.isArray(t.comments) ? t.comments.length : 0)) || 0;
  const hasComments = commentsCount > 0;
  const attachmentsCount = Number(t.attachments_count ?? (Array.isArray(t.attachments) ? t.attachments.length : 0)) || 0;
  const hasAttachments = attachmentsCount > 0;
  const hasMeta = dueStr || remindStr || recurrenceStr || locationStr || hasSubtasks || hasComments || hasAttachments;
  const desc = t.description ? truncateWords(String(t.description).replace(/\s+/g, ' ').trim(), 18) : '';
  const hasDesc = desc && desc.length > 0;
  const todoIdAttr = escapeHtmlAttr(String(t.id));
  const pinned = Boolean(t.is_pinned);
  const statusLabel = i18nT(t.status === 'done' ? 'todo.status.done' : t.status === 'in_progress' ? 'todo.status.inProgress' : 'todo.status.pending');
  const statusIcon = t.status === 'done' ? 'check' : t.status === 'in_progress' ? 'flame' : 'circle';
  const renderStatusMenu = (className = '') => `
        <details class="todo-status-menu ${className}">
          <summary aria-label="${escapeHtml(i18nT('todo.status'))}" title="${escapeHtml(statusLabel)}">
            <span class="todo-status-menu-current-icon" aria-hidden="true">${iconSvg(statusIcon)}</span>
            <span class="todo-status-menu-label">${escapeHtml(statusLabel)}</span>
            ${iconSvg('chevron-down')}
          </summary>
          <div class="todo-status-options todo-action-menu ui-menu" role="menu">
            <button type="button" class="ui-menu-item ${t.status === 'pending' ? 'active' : ''}" role="menuitem" aria-current="${t.status === 'pending' ? 'true' : 'false'}" data-todo-action="set-status" data-todo-id="${todoIdAttr}" data-todo-status="pending"><span>${escapeHtml(i18nT('todo.status.pending'))}</span>${t.status === 'pending' ? iconSvg('check') : ''}</button>
            <button type="button" class="ui-menu-item ${t.status === 'in_progress' ? 'active' : ''}" role="menuitem" aria-current="${t.status === 'in_progress' ? 'true' : 'false'}" data-todo-action="set-status" data-todo-id="${todoIdAttr}" data-todo-status="in_progress"><span>${escapeHtml(i18nT('todo.status.inProgress'))}</span>${t.status === 'in_progress' ? iconSvg('check') : ''}</button>
            <button type="button" class="ui-menu-item ${t.status === 'done' ? 'active' : ''}" role="menuitem" aria-current="${t.status === 'done' ? 'true' : 'false'}" data-todo-action="set-status" data-todo-id="${todoIdAttr}" data-todo-status="done"><span>${escapeHtml(i18nT('todo.status.done'))}</span>${t.status === 'done' ? iconSvg('check') : ''}</button>
          </div>
        </details>`;

  return `
    <div class="todo-item ${t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in-progress' : ''} ${pinned ? 'pinned' : ''}" data-id="${todoIdAttr}" data-status="${escapeHtmlAttr(t.status)}" draggable="true">
      <div class="todo-status-control">
        <button type="button" class="todo-check" data-todo-action="toggle-status" data-todo-id="${todoIdAttr}" aria-label="${escapeHtmlAttr(i18nT('todo.status'))}">
          ${t.status === 'done' ? iconSvg('check') : t.status === 'in_progress' ? iconSvg('flame') : ''}
        </button>
        ${renderStatusMenu('todo-status-menu-left')}
      </div>
      <div class="todo-body ${hasMeta || hasDesc ? 'has-meta' : ''}">
        <div class="todo-main">
          <span class="todo-prio priority-dot" title="${escapeHtml(i18nT('todo.priority'))}" style="background:${prioColor}"></span>
          <div class="todo-title-wrap">
            <span class="todo-title">${escapeHtml(t.title)}</span>
            ${hasMeta ? `
            <div class="todo-meta-row">
              ${dueStr ? `<span class="todo-meta-chip todo-due ${isOverdue ? 'overdue' : dueTone}">${iconSvg('calendar')} ${dueStr}${isOverdue ? ` (${escapeHtml(i18nT('todo.overdue'))})` : ''}</span>` : ''}
              ${remindStr ? `<span class="todo-meta-chip todo-reminder">${iconSvg('bell')} ${remindStr}</span>` : ''}
              ${recurrenceStr ? `<span class="todo-meta-chip todo-recurring">${iconSvg('repeat')} ${escapeHtml(recurrenceStr)}</span>` : ''}
              ${locationStr ? `<span class="todo-meta-chip todo-location" title="${escapeHtmlAttr(i18nT('todo.location.androidOnlyPillTitle'))}">${iconSvg('map-pin')} ${escapeHtml(locationStr)}</span>` : ''}
              ${hasSubtasks ? `<span class="todo-meta-chip todo-subtasks-progress">${iconSvg('list-todo')} ${escapeHtml(subtaskProgress)}</span>` : ''}
              ${hasComments ? `<span class="todo-meta-chip todo-comments-progress">${iconSvg('notebook-pen')} ${escapeHtml(i18nT('todo.comments.count', { count: commentsCount }))}</span>` : ''}
              ${hasAttachments ? `<span class="todo-meta-chip todo-attachments-progress">${iconSvg('paperclip')} ${escapeHtml(i18nT('todo.attachments.count', { count: attachmentsCount }))}</span>` : ''}
            </div>
            ` : ''}
            ${hasDesc ? `<div class="todo-desc-preview" title="${escapeHtmlAttr(String(t.description || ''))}">${renderMarkdown(desc)}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="todo-actions">
        ${renderStatusMenu('todo-status-menu-actions')}
        <details class="todo-snooze-menu">
          <summary aria-label="${escapeHtml(i18nT('todo.snooze'))}" title="${escapeHtml(i18nT('todo.snooze'))}">${iconSvg('clock')}</summary>
          <div class="todo-status-options todo-action-menu ui-menu" role="menu">
            <button type="button" class="ui-menu-item" role="menuitem" data-todo-action="snooze" data-todo-id="${todoIdAttr}" data-snooze-mode="hour">${escapeHtml(i18nT('todo.snooze.hour'))}</button>
            <button type="button" class="ui-menu-item" role="menuitem" data-todo-action="snooze" data-todo-id="${todoIdAttr}" data-snooze-mode="evening">${escapeHtml(i18nT('todo.snooze.evening'))}</button>
            <button type="button" class="ui-menu-item" role="menuitem" data-todo-action="snooze" data-todo-id="${todoIdAttr}" data-snooze-mode="tomorrow">${escapeHtml(i18nT('todo.snooze.tomorrow'))}</button>
            <button type="button" class="ui-menu-item" role="menuitem" data-todo-action="snooze" data-todo-id="${todoIdAttr}" data-snooze-mode="weekend">${escapeHtml(i18nT('todo.snooze.weekend'))}</button>
            <button type="button" class="ui-menu-item" role="menuitem" data-todo-action="snooze" data-todo-id="${todoIdAttr}" data-snooze-mode="next-week">${escapeHtml(i18nT('todo.snooze.nextWeek'))}</button>
          </div>
        </details>
        <button type="button" data-todo-action="toggle-pin" data-todo-id="${todoIdAttr}" class="btn btn-secondary btn-icon todo-pin-btn ${pinned ? 'active' : ''}" title="${escapeHtml(pinned ? i18nT('todo.unpin') : i18nT('todo.pin'))}">${iconSvg('star')}</button>
        <button type="button" class="btn btn-secondary btn-icon" data-todo-action="duplicate" data-todo-id="${todoIdAttr}" title="${escapeHtml(i18nT('todo.duplicate'))}">${iconSvg('copy')}</button>
        <button type="button" class="btn btn-danger btn-icon" data-todo-action="delete" data-todo-id="${todoIdAttr}" title="${escapeHtml(i18nT('common.delete'))}">${iconSvg('trash-2')}</button>
        <button type="button" class="btn btn-secondary btn-icon todo-actions-reveal-btn" data-todo-actions-reveal="true" aria-expanded="false" aria-label="${escapeHtml(i18nT('common.more'))}" title="${escapeHtml(i18nT('common.more'))}">${iconSvg('chevron-left')}</button>
      </div>
    </div>
  `;
}
