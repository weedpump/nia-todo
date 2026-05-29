import { getActiveLanguage, t, translatePage } from '../i18n/index.js';

export function createTodosFeature({
  getTodos,
  setTodos,
  getProjects,
  getCurrentProjectId,
  getCurrentWorkspaceId,
  getAppInitialized,
  getDb,
  dbPut,
  dbGetAll,
  deleteFromDB,
  addToSyncQueue,
  isOnlineForSync,
  syncWithServer,
  sectionsApi,
  renderProjects,
  renderStats,
  renderTodos,
  closeModal,
  confirmDanger,
  showToast,
  setupDescPreview,
  renderMarkdown,
}) {
  let todoFormBound = false;

  function bindTodoForm() {
    if (todoFormBound) return;
    const form = document.getElementById('todo-form');
    if (!form) return;
    todoFormBound = true;
    form.addEventListener('submit', saveTodo);
  }

  function clearDateTimeErrors() {
    for (const id of ['todo-due', 'todo-remind']) {
      const input = document.getElementById(id);
      const error = document.getElementById(`${id}-error`);
      if (input) input.setCustomValidity('');
      if (error) error.textContent = '';
    }
  }

  function validateDateTimeInput(id, label) {
    const input = document.getElementById(id);
    const error = document.getElementById(`${id}-error`);
    if (!input) return true;
    if (error) error.textContent = '';
    if (!input.value && !input.validity.badInput && !input.validity.customError) {
      input.setCustomValidity('');
      return true;
    }

    let message = '';
    if (input.validity.badInput || input.validity.typeMismatch || !input.validity.valid) {
      message = t('todo.invalidDate', { field: label });
    } else {
      const date = new Date(input.value);
      const year = Number(input.value.slice(0, 4));
      if (!Number.isFinite(date.getTime()) || year < 1900 || year > 9999) {
        message = t('todo.invalidDate', { field: label });
      }
    }

    if (message) {
      input.setCustomValidity(message);
      if (error) error.textContent = message;
      return false;
    }
    input.setCustomValidity('');
    return true;
  }

  function bindDateTimeValidation() {
    for (const id of ['todo-due', 'todo-remind']) {
      const input = document.getElementById(id);
      if (!input || input.dataset.validationBound === '1') continue;
      input.dataset.validationBound = '1';
      input.addEventListener('input', () => {
        input.setCustomValidity('');
        const error = document.getElementById(`${id}-error`);
        if (error) error.textContent = '';
      });
      input.addEventListener('invalid', (event) => {
        event.preventDefault();
        validateDateTimeInput(id, id === 'todo-due' ? t('todo.deadline') : t('todo.reminder'));
      });
    }
  }

  function validateTodoDateTimes() {
    const dueOk = validateDateTimeInput('todo-due', t('todo.deadline'));
    const remindOk = validateDateTimeInput('todo-remind', t('todo.reminder'));
    if (!dueOk) document.getElementById('todo-due')?.focus();
    else if (!remindOk) document.getElementById('todo-remind')?.focus();
    return dueOk && remindOk;
  }

  function toIsoOrNull(id) {
    const value = document.getElementById(id)?.value;
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  function runHapticFeedback(pattern = 12) {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
    } catch (error) {
      // Haptics are best-effort only.
    }
  }

  function setDateTimeInputValue(id, date) {
    const input = document.getElementById(id);
    if (!input || !date || !Number.isFinite(date.getTime())) return;
    input.value = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  }

  function startOfToday(base = new Date()) {
    const d = new Date(base);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function nextWeekday(base, targetDay) {
    const d = startOfToday(base);
    const delta = (targetDay + 7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + delta);
    d.setHours(9, 0, 0, 0);
    return d;
  }

  function normalizedName(value) {
    return String(value || '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function compactName(value) {
    return normalizedName(value).replace(/\s+/g, '');
  }

  function quickAddAliases(key) {
    const value = t(key);
    if (!value || value === key) return [];
    return value.split('|').map(item => item.trim().toLowerCase()).filter(Boolean);
  }

  function findProjectByQuickAddName(rawName) {
    const wanted = normalizedName(rawName);
    const compact = compactName(rawName);
    return getProjects().find(p => normalizedName(p.name) === wanted || compactName(p.name) === compact) || null;
  }

  async function loadSectionsForQuickAdd() {
    try { return await dbGetAll('sections'); }
    catch { return []; }
  }

  function findSectionByQuickAddName(rawName, projectId, allSections = []) {
    const wanted = normalizedName(rawName);
    const compact = compactName(rawName);
    return allSections.find(s => {
      if (projectId && String(s.project_id) !== String(projectId)) return false;
      return normalizedName(s.name) === wanted || compactName(s.name) === compact;
    }) || null;
  }

  function parseRelativeQuickAddDate(value, now = new Date()) {
    const n = String(value || '').toLowerCase();
    const todayWords = quickAddAliases('quickAdd.syntax.today');
    const tomorrowWords = quickAddAliases('quickAdd.syntax.tomorrow');
    const dayAfterWords = quickAddAliases('quickAdd.syntax.dayAfterTomorrow');
    const weekendWords = quickAddAliases('quickAdd.syntax.weekend');
    const nextWeekWords = quickAddAliases('quickAdd.syntax.nextWeek');
    const weekdays = quickAddAliases('quickAdd.syntax.weekdays');
    const weekdayIndex = weekdays.indexOf(n);
    let due = null;
    if (todayWords.includes(n)) { due = startOfToday(now); due.setHours(18, 0, 0, 0); }
    else if (tomorrowWords.includes(n)) { due = startOfToday(now); due.setDate(due.getDate() + 1); due.setHours(9, 0, 0, 0); }
    else if (dayAfterWords.includes(n)) { due = startOfToday(now); due.setDate(due.getDate() + 2); due.setHours(9, 0, 0, 0); }
    else if (weekendWords.includes(n)) due = nextWeekday(now, 6);
    else if (nextWeekWords.includes(n)) { due = startOfToday(now); due.setDate(due.getDate() + 7); due.setHours(9, 0, 0, 0); }
    else if (weekdayIndex >= 0) due = nextWeekday(now, weekdayIndex % 7);
    return due;
  }

  function applyQuickAddTime(date, rawTime, now = new Date()) {
    const value = String(rawTime || '').trim().toLowerCase();
    const match = value.match(/^([01]?\d|2[0-3])(?:[:.]([0-5]\d))?$/);
    if (!match) return null;
    const next = date ? new Date(date) : startOfToday(now);
    next.setHours(Number(match[1]), Number(match[2] || 0), 0, 0);
    if (next < now && !date) next.setDate(next.getDate() + 1);
    return next;
  }

  function quickAddDateLabel(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(getActiveLanguage(), { dateStyle: 'short', timeStyle: 'short' }).format(date);
  }

  function tokenIndexMap(rawText) {
    const indexes = [];
    const pattern = /\S+/g;
    let match;
    while ((match = pattern.exec(rawText)) !== null) indexes.push({ start: match.index, end: match.index + match[0].length });
    return indexes;
  }

  function markTokenRange(used, tokenSpans, start, end) {
    tokenSpans.forEach((span, index) => {
      if (span.start < end && span.end > start) used.add(index);
    });
  }

  function tokenIndexForRange(tokenSpans, start, end) {
    const index = tokenSpans.findIndex(span => span.start < end && span.end > start);
    return index >= 0 ? index : 0;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function aliasPattern(aliases) {
    return aliases
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(alias => escapeRegExp(alias).replace(/\\\s+/g, '\\s+'))
      .join('|');
  }

  function quickAddNamePatterns(items = []) {
    const variants = new Set();
    items.forEach(item => {
      const name = String(item.name || '').trim();
      if (!name) return;
      variants.add(escapeRegExp(name).replace(/\\\s+/g, '\\s+'));
      const compact = compactName(name);
      if (compact && compact !== normalizedName(name)) variants.add(escapeRegExp(compact));
    });
    return Array.from(variants).sort((a, b) => b.length - a.length).join('|');
  }

  function projectNamePattern() {
    return quickAddNamePatterns(getProjects());
  }

  function sectionNamePattern(allSections = []) {
    return quickAddNamePatterns(allSections);
  }

  function addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, type, start, end, label, value = '', uniqueKey = null) {
    const tokenIndex = tokenIndexForRange(tokenSpans, start, end);
    if (uniqueKey && matchIndexes.has(uniqueKey)) {
      const existing = matches[matchIndexes.get(uniqueKey)];
      existing.value = value;
      existing.token = tokens[tokenIndex] || '';
    } else {
      if (uniqueKey) matchIndexes.set(uniqueKey, matches.length);
      matches.push({ type, label, value, token: tokens[tokenIndex] || '' });
    }
    markTokenRange(used, tokenSpans, start, end);
  }

  async function parseQuickAddTitle(rawTitle, currentProjectId, formProjectId = null) {
    const original = String(rawTitle || '').trim();
    if (!original) return { title: original, changes: {}, matches: [] };
    const now = new Date();
    const tokens = original.split(/\s+/);
    const tokenSpans = tokenIndexMap(original);
    const used = new Set();
    const changes = {};
    const matches = [];
    const matchIndexes = new Map();
    const allSections = await loadSectionsForQuickAdd();
    const activeProjectId = formProjectId || currentProjectId;
    const prefixAliases = {
      due: quickAddAliases('quickAdd.syntax.duePrefixes'),
      remind: quickAddAliases('quickAdd.syntax.reminderPrefixes'),
      section: quickAddAliases('quickAdd.syntax.sectionPrefixes'),
      project: quickAddAliases('quickAdd.syntax.projectPrefixes'),
    };
    const timeSuffixes = quickAddAliases('quickAdd.syntax.timeSuffixes');
    const timeSuffixPattern = aliasPattern(timeSuffixes);
    const dateAliases = [
      ...quickAddAliases('quickAdd.syntax.today'),
      ...quickAddAliases('quickAdd.syntax.tomorrow'),
      ...quickAddAliases('quickAdd.syntax.dayAfterTomorrow'),
      ...quickAddAliases('quickAdd.syntax.weekend'),
      ...quickAddAliases('quickAdd.syntax.nextWeek'),
      ...quickAddAliases('quickAdd.syntax.weekdays'),
    ];
    const timePattern = `(?:[01]?\\d|2[0-3])(?:[:.]?[0-5]\\d)?(?:\\s+(?:${timeSuffixPattern}))?`;
    const datePattern = aliasPattern(dateAliases);
    const valuePattern = datePattern ? `(?:${datePattern})(?:\\s+${timePattern})?|${timePattern}` : timePattern;

    const addMatch = (type, tokenIndex, label, value = '') => {
      matches.push({ type, label, value, token: tokens[tokenIndex] });
      used.add(tokenIndex);
    };

    tokens.forEach((token, index) => {
      const normalized = token.toLowerCase();
      const priorityMap = new Map([
        ...quickAddAliases('quickAdd.syntax.priority.veryHigh').map(alias => [alias, 1]),
        ...quickAddAliases('quickAdd.syntax.priority.high').map(alias => [alias, 2]),
        ...quickAddAliases('quickAdd.syntax.priority.medium').map(alias => [alias, 3]),
        ...quickAddAliases('quickAdd.syntax.priority.low').map(alias => [alias, 4]),
      ]);
      if (priorityMap.has(normalized)) {
        changes.priority = priorityMap.get(normalized);
        addMatch('priority', index, t('quickAdd.detected.priority'), t(`todo.priority.${changes.priority === 1 ? 'veryHigh' : changes.priority === 2 ? 'high' : changes.priority === 3 ? 'medium' : 'low'}`));
      }
    });

    const projectNames = projectNamePattern();
    if (projectNames) {
      const projectPrefixPattern = aliasPattern(prefixAliases.project);
      const projectRegexes = [
        new RegExp(`(^|\\s)#(?<name>${projectNames})(?=$|\\s)`, 'giu'),
      ];
      if (projectPrefixPattern) projectRegexes.push(new RegExp(`(^|\\s)(?:${projectPrefixPattern})\\s*:\\s*(?<name>${projectNames})(?=$|\\s)`, 'giu'));
      for (const regex of projectRegexes) {
        for (const match of original.matchAll(regex)) {
          const name = match.groups?.name;
          const start = match.index + match[0].indexOf(name) - (match[0].includes('#') ? 1 : 0);
          const end = match.index + match[0].length;
          const project = findProjectByQuickAddName(name);
          if (!project) continue;
          changes.project_id = project.id;
          addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, 'project', start, end, t('quickAdd.detected.project'), project.name, 'project_id');
        }
      }
    }

    const sectionNames = sectionNamePattern(allSections);
    if (sectionNames) {
      const sectionPrefixPattern = aliasPattern(prefixAliases.section);
      const sectionRegexes = [
        new RegExp(`(^|\\s)[/§](?<name>${sectionNames})(?=$|\\s)`, 'giu'),
      ];
      if (sectionPrefixPattern) sectionRegexes.push(new RegExp(`(^|\\s)(?:${sectionPrefixPattern})\\s*:\\s*(?<name>${sectionNames})(?=$|\\s)`, 'giu'));
      for (const regex of sectionRegexes) {
        for (const match of original.matchAll(regex)) {
          const name = match.groups?.name;
          const start = match.index + match[0].search(/[\/§]|\S+\s*:/u);
          const end = match.index + match[0].length;
          const projectId = changes.project_id || activeProjectId;
          const section = findSectionByQuickAddName(name, projectId, allSections);
          if (!section) continue;
          changes.section_id = section.id;
          if (!changes.project_id && section.project_id) changes.project_id = section.project_id;
          addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, 'section', start, end, t('quickAdd.detected.section'), section.name, 'section_id');
        }
      }
    }

    function normalizeTimeValue(rawValue) {
      let value = String(rawValue || '').trim().toLowerCase();
      for (const suffix of timeSuffixes) value = value.replace(new RegExp(`\\s+${escapeRegExp(suffix)}$`, 'iu'), '');
      const compact = value.match(/^([01]?\d|2[0-3])([0-5]\d)$/);
      if (compact) value = `${compact[1]}:${compact[2]}`;
      return value;
    }

    function parseQuickAddDateValue(rawValue, kind) {
      const parts = String(rawValue || '').trim().split(/\s+/).filter(Boolean);
      let date = null;
      let consumed = 0;
      for (let length = Math.min(3, parts.length); length >= 1; length -= 1) {
        const spacedCandidate = parts.slice(0, length).join(' ').toLowerCase();
        const dashedCandidate = parts.slice(0, length).join('-').toLowerCase();
        date = parseRelativeQuickAddDate(spacedCandidate, now) || parseRelativeQuickAddDate(dashedCandidate, now);
        if (date) { consumed = length; break; }
      }
      const timeValue = normalizeTimeValue(parts.slice(consumed).join(' '));
      date = applyQuickAddTime(date || baseDateForKind(kind), timeValue, now) || date;
      return date;
    }

    function setDateField(kind, date, start, end) {
      if (!date || !Number.isFinite(date.getTime())) return;
      const field = kind === 'remind' ? 'remind_at' : 'due_date';
      changes[field] = date.toISOString();
      addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, kind === 'remind' ? 'reminder' : 'due', start, end, t(kind === 'remind' ? 'quickAdd.detected.reminder' : 'quickAdd.detected.due'), quickAddDateLabel(changes[field]), field);
    }

    function baseDateForKind(kind) {
      if (kind === 'remind') return changes.remind_at ? new Date(changes.remind_at) : (changes.due_date ? new Date(changes.due_date) : null);
      return changes.due_date ? new Date(changes.due_date) : null;
    }

    const dateCandidates = [];
    const prefixedRanges = [];
    const duePrefixPattern = aliasPattern(prefixAliases.due);
    const remindPrefixPattern = aliasPattern(prefixAliases.remind);
    const prefixedPatterns = [];
    if (duePrefixPattern) prefixedPatterns.push({ kind: 'due', regex: new RegExp(`(^|\\s)(?:${duePrefixPattern})\\s*:?\\s*(?<value>${valuePattern})(?=$|\\s)`, 'giu') });
    if (remindPrefixPattern) prefixedPatterns.push({ kind: 'remind', regex: new RegExp(`(^|\\s)(?:${remindPrefixPattern})\\s*:?\\s*(?<value>${valuePattern})(?=$|\\s)`, 'giu') });
    for (const { kind, regex } of prefixedPatterns) {
      for (const match of original.matchAll(regex)) {
        const value = match.groups?.value;
        const valueOffset = match[0].lastIndexOf(value);
        const start = match.index + match[0].search(/\S/u);
        const end = match.index + valueOffset + value.length;
        dateCandidates.push({ kind, value, start, end });
        prefixedRanges.push({ kind, start, end });
      }
    }

    if (datePattern) {
      const dueRegex = new RegExp(`(^|\\s)(?<value>(?:${datePattern})(?:\\s+${timePattern})?)(?=$|\\s)`, 'giu');
      for (const match of original.matchAll(dueRegex)) {
        const value = match.groups?.value;
        const start = match.index + match[0].lastIndexOf(value);
        const end = start + value.length;
        if (prefixedRanges.some(range => range.kind === 'remind' && range.start <= start && range.end >= end)) continue;
        dateCandidates.push({ kind: 'due', value, start, end });
      }
    }

    dateCandidates.sort((a, b) => a.start - b.start || (a.kind === 'remind' ? -1 : 1));
    for (const candidate of dateCandidates) {
      if (tokenSpans.some((span, index) => used.has(index) && span.start < candidate.end && span.end > candidate.start)) continue;
      const date = parseQuickAddDateValue(candidate.value, candidate.kind);
      setDateField(candidate.kind, date, candidate.start, candidate.end);
    }

    const explicitTimeRegex = new RegExp(`(^|\\s)(?<value>${timePattern})(?=$|\\s)`, 'giu');
    for (const match of original.matchAll(explicitTimeRegex)) {
      const value = match.groups?.value;
      const start = match.index + match[0].lastIndexOf(value);
      const end = start + value.length;
      if (tokenSpans.some((span, index) => used.has(index) && span.start < end && span.end > start)) continue;
      if (prefixedRanges.some(range => range.kind === 'remind' && range.start <= start && range.end >= end)) continue;
      if (!/[:.]|\s/.test(value)) continue;
      const date = parseQuickAddDateValue(value, 'due');
      setDateField('due', date, start, end);
    }

    const title = tokens.filter((_, index) => !used.has(index)).join(' ').trim() || original;
    return { title, changes, matches };
  }

  function renderQuickAddPreview(result) {
    const preview = document.getElementById('quick-add-preview');
    if (!preview) return;
    const matches = result?.matches || [];
    preview.innerHTML = '';
    preview.hidden = !matches.length;
    if (!matches.length) return;
    for (const match of matches) {
      const chip = document.createElement('span');
      chip.className = `quick-add-chip ${match.type}`;
      const label = document.createElement('span');
      label.className = 'quick-add-chip-label';
      label.textContent = match.label;
      const value = document.createElement('strong');
      value.textContent = match.value || match.token || '';
      chip.append(label, value);
      preview.appendChild(chip);
    }
  }

  function bindQuickAddPreview() {
    const input = document.getElementById('todo-title');
    if (!input || input.dataset.quickAddPreviewBound === '1') return;
    input.dataset.quickAddPreviewBound = '1';
    let seq = 0;
    const update = async () => {
      const id = document.getElementById('todo-id')?.value;
      if (id) { renderQuickAddPreview(null); return; }
      const mySeq = ++seq;
      const projectId = document.getElementById('todo-project')?.value || null;
      const result = await parseQuickAddTitle(input.value, getCurrentProjectId(), projectId);
      if (mySeq === seq) renderQuickAddPreview(result);
    };
    input.addEventListener('input', update);
    document.getElementById('todo-project')?.addEventListener('change', update);
    window.setTimeout(update, 0);
  }

  function getSnoozeDate(mode, todo) {
    const base = todo?.due_date ? new Date(todo.due_date) : new Date();
    const now = new Date();
    const start = Number.isFinite(base.getTime()) && base > now ? base : now;
    const next = new Date(start);
    if (mode === 'hour') next.setHours(next.getHours() + 1);
    else if (mode === 'evening') {
      next.setHours(18, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
    } else if (mode === 'tomorrow') {
      next.setDate(now.getDate() + 1);
      next.setHours(9, 0, 0, 0);
    } else if (mode === 'weekend') return nextWeekday(now, 6);
    else if (mode === 'next-week') {
      next.setDate(now.getDate() + 7);
      next.setHours(9, 0, 0, 0);
    }
    return next;
  }


  async function setTodoStatus(id, status) {
    if (!getAppInitialized() || !getDb()) return;
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo || todo.status === status) return;
    const updatedTodo = { ...todo, status, updated_at: new Date().toISOString() };
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(item => String(item.id) === String(id) ? updatedTodo : item));
    renderStats();
    renderTodos();
    runHapticFeedback(status === 'done' ? 18 : 10);
    if (status === 'done') showToast(t('todo.toast.done'), { type: 'status', id: todo.id, previousStatus: todo.status });
    else if (todo.status === 'done' && status === 'pending') showToast(t('todo.toast.reopened'), { type: 'status', id: todo.id, previousStatus: todo.status });
    await addToSyncQueue('UPDATE_TODO', { id: todo.id, changes: { status } });
    if (isOnlineForSync()) await syncWithServer();
  }

  async function markTodoDone(id) {
    await setTodoStatus(id, 'done');
  }

  async function markTodoInProgress(id) {
    await setTodoStatus(id, 'in_progress');
  }

  async function toggleTodoStatus(id, status) {
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    await setTodoStatus(todo.id, todo.status === status ? 'pending' : status);
  }

  const todoInteractiveTargetSelector = 'button, input, select, textarea, a, label, summary, details, .todo-check, .todo-actions, [role="button"], [contenteditable="true"]';

  function isTodoInteractiveTarget(target) {
    return Boolean(target?.closest?.(todoInteractiveTargetSelector));
  }

  function bindTodoItemClickBehavior() {
    if (document.documentElement.dataset.todoItemClickBound === '1') return;
    document.documentElement.dataset.todoItemClickBound = '1';
    let press = null;

    document.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button > 0) return;
      const item = event.target?.closest?.('.todo-item[data-id]');
      if (!item || isTodoInteractiveTarget(event.target)) return;
      press = { item, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
      item.classList.add('todo-press-active');
    }, { passive: true });

    document.addEventListener('pointermove', (event) => {
      if (!press || event.pointerId !== press.pointerId) return;
      if (Math.abs(event.clientX - press.startX) > 6 || Math.abs(event.clientY - press.startY) > 6) {
        press.moved = true;
        press.item.classList.remove('todo-press-active');
      }
    }, { passive: true });

    const clearPress = (event) => {
      if (!press || event.pointerId !== press.pointerId) return;
      press.item.classList.remove('todo-press-active');
      press = null;
    };
    document.addEventListener('pointerup', clearPress, { passive: true });
    document.addEventListener('pointercancel', clearPress, { passive: true });

    document.addEventListener('click', (event) => {
      if (event.defaultPrevented) return;
      const item = event.target?.closest?.('.todo-item[data-id]');
      if (!item || isTodoInteractiveTarget(event.target)) return;
      event.preventDefault();
      editTodo(item.dataset.id);
    });
  }

  function bindTodoSwipeGestures() {
    if (document.documentElement.dataset.todoSwipeBound === '1') return;
    document.documentElement.dataset.todoSwipeBound = '1';

    const thresholdPx = 80;
    const thresholdRatio = 0.35;
    const lockThreshold = 10;
    const leftEdgeSwipeDeadzonePx = 72;
    const actionZoneLockThreshold = 36;
    let active = null;
    let suppressClickUntil = 0;

    document.addEventListener('click', (event) => {
      if (Date.now() > suppressClickUntil) return;
      if (!event.target?.closest?.('.todo-item')) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }, true);

    document.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || (event.pointerType && event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
      const item = event.target?.closest?.('.todo-item');
      if (!item) return;
      const startedInActionZone = Boolean(event.target.closest('.todo-actions'));
      if (isTodoInteractiveTarget(event.target) && !startedInActionZone) return;
      active = {
        item,
        id: item.dataset.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dx: 0,
        dy: 0,
        locked: null,
        swiped: false,
        startedInActionZone,
        originalDraggable: item.getAttribute('draggable'),
      };
    }, { passive: true });

    document.addEventListener('pointermove', (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      active.dx = event.clientX - active.startX;
      active.dy = event.clientY - active.startY;

      if (!active.locked) {
        const absX = Math.abs(active.dx);
        const absY = Math.abs(active.dy);
        const requiredLockThreshold = active.startedInActionZone ? actionZoneLockThreshold : lockThreshold;
        if (absX < requiredLockThreshold && absY < lockThreshold) return;
        const isRightSwipeFromLeftEdge = active.dx > 0 && active.startX < leftEdgeSwipeDeadzonePx;
        active.locked = absX >= requiredLockThreshold && absX > absY * 1.25 && !isRightSwipeFromLeftEdge ? 'horizontal' : 'vertical';
        if (active.locked === 'vertical') return;
        active.item.setAttribute('draggable', 'false');
        active.item.classList.remove('touch-feedback');
        if (active.item.__niaTouchFeedbackTimer) window.clearTimeout(active.item.__niaTouchFeedbackTimer);
        active.item.classList.add('swiping');
      }

      if (active.locked !== 'horizontal') return;
      event.preventDefault();
      const max = Math.min(130, active.item.clientWidth * 0.45);
      const dx = Math.max(-max, Math.min(max, active.dx));
      active.item.style.setProperty('--swipe-x', `${dx}px`);
      active.item.classList.toggle('swipe-right', dx > 0);
      active.item.classList.toggle('swipe-left', dx < 0);
      active.swiped = true;
    }, { passive: false });

    const finish = async (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      const current = active;
      active = null;
      const item = current.item;
      const actionThreshold = Math.max(thresholdPx, item.clientWidth * thresholdRatio);
      const shouldAct = current.locked === 'horizontal' && Math.abs(current.dx) >= actionThreshold;
      item.classList.remove('swiping', 'swipe-right', 'swipe-left');
      item.style.removeProperty('--swipe-x');
      if (current.originalDraggable === null) item.removeAttribute('draggable');
      else item.setAttribute('draggable', current.originalDraggable);

      if (current.swiped || shouldAct) suppressClickUntil = Date.now() + 450;
      if (!shouldAct) return;
      event.preventDefault();
      if (current.dx < 0) await toggleTodoStatus(current.id, 'done');
      else await toggleTodoStatus(current.id, 'in_progress');
    };

    document.addEventListener('pointerup', finish, { passive: false });
    document.addEventListener('pointercancel', finish, { passive: false });
  }

  function isInteractiveTarget(element) {
    const tag = element?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || element?.isContentEditable;
  }

  function closeTodoActionMenus(except = null) {
    document.querySelectorAll('.todo-status-menu[open], .todo-snooze-menu[open]').forEach((menu) => {
      if (menu !== except) menu.removeAttribute('open');
    });
  }

  function bindTodoStatusMenuBehavior() {
    if (document.documentElement.dataset.todoStatusMenuBound === '1') return;
    document.documentElement.dataset.todoStatusMenuBound = '1';

    document.addEventListener('click', (event) => {
      const menu = event.target?.closest?.('.todo-status-menu, .todo-snooze-menu');
      closeTodoActionMenus(menu || null);
    });

    document.addEventListener('toggle', (event) => {
      const menu = event.target?.closest?.('.todo-status-menu, .todo-snooze-menu');
      if (menu?.open) closeTodoActionMenus(menu);
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeTodoActionMenus();
    });
  }

  function bindTodoHoverKeyboardShortcuts() {
    if (document.documentElement.dataset.todoHoverKeyboardBound === '1') return;
    document.documentElement.dataset.todoHoverKeyboardBound = '1';
    let hoveredTodoId = null;

    document.addEventListener('pointerover', (event) => {
      const item = event.target?.closest?.('.todo-item[data-id]');
      if (item) hoveredTodoId = item.dataset.id;
    }, { passive: true });

    document.addEventListener('pointerout', (event) => {
      const item = event.target?.closest?.('.todo-item[data-id]');
      if (!item || item.contains(event.relatedTarget)) return;
      if (hoveredTodoId === item.dataset.id) hoveredTodoId = null;
    }, { passive: true });

    document.addEventListener('keydown', async (event) => {
      if (event.key !== ' ' && event.key !== 'Spacebar') return;
      if (!hoveredTodoId || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isInteractiveTarget(document.activeElement)) return;
      if (document.querySelector('.modal.active')) return;
      const item = Array.from(document.querySelectorAll('.todo-item[data-id]')).find(el => el.dataset.id === String(hoveredTodoId));
      if (!item) return;
      event.preventDefault();
      await toggleTodo(hoveredTodoId);
    });
  }

  bindTodoItemClickBehavior();
  bindTodoSwipeGestures();
  bindTodoStatusMenuBehavior();
  bindTodoHoverKeyboardShortcuts();

  async function toggleTodo(id) {
    if (!getAppInitialized() || !getDb()) return;
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    const cycle = { pending: 'in_progress', in_progress: 'done', done: 'pending' };
    await setTodoStatus(todo.id, cycle[todo.status] || 'pending');
  }

  function focusTodoTitle() {
    const focus = () => document.getElementById('todo-title')?.focus();
    window.requestAnimationFrame?.(focus);
    window.setTimeout(focus, 80);
  }

  async function showTodoModal(todo = null) {
    bindTodoForm();
    bindDateTimeValidation();
    document.getElementById('todo-form')?.reset();
    clearDateTimeErrors();
    document.getElementById('todo-id').value = '';
    const modalTitle = document.getElementById('todo-modal-title');
    if (modalTitle) {
      modalTitle.dataset.i18nKey = todo ? 'todo.edit' : 'todo.new';
      modalTitle.textContent = t(modalTitle.dataset.i18nKey);
    }
    const projSelect = document.getElementById('todo-project');
    if (projSelect) {
      projSelect.innerHTML = '';
      const currentWorkspaceId = getCurrentWorkspaceId?.();
      const projects = getProjects().filter(p => !currentWorkspaceId || String(p.workspace_id || '') === String(currentWorkspaceId));
      const projectMap = new Map();
      projects.forEach(p => projectMap.set(p.id, { ...p, children: [] }));
      const rootProjects = [];
      projectMap.forEach(p => {
        if (p.parent_id === null || p.parent_id === undefined) rootProjects.push(p);
        else {
          const parent = projectMap.get(p.parent_id);
          if (parent) parent.children.push(p);
        }
      });
      rootProjects.sort((a, b) => (!!a.is_inbox !== !!b.is_inbox ? (a.is_inbox ? -1 : 1) : a.name.localeCompare(b.name)));
      function addProjectOptions(projectNode, depth = 0) {
        const indent = '\u00A0'.repeat(depth * 2) + (depth > 0 ? '└─ ' : '');
        const opt = document.createElement('option');
        opt.value = projectNode.id;
        opt.style.color = projectNode.color;
        opt.textContent = indent + projectNode.name;
        projSelect.appendChild(opt);
        if (projectNode.children && projectNode.children.length > 0) {
          projectNode.children.sort((a, b) => a.name.localeCompare(b.name));
          projectNode.children.forEach(child => addProjectOptions(child, depth + 1));
        }
      }
      rootProjects.forEach(p => addProjectOptions(p));
    }

    if (todo) {
      document.getElementById('todo-id').value = todo.id;
      document.getElementById('todo-title').value = todo.title;
      document.getElementById('todo-desc').value = todo.description || '';
      document.getElementById('todo-priority').value = todo.priority;
      document.getElementById('todo-pinned').checked = Boolean(todo.is_pinned);
      document.getElementById('todo-status').value = todo.status;
      document.getElementById('todo-project').value = todo.project_id || '';
      await onProjectChange(todo.section_id);
      if (todo.due_date) {
        const d = new Date(todo.due_date);
        document.getElementById('todo-due').value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      }
      const reminderDate = todo.remind_at || (todo.reminders && todo.reminders[0] && todo.reminders[0].remind_at);
      if (reminderDate) {
        const d = new Date(reminderDate);
        document.getElementById('todo-remind').value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      }
    } else {
      document.getElementById('todo-pinned').checked = false;
      const currentWorkspaceId = getCurrentWorkspaceId?.();
      const workspaceProjects = getProjects().filter(p => !p.is_shared && (!currentWorkspaceId || String(p.workspace_id || '') === String(currentWorkspaceId)));
      const inboxProject = workspaceProjects.find(p => p.is_inbox) || workspaceProjects[0];
      document.getElementById('todo-project').value = getCurrentProjectId() || inboxProject?.id || '';
      await onProjectChange(null);
    }

    document.getElementById('todo-delete-btn').style.display = todo ? '' : 'none';
    setupDescPreview();
    bindQuickAddPreview();
    renderQuickAddPreview(null);
    if (!todo) {
      const quickAddResult = await parseQuickAddTitle(document.getElementById('todo-title')?.value || '', getCurrentProjectId(), document.getElementById('todo-project')?.value || null);
      renderQuickAddPreview(quickAddResult);
    }
    document.getElementById('todo-modal')?.classList.add('active');
    if (!todo) focusTodoTitle();
  }

  async function onProjectChange(selectedSectionId = null) {
    const projectId = document.getElementById('todo-project').value;
    const sectionSelect = document.getElementById('todo-section');
    if (!sectionSelect) return;
    sectionSelect.innerHTML = `<option value="" data-i18n-key="todo.section.none">${t('todo.section.none')}</option>`;
    sectionSelect.disabled = true;
    if (!projectId) return;

    const loadLocalSections = async () => {
      const allSections = await dbGetAll('sections');
      return allSections.filter(s => String(s.project_id) === String(projectId));
    };

    try {
      let projectSections;
      if (isOnlineForSync()) {
        try {
          const data = await sectionsApi.listByProject(projectId);
          projectSections = data.sections || [];
          const serverIds = new Set(projectSections.map(s => String(s.id)));
          const allLocal = await dbGetAll('sections');
          const localProjectSections = allLocal.filter(s => String(s.project_id) === String(projectId));
          for (const local of localProjectSections) {
            if (!serverIds.has(String(local.id))) await deleteFromDB('sections', local.id);
          }
          for (const s of projectSections) await dbPut('sections', s);
        } catch (serverError) {
          console.warn('Failed to load sections from server, using local cache', serverError);
          projectSections = await loadLocalSections();
        }
      } else {
        projectSections = await loadLocalSections();
      }
      translatePage(sectionSelect);
      for (const s of projectSections) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        sectionSelect.appendChild(opt);
      }
      sectionSelect.disabled = false;
      if (selectedSectionId !== null) sectionSelect.value = selectedSectionId;
    } catch (e) {
      console.error('Failed to load sections for project', e);
    }
  }

  async function saveTodo(event) {
    event.preventDefault();
    if (!getAppInitialized() || !getDb()) return;
    if (!validateTodoDateTimes()) return;
    const id = document.getElementById('todo-id').value;
    const parsedQuickAdd = id ? null : await parseQuickAddTitle(document.getElementById('todo-title').value, getCurrentProjectId(), document.getElementById('todo-project')?.value || null);
    const todoData = {
      title: parsedQuickAdd?.title || document.getElementById('todo-title').value,
      description: document.getElementById('todo-desc').value,
      priority: parseInt(document.getElementById('todo-priority').value),
      is_pinned: document.getElementById('todo-pinned')?.checked || false,
      project_id: document.getElementById('todo-project').value ? parseInt(document.getElementById('todo-project').value) : null,
      section_id: document.getElementById('todo-section').value ? parseInt(document.getElementById('todo-section').value) : null,
      status: document.getElementById('todo-status').value,
      due_date: toIsoOrNull('todo-due'),
      remind_at: toIsoOrNull('todo-remind'),
    };
    if (parsedQuickAdd) {
      if (parsedQuickAdd.changes.priority && Number(document.getElementById('todo-priority').value) === 3) todoData.priority = parsedQuickAdd.changes.priority;
      if (parsedQuickAdd.changes.project_id) todoData.project_id = parsedQuickAdd.changes.project_id;
      if (parsedQuickAdd.changes.section_id && !todoData.section_id) todoData.section_id = parsedQuickAdd.changes.section_id;
      if (parsedQuickAdd.changes.due_date && !todoData.due_date) todoData.due_date = parsedQuickAdd.changes.due_date;
      if (parsedQuickAdd.changes.remind_at && !todoData.remind_at) todoData.remind_at = parsedQuickAdd.changes.remind_at;
    }
    if (todoData.section_id && todoData.project_id) {
      const allSections = await loadSectionsForQuickAdd();
      const selectedSection = allSections.find(section => String(section.id) === String(todoData.section_id));
      if (!selectedSection || String(selectedSection.project_id) !== String(todoData.project_id)) todoData.section_id = null;
    }
    if (id) {
      const existing = getTodos().find(t => t.id === parseInt(id));
      if (existing) {
        const updated = { ...existing, ...todoData, updated_at: new Date().toISOString() };
        await dbPut('todos', updated);
        setTodos(getTodos().map(t => t.id === parseInt(id) ? updated : t));
        await addToSyncQueue('UPDATE_TODO', { id: parseInt(id), changes: todoData });
        if (isOnlineForSync()) await syncWithServer();
      }
    } else {
      const tempId = 'temp-' + Date.now();
      const newTodo = { id: tempId, ...todoData, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), reminders: [] };
      await dbPut('todos', newTodo);
      setTodos([...getTodos(), newTodo]);
      renderProjects();
      renderStats();
      renderTodos();
      closeModal('todo-modal');
      await addToSyncQueue('CREATE_TODO', { ...todoData, _tempId: tempId });
      if (isOnlineForSync()) {
        await syncWithServer();
        renderProjects();
        renderStats();
        renderTodos();
      }
    }
    if (id) {
      renderProjects();
      renderStats();
      renderTodos();
      closeModal('todo-modal');
    }
  }

  async function updateTodoFields(id, changes, toastMessage = null) {
    if (!getAppInitialized() || !getDb()) return;
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    const updatedTodo = { ...todo, ...changes, updated_at: new Date().toISOString() };
    await dbPut('todos', updatedTodo);
    setTodos(getTodos().map(item => String(item.id) === String(id) ? updatedTodo : item));
    renderStats();
    renderTodos();
    if (toastMessage) {
      const previousChanges = Object.fromEntries(Object.keys(changes).map((key) => [key, todo[key]]));
      showToast(toastMessage, { type: 'fields', id: todo.id, changes: previousChanges });
    }
    await addToSyncQueue('UPDATE_TODO', { id: todo.id, changes });
    if (isOnlineForSync()) await syncWithServer();
  }

  async function toggleTodoPin(id) {
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    await updateTodoFields(id, { is_pinned: !Boolean(todo.is_pinned) }, Boolean(todo.is_pinned) ? t('todo.toast.unpinned') : t('todo.toast.pinned'));
  }

  async function snoozeTodo(id, mode) {
    const todo = getTodos().find(x => String(x.id) === String(id));
    if (!todo) return;
    const due = getSnoozeDate(mode, todo);
    await updateTodoFields(id, { due_date: due.toISOString() }, t('todo.toast.snoozed'));
  }

  function editTodo(id) {
    const todo = getTodos().find(t => String(t.id) === String(id));
    if (todo) showTodoModal(todo);
  }

  function deleteTodoFromModal() {
    const id = document.getElementById('todo-id').value;
    if (id) deleteTodo(parseInt(id));
  }

  async function deleteTodo(id) {
    const confirmed = await confirmDanger({
      title: t('todo.deleteTitle'),
      message: t('todo.deleteMessage'),
      confirmText: t('todo.deleteConfirm'),
    });
    if (!confirmed) return;
    const todo = getTodos().find(t => t.id === id);
    if (!todo) return;
    await deleteFromDB('todos', id);
    setTodos(getTodos().filter(t => t.id !== id));
    renderStats();
    renderTodos();
    closeModal('todo-modal');
    showToast(t('todo.toast.deleted'), { type: 'delete', id, data: { ...todo } });
    await addToSyncQueue('DELETE_TODO', { id });
    if (isOnlineForSync()) await syncWithServer();
  }

  return { markTodoDone, markTodoInProgress, setTodoStatus, toggleTodo, toggleTodoPin, snoozeTodo, showTodoModal, onProjectChange, saveTodo, editTodo, deleteTodoFromModal, deleteTodo };
}
