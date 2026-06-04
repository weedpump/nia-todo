import { iconSvg } from '../icons/lucide-icons.js';

const registry = new WeakMap();
let openState = null;
let nextId = 1;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function optionLabel(option) {
  return option?.textContent?.trim().replace(/^└─\s*/, '') || option?.label || option?.value || '';
}

function normalizeSearch(value) {
  return String(value || '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function optionMarker(option) {
  if (!option?.dataset) return '';
  if (option.dataset.projectColor || option.dataset.projectIcon) {
    const color = escapeHtml(option.dataset.projectColor || '#6366f1');
    const icon = String(option.dataset.projectIcon || '').trim();
    if (icon) {
      return `<span class="ui-select-project-marker entity-icon" style="color:${color}">${iconSvg(icon)}</span>`;
    }
    return `<span class="ui-select-project-dot project-dot" style="background:${color}"></span>`;
  }
  if (option.dataset.optionIcon) {
    const color = escapeHtml(option.dataset.optionColor || 'currentColor');
    return `<span class="ui-select-option-marker ui-select-option-icon" style="color:${color}">${iconSvg(option.dataset.optionIcon)}</span>`;
  }
  if (option.dataset.optionColor) {
    const color = escapeHtml(option.dataset.optionColor);
    return `<span class="ui-select-option-marker ui-select-option-dot" style="background:${color};color:${color}"></span>`;
  }
  return '';
}

function optionDepth(option) {
  const explicit = Number.parseInt(option?.dataset?.depth || '', 10);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);
  const text = option?.textContent || '';
  const nbspCount = (text.match(/^\u00A0+/)?.[0]?.length || 0);
  return Math.max(0, Math.floor(nbspCount / 2));
}

function visibleOptions(select) {
  return Array.from(select?.options || []).filter(option => !option.hidden);
}

function selectedOption(select) {
  return visibleOptions(select).find(option => option.value === select.value) || visibleOptions(select)[0] || null;
}

function isSearchable(instance) {
  if (instance?.options?.searchable === true) return true;
  const className = `${instance?.options?.className || ''} ${instance?.options?.menuClassName || ''}`;
  if (className.includes('project-ui-select')) return true;
  return visibleOptions(instance?.select).some(option => option.dataset?.projectColor || option.dataset?.projectIcon);
}

function setNativeValue(select, value, { dispatch = true } = {}) {
  if (!select) return;
  const previous = select.value;
  select.value = value;
  if (dispatch && previous !== select.value) {
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function optionId(instance, index) {
  return `${instance.id}-option-${index}`;
}

function renderValue(instance) {
  const selected = selectedOption(instance.select);
  const label = selected ? optionLabel(selected) : (instance.options.placeholder || '—');
  const marker = optionMarker(selected);
  if (marker) {
    instance.value.innerHTML = `${marker}<span class="ui-select-value-label">${escapeHtml(label)}</span>`;
  } else {
    instance.value.textContent = label;
  }
  instance.trigger.title = label;
  instance.trigger.classList.toggle('is-placeholder', !selected || selected.value === '');
}

function selectLabelElement(select) {
  if (!select) return null;
  if (select.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
    if (explicit) return explicit;
  }
  return select.closest('.form-group')?.querySelector('label') || null;
}

function ensureElementId(element, prefix) {
  if (!element) return '';
  if (!element.id) element.id = `${prefix}-${nextId++}`;
  return element.id;
}

function applySearchFilter(instance) {
  const term = normalizeSearch(instance.searchTerm || '');
  const rows = Array.from(instance.menu.querySelectorAll('.ui-select-option'));
  let visibleCount = 0;
  rows.forEach(row => {
    const matches = !term || normalizeSearch(row.dataset.label || '').includes(term);
    row.hidden = !matches;
    if (matches) visibleCount += 1;
  });
  const empty = instance.menu.querySelector('.ui-select-empty');
  if (empty) empty.hidden = visibleCount > 0;
  const highlighted = highlightedOption(instance);
  if (!highlighted || highlighted.hidden || highlighted.disabled) {
    const first = rows.find(row => !row.hidden && !row.disabled);
    if (first) highlightIndex(instance, Number(first.dataset.index));
  }
}

function renderSearch(instance) {
  if (!isSearchable(instance)) return;
  const searchWrap = document.createElement('div');
  searchWrap.className = 'ui-select-search';
  searchWrap.innerHTML = `<span class="ui-select-search-icon" aria-hidden="true">${iconSvg('search')}</span>`;
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'ui-select-search-input';
  input.value = instance.searchTerm || '';
  input.placeholder = instance.options.searchPlaceholder || 'Projekte suchen';
  input.setAttribute('aria-label', instance.options.searchLabel || input.placeholder);
  input.addEventListener('input', () => {
    instance.searchTerm = input.value;
    applySearchFilter(instance);
    positionDropdown(instance.trigger, instance.menu);
  });
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
      onMenuKeydown(event);
    }
  });
  searchWrap.appendChild(input);
  instance.menu.appendChild(searchWrap);
}

