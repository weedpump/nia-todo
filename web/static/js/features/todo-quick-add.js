export function createTodoQuickAddFeature({
  getActiveLanguage,
  t,
  getProjects,
  getCurrentProjectId,
  getSavedPlaces = () => [],
  dbGetAll,
}) {
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

  function findPlaceByQuickAddName(rawName) {
    const wanted = normalizedName(rawName);
    const compact = compactName(rawName);
    return getSavedPlaces().find(place => normalizedName(place.name) === wanted || compactName(place.name) === compact) || null;
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

  function placeNamePattern() {
    return quickAddNamePatterns(getSavedPlaces());
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
      recurring: quickAddAliases('quickAdd.syntax.recurringPrefixes'),
      location: quickAddAliases('quickAdd.syntax.locationPrefixes'),
      locationDeparture: quickAddAliases('quickAdd.syntax.locationDeparturePrefixes'),
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


    const recurringValueAliases = [
      ['daily', quickAddAliases('quickAdd.syntax.recurring.daily')],
      ['weekly', quickAddAliases('quickAdd.syntax.recurring.weekly')],
      ['monthly', quickAddAliases('quickAdd.syntax.recurring.monthly')],
      ['yearly', quickAddAliases('quickAdd.syntax.recurring.yearly')],
    ];
    const recurringPrefixPattern = aliasPattern(prefixAliases.recurring);
    const recurringValuePattern = aliasPattern(recurringValueAliases.flatMap(([, aliases]) => aliases));
    if (recurringPrefixPattern && recurringValuePattern) {
      const recurringRegexes = [
        new RegExp(`(^|\\s)(?:${recurringPrefixPattern})\\s*:?\\s*(?<value>${recurringValuePattern})(?=$|\\s)`, 'giu'),
      ];
      for (const regex of recurringRegexes) {
        for (const match of original.matchAll(regex)) {
          const value = String(match.groups?.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
          const frequency = recurringValueAliases.find(([, aliases]) => aliases.includes(value))?.[0];
          if (!frequency) continue;
          const valueOffset = match[0].lastIndexOf(match.groups.value);
          const start = match.index + match[0].search(/\S/u);
          const end = match.index + valueOffset + match.groups.value.length;
          changes.recurring_rule = { frequency, interval: 1 };
          addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, 'recurring', start, end, t('quickAdd.detected.recurring'), t(`todo.recurring.${frequency}`), 'recurring_rule');
        }
      }
    }

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

    const placeNames = placeNamePattern();
    if (placeNames) {
      const locationPrefixPattern = aliasPattern(prefixAliases.location);
      const locationDeparturePrefixPattern = aliasPattern(prefixAliases.locationDeparture);
      const locationRegexes = [];
      if (locationPrefixPattern) locationRegexes.push({
        triggerType: 'arrival',
        regex: new RegExp(`(^|\\s)(?:${locationPrefixPattern})\\s*:?\\s*(?<name>${placeNames})(?=$|\\s)`, 'giu'),
      });
      if (locationDeparturePrefixPattern) locationRegexes.push({
        triggerType: 'departure',
        regex: new RegExp(`(^|\\s)(?:${locationDeparturePrefixPattern})\\s*:?\\s*(?<name>${placeNames})(?=$|\\s)`, 'giu'),
      });
      for (const { triggerType, regex } of locationRegexes) {
        for (const match of original.matchAll(regex)) {
          const name = match.groups?.name;
          const valueOffset = match[0].lastIndexOf(name);
          const start = match.index + match[0].search(/\S/u);
          const end = match.index + valueOffset + name.length;
          const place = findPlaceByQuickAddName(name);
          if (!place) continue;
          changes.location_reminder = {
            trigger_type: triggerType,
            place_id: Number(place.id),
            place_name: place.name,
            address: place.address || '',
            enabled: true,
            source: 'quick_add',
          };
          const triggerLabel = t(triggerType === 'departure' ? 'todo.location.departureShort' : 'todo.location.arrivalShort');
          addTokenMatch(matches, matchIndexes, used, tokenSpans, tokens, 'location', start, end, t('quickAdd.detected.location'), `${triggerLabel}: ${place.name}`, 'location_reminder');
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


  return {
    nextWeekday,
    loadSectionsForQuickAdd,
    parseQuickAddTitle,
    renderQuickAddPreview,
    bindQuickAddPreview,
  };
}