function renderMenu(instance) {
  instance.menu.innerHTML = '';
  renderSearch(instance);
  const options = visibleOptions(instance.select);
  options.forEach((option, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.id = optionId(instance, index);
    row.className = 'ui-select-option';
    row.setAttribute('role', 'option');
    row.dataset.value = option.value;
    row.dataset.index = String(index);
    row.dataset.depth = String(optionDepth(option));
    row.dataset.label = optionLabel(option);
    row.style.setProperty('--ui-select-depth', row.dataset.depth);
    row.disabled = option.disabled;
    row.setAttribute('aria-selected', option.value === instance.select.value ? 'true' : 'false');
    if (option.disabled) row.setAttribute('aria-disabled', 'true');
    const marker = optionMarker(option);
    row.classList.toggle('has-project-marker', Boolean(option.dataset?.projectColor || option.dataset?.projectIcon));
    row.classList.toggle('has-option-marker', Boolean(marker));
    row.innerHTML = `<span class="ui-select-option-branch" aria-hidden="true"></span>${marker}<span class="ui-select-option-label">${escapeHtml(optionLabel(option))}</span><span class="ui-select-option-check" aria-hidden="true">${iconSvg('check')}</span>`;
    row.addEventListener('click', () => {
      if (option.disabled) return;
      chooseIndex(instance, index);
    });
    row.addEventListener('mouseenter', () => highlightIndex(instance, index));
    instance.menu.appendChild(row);
  });
  if (isSearchable(instance)) {
    const empty = document.createElement('div');
    empty.className = 'ui-select-empty';
    empty.hidden = true;
    empty.textContent = instance.options.emptyText || 'Keine Projekte gefunden';
    instance.menu.appendChild(empty);
    applySearchFilter(instance);
  }
}

function positionDropdown(trigger, menu) {
  const rect = trigger.getBoundingClientRect();
  const edge = 12;
  const isMobile = window.matchMedia?.('(max-width: 768px)')?.matches;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const modalActions = trigger.closest?.('#braindump-modal')?.querySelector?.('.braindump-actions');
  const boundaryBottom = modalActions ? Math.max(edge * 2, modalActions.getBoundingClientRect().top - edge) : viewportHeight;
  const minWidth = rect.width;
  const maxWidth = isMobile ? viewportWidth - edge * 2 : Math.min(280, viewportWidth - edge * 2);

  menu.classList.toggle('is-mobile-popover', Boolean(isMobile));
  menu.classList.remove('is-mobile-sheet');
  menu.style.visibility = 'hidden';
  menu.style.display = 'block';
  menu.style.minWidth = `${Math.max(minWidth, 160)}px`;
  menu.style.maxWidth = `${maxWidth}px`;
  menu.style.maxHeight = isMobile ? `min(280px, calc(45vh))` : `min(320px, ${Math.max(120, boundaryBottom - edge * 2)}px)`;

  const menuRect = menu.getBoundingClientRect();
  const width = Math.min(Math.max(menuRect.width, minWidth, 160), maxWidth);
  const spaceBelow = boundaryBottom - rect.bottom - edge;
  const spaceAbove = rect.top - edge;
  const preferredHeight = Math.min(menuRect.height, isMobile ? Math.min(280, viewportHeight * 0.45) : 320);
  const openAbove = spaceBelow < Math.min(preferredHeight, 180) && spaceAbove > spaceBelow;
  const availableHeight = Math.max(120, openAbove ? spaceAbove - 6 : spaceBelow - 6);
  const height = Math.min(preferredHeight, availableHeight);
  const top = openAbove
    ? Math.max(edge, rect.top - height - 6)
    : Math.min(boundaryBottom - height, rect.bottom + 6);
  const left = Math.min(Math.max(edge, rect.left), viewportWidth - edge - width);

  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${height}px`;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(edge, top)}px`;
  menu.style.visibility = '';
  menu.classList.toggle('opens-above', openAbove);
}

function highlightedOption(instance) {
  return instance.menu.querySelector('.ui-select-option.is-highlighted:not([hidden])');
}

function menuOptionRows(instance) {
  return Array.from(instance.menu.querySelectorAll('.ui-select-option')).filter(row => !row.hidden);
}

function highlightIndex(instance, index) {
  const options = Array.from(instance.menu.querySelectorAll('.ui-select-option'));
  options.forEach(option => option.classList.remove('is-highlighted'));
  const target = options.find(option => Number(option.dataset.index) === Number(index) && !option.hidden);
  if (!target || target.disabled) return;
  target.classList.add('is-highlighted');
  instance.trigger.setAttribute('aria-activedescendant', target.id);
  target.scrollIntoView({ block: 'nearest' });
}

function firstEnabledIndex(instance, start = 0, direction = 1) {
  if (openState?.instance === instance) {
    const rows = menuOptionRows(instance).filter(row => !row.disabled);
    if (!rows.length) return -1;
    const currentPosition = rows.findIndex(row => Number(row.dataset.index) === Number(start));
    if (currentPosition >= 0) return Number(rows[currentPosition].dataset.index);
    const ordered = rows.map(row => Number(row.dataset.index));
    if (direction > 0) return ordered.find(index => index >= start) ?? ordered[0];
    return [...ordered].reverse().find(index => index <= start) ?? ordered[ordered.length - 1];
  }
  const options = visibleOptions(instance.select);
  if (!options.length) return -1;
  for (let step = 0; step < options.length; step += 1) {
    const index = (start + step * direction + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}

function selectedIndex(instance) {
  const options = visibleOptions(instance.select);
  const index = options.findIndex(option => option.value === instance.select.value);
  return index >= 0 ? index : firstEnabledIndex(instance);
}

function chooseIndex(instance, index) {
  const option = visibleOptions(instance.select)[index];
  if (!option || option.disabled) return;
  setNativeValue(instance.select, option.value);
  refreshSelect(instance.select);
  closeOpenDropdown('select');
  instance.trigger.focus();
}

function openDropdown(instance) {
  if (!instance || instance.select.disabled) return;
  if (openState?.instance === instance) {
    closeOpenDropdown('toggle');
    return;
  }
  closeOpenDropdown('open-another');
  instance.searchTerm = '';
  renderMenu(instance);
  document.body.appendChild(instance.menu);
  instance.trigger.setAttribute('aria-expanded', 'true');
  instance.wrapper.classList.add('is-open');
  instance.menu.hidden = false;
  positionDropdown(instance.trigger, instance.menu);
  const index = selectedIndex(instance);
  if (index >= 0) highlightIndex(instance, index);
  openState = { instance };
  if (isSearchable(instance)) {
    window.setTimeout(() => instance.menu.querySelector('.ui-select-search-input')?.focus(), 0);
  }
}

export function closeOpenDropdown(reason = 'programmatic') {
  if (!openState) return;
  const { instance } = openState;
  instance.trigger.setAttribute('aria-expanded', 'false');
  instance.trigger.removeAttribute('aria-activedescendant');
  instance.wrapper.classList.remove('is-open');
  instance.menu.hidden = true;
  instance.menu.remove();
  openState = null;
}

function onTriggerKeydown(instance, event) {
  const isOpen = openState?.instance === instance;
  if ((event.key === 'Enter' || event.key === ' ') && isOpen) {
    event.preventDefault();
    const target = highlightedOption(instance);
    if (target) chooseIndex(instance, Number(target.dataset.index));
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openDropdown(instance);
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!isOpen) openDropdown(instance);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const current = highlightedOption(instance);
    const currentIndex = current ? Number(current.dataset.index) : selectedIndex(instance);
    const index = firstEnabledIndex(instance, currentIndex + direction, direction);
    if (index >= 0) highlightIndex(instance, index);
  }
}

function onMenuKeydown(event) {
  if (!openState) return;
  const instance = openState.instance;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeOpenDropdown('escape');
    instance.trigger.focus();
    return;
  }
  if (event.key === 'Tab') {
    closeOpenDropdown('tab');
    return;
  }
  const options = Array.from(instance.menu.querySelectorAll('.ui-select-option'));
  const current = highlightedOption(instance);
  const currentIndex = current ? Number(current.dataset.index) : selectedIndex(instance);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const index = firstEnabledIndex(instance, currentIndex + direction, direction);
    if (index >= 0) highlightIndex(instance, index);
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const target = highlightedOption(instance);
    if (target) chooseIndex(instance, Number(target.dataset.index));
  }
}

function bindGlobalListeners() {
  if (document.documentElement.dataset.uiDropdownsBound === '1') return;
  document.documentElement.dataset.uiDropdownsBound = '1';
  document.addEventListener('pointerdown', (event) => {
    if (!openState) return;
    const { instance } = openState;
    if (instance.wrapper.contains(event.target) || instance.menu.contains(event.target)) return;
    closeOpenDropdown('outside');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openState) {
      const trigger = openState.instance.trigger;
      closeOpenDropdown('escape');
      trigger.focus();
    }
  });
  window.addEventListener('resize', () => openState && positionDropdown(openState.instance.trigger, openState.instance.menu));
  window.addEventListener('orientationchange', () => openState && positionDropdown(openState.instance.trigger, openState.instance.menu));
  document.addEventListener('scroll', (event) => {
    if (!openState) return;
    const { instance } = openState;
    // The dropdown menu is itself scrollable. Repositioning it while its own
    // scroll gesture is active can fight Android WebView's touch scrolling and
    // make long option lists jitter.
    if (event.target === instance.menu || instance.menu.contains(event.target)) return;
    positionDropdown(instance.trigger, instance.menu);
  }, true);
}

export function hydrateSelect(select, options = {}) {
  if (!select) return null;
  bindGlobalListeners();
  const existing = registry.get(select);
  if (existing) {
    existing.options = { ...existing.options, ...options };
    refreshSelect(select);
    return existing;
  }

  const id = select.id || `ui-select-${nextId++}`;
  if (!select.id) select.id = id;
  select.classList.add('visually-hidden-native-select');
  select.dataset.uiSelectHydrated = 'true';
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const wrapper = document.createElement('div');
  wrapper.className = `ui-select ${options.className || ''}`.trim();
  wrapper.dataset.selectId = select.id;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ui-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const value = document.createElement('span');
  value.id = `${select.id}-ui-value`;
  value.className = 'ui-select-value';
  const chevron = document.createElement('span');
  chevron.className = 'ui-select-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  trigger.append(value, chevron);

  const menu = document.createElement('div');
  menu.id = `${select.id}-ui-menu`;
  menu.className = `ui-select-menu ${options.menuClassName || ''}`.trim();
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  menu.addEventListener('keydown', onMenuKeydown);
  trigger.setAttribute('aria-controls', menu.id);

  const label = selectLabelElement(select);
  const labelId = ensureElementId(label, `${select.id}-label`);
  if (labelId) {
    trigger.setAttribute('aria-labelledby', `${labelId} ${value.id}`);
    menu.setAttribute('aria-labelledby', labelId);
  } else {
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || select.name || select.id);
  }

  wrapper.append(trigger);
  select.insertAdjacentElement('afterend', wrapper);

  const instance = { id: select.id, select, wrapper, trigger, value, chevron, menu, options };
  registry.set(select, instance);

  trigger.addEventListener('click', () => openDropdown(instance));
  trigger.addEventListener('keydown', (event) => onTriggerKeydown(instance, event));
  select.addEventListener('focus', () => trigger.focus());
  select.addEventListener('change', () => refreshSelect(select));

  refreshSelect(select);
  return instance;
}

export function refreshSelect(select) {
  const instance = registry.get(select);
  if (!instance) return null;
  renderValue(instance);
  instance.wrapper.classList.toggle('is-disabled', select.disabled);
  instance.trigger.disabled = select.disabled;
  instance.trigger.setAttribute('aria-disabled', select.disabled ? 'true' : 'false');
  if (openState?.instance === instance) {
    renderMenu(instance);
    positionDropdown(instance.trigger, instance.menu);
  }
  return instance;
}

export function hydrateSelects(root = document, selector = 'select[data-ui-select]') {
  return Array.from(root.querySelectorAll(selector)).map(select => hydrateSelect(select));
}
