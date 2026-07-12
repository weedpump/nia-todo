// Central Lucide icon helper. Icon path data is generated from the lucide npm package
// into lucide-generated.js for offline/PWA use. Icons render with currentColor.

import { t } from '../i18n/index.js';
import { ICONS, LUCIDE_VERSION } from './lucide-generated.js';

export { ICONS, LUCIDE_VERSION };

const LEGACY_ICON_ALIASES = {
  'plus-square': 'plus-square',
  trash: 'trash',
};

export const ICON_PICKER_CATEGORIES = [
  {
    labelKey: 'iconPicker.category.everyday',
    icons: ['home', 'inbox', 'shopping-cart', 'shopping-bag', 'store', 'calendar', 'calendar-days', 'clock', 'alarm-clock', 'bell', 'heart', 'star', 'gift', 'coffee', 'utensils', 'chef-hat', 'sofa', 'bed', 'bath'],
  },
  {
    labelKey: 'iconPicker.category.workTech',
    icons: ['briefcase', 'building', 'building-2', 'warehouse', 'factory', 'folder', 'file-text', 'book-open', 'notebook-pen', 'newspaper', 'presentation', 'code', 'terminal', 'server', 'database', 'cloud', 'network', 'wifi', 'laptop', 'monitor', 'tablet', 'smartphone', 'cpu', 'hard-drive', 'keyboard', 'bot', 'brain'],
  },
  {
    labelKey: 'iconPicker.category.organization',
    icons: ['layout-dashboard', 'chart-line', 'chart-bar', 'chart-column', 'target', 'tag', 'bookmark', 'flag', 'map', 'map-pin', 'map-pinned', 'route', 'archive', 'package', 'clipboard', 'list-todo', 'download', 'upload', 'share-2', 'link', 'image', 'camera'],
  },
  {
    labelKey: 'iconPicker.category.financeEducation',
    icons: ['wallet', 'banknote', 'piggy-bank', 'circle-dollar-sign', 'landmark', 'graduation-cap', 'school', 'languages', 'award', 'crown'],
  },
  {
    labelKey: 'iconPicker.category.peopleHealth',
    icons: ['users', 'user', 'user-plus', 'person-standing', 'accessibility', 'venus', 'mars', 'venus-and-mars', 'smile', 'handshake', 'heart-handshake', 'hand-heart', 'hand-helping', 'message-circle', 'mail', 'phone', 'hospital', 'stethoscope', 'heart-pulse', 'life-buoy', 'dumbbell', 'baby'],
  },
  {
    labelKey: 'iconPicker.category.placesNature',
    icons: ['church', 'cross', 'house-heart', 'house-plus', 'flower', 'flower-2', 'trees', 'tree-pine', 'tree-deciduous', 'leaf', 'sprout', 'shrub', 'fence', 'land-plot', 'mountain', 'waves', 'bird', 'cat', 'dog', 'rabbit', 'turtle', 'squirrel', 'snail', 'worm', 'paw-print'],
  },
  {
    labelKey: 'iconPicker.category.mediaCreative',
    icons: ['palette', 'paintbrush', 'pen-tool', 'pencil', 'music', 'headphones', 'radio', 'podcast', 'film', 'clapperboard', 'tv', 'gamepad-2', 'ticket', 'drama'],
  },
  {
    labelKey: 'iconPicker.category.statusSecurity',
    icons: ['check-circle', 'check', 'flame', 'triangle-alert', 'shield', 'shield-check', 'lock-keyhole', 'key-round', 'fingerprint', 'ban', 'circle', 'battery', 'zap'],
  },
  {
    labelKey: 'iconPicker.category.toolsMovement',
    icons: ['settings', 'wrench', 'hammer', 'bug', 'shovel', 'axe', 'pickaxe', 'scissors', 'spray-can', 'plug', 'cable', 'rocket', 'car', 'bike', 'bus', 'train', 'truck', 'tractor', 'ship', 'plane', 'ambulance', 'tent', 'volleyball'],
  },
  {
    labelKey: 'iconPicker.category.system',
    icons: ['sun', 'moon', 'globe', 'earth', 'search', 'menu', 'plus', 'edit-3', 'trash-2', 'refresh-cw', 'arrow-left', 'log-out', 'x'],
  },
];

export const ICON_PICKER = ICON_PICKER_CATEGORIES.flatMap(category => category.icons);

export function safeColor(value, fallback = '#6366f1') {
  const color = String(value || '').trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) return fallback;
  if (color.length === 4) {
    return `#${color.slice(1).split('').map(ch => ch + ch).join('')}`.toLowerCase();
  }
  return color.toLowerCase();
}

export function safeIconName(name) {
  const iconName = LEGACY_ICON_ALIASES[name] || name;
  return Object.prototype.hasOwnProperty.call(ICONS, iconName) ? iconName : '';
}

export function iconSvg(name, className = 'ui-icon', attrs = '') {
  const paths = ICONS[safeIconName(name)] || ICONS.circle;
  return `<svg class="${className}" ${attrs} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const icon = el.getAttribute('data-icon');
    const cls = el.getAttribute('data-icon-class') || 'ui-icon';
    el.innerHTML = iconSvg(icon, cls);
  });
}

export function markerHtml(item, dotClass = 'project-dot') {
  const color = safeColor(item?.color);
  const icon = safeIconName(item?.icon);
  if (icon) {
    return `<span class="entity-icon" style="color:${color}">${iconSvg(icon)}</span>`;
  }
  return `<span class="${dotClass}" style="background:${color}"></span>`;
}

function currentIconPreview(icon, color) {
  if (icon) return `<span class="icon-picker-current-preview" style="color:${color}">${iconSvg(icon)}</span>`;
  return `<span class="icon-picker-current-preview"><span class="icon-picker-dot" style="background:${color}"></span></span>`;
}

function humanizeIconName(icon) {
  return String(icon || '')
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function escapeHtmlAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function iconLabel(icon) {
  if (!icon) return t('iconPicker.none');
  const key = `iconPicker.icon.${icon}`;
  const value = t(key);
  return value === key ? humanizeIconName(icon) : value;
}

function iconSearchText(icon) {
  const label = iconLabel(icon);
  const searchKey = `iconPicker.iconSearch.${icon}`;
  const searchValue = t(searchKey);
  return [
    icon,
    icon.replace(/-/g, ' '),
    label,
    searchValue === searchKey ? '' : searchValue,
  ].join(' ').toLowerCase();
}

function currentIconLabel(icon) {
  return icon ? iconLabel(icon) : t('iconPicker.none');
}

export function renderIconPicker({ container, input, selected = '', color = '#6366f1' }) {
  if (!container || !input) return;
  const safeSelected = safeIconName(selected);
  const safePickerColor = safeColor(color);
  input.value = safeSelected;
  container.innerHTML = `
    <button type="button" class="ui-field icon-picker-current" aria-expanded="false">
      ${currentIconPreview(safeSelected, safePickerColor)}
      <span class="icon-picker-current-text">
        <span class="icon-picker-current-label">${t('iconPicker.selected')}</span>
        <span class="icon-picker-current-name">${currentIconLabel(safeSelected)}</span>
      </span>
      <svg class="icon-picker-current-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="ui-dropdown-panel icon-picker-panel" hidden>
      <div class="icon-picker-toolbar">
        <input class="ui-field icon-picker-search" type="search" placeholder="${t('iconPicker.searchPlaceholder')}" aria-label="${t('iconPicker.searchAria')}">
      </div>
      <div class="icon-picker-sections">
        <section class="icon-picker-section" data-category="none">
          <div class="icon-picker-category-title">${t('iconPicker.noneCategory')}</div>
          <div class="icon-picker-grid">
            <button type="button" class="btn btn-secondary btn-icon icon-picker-option ${!safeSelected ? 'is-selected' : ''}" data-value="" data-search="${t('iconPicker.noneSearch')}" title="${t('iconPicker.none')}" aria-selected="${!safeSelected ? 'true' : 'false'}">
              <span class="icon-picker-dot" style="background:${safePickerColor}"></span>
            </button>
          </div>
        </section>
        ${ICON_PICKER_CATEGORIES.map(category => {
          const categoryLabel = t(category.labelKey);
          return `
          <section class="icon-picker-section" data-category="${category.labelKey}">
            <div class="icon-picker-category-title">${categoryLabel}</div>
            <div class="icon-picker-grid">
              ${category.icons.map(name => {
                const label = iconLabel(name);
                const searchText = iconSearchText(name);
                return `
                <button type="button" class="btn btn-secondary btn-icon icon-picker-option ${safeSelected === name ? 'is-selected' : ''}" data-value="${escapeHtmlAttr(name)}" data-search="${escapeHtmlAttr(searchText)}" title="${escapeHtmlAttr(label)}" aria-label="${escapeHtmlAttr(label)}" style="color:${safePickerColor}" aria-selected="${safeSelected === name ? 'true' : 'false'}">
                  ${iconSvg(name)}
                </button>
              `;
              }).join('')}
            </div>
          </section>
        `;
        }).join('')}
      </div>
    </div>
  `;

  const currentButton = container.querySelector('.icon-picker-current');
  const currentName = container.querySelector('.icon-picker-current-name');
  const panel = container.querySelector('.icon-picker-panel');
  const search = container.querySelector('.icon-picker-search');
  const options = Array.from(container.querySelectorAll('.icon-picker-option'));

  function setExpanded(expanded) {
    panel.hidden = !expanded;
    currentButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function updateCurrent(value) {
    const icon = safeIconName(value);
    input.value = icon;
    const currentPreview = container.querySelector('.icon-picker-current-preview');
    if (currentPreview) currentPreview.outerHTML = currentIconPreview(icon, safePickerColor);
    if (currentName) currentName.textContent = currentIconLabel(icon);
    options.forEach(btn => {
      const selected = (btn.dataset.value || '') === icon;
      btn.classList.toggle('is-selected', selected);
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }

  currentButton?.addEventListener('click', () => {
    const expanded = currentButton.getAttribute('aria-expanded') === 'true';
    setExpanded(!expanded);
    if (!expanded) search?.focus();
  });

  options.forEach((button) => {
    button.addEventListener('click', () => {
      updateCurrent(button.dataset.value || '');
      setExpanded(false);
    });
  });

  search?.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    container.querySelectorAll('.icon-picker-section').forEach((section) => {
      let visibleCount = 0;
      section.querySelectorAll('.icon-picker-option').forEach((button) => {
        const match = !query || (button.dataset.search || '').includes(query);
        button.hidden = !match;
        if (match) visibleCount += 1;
      });
      section.hidden = visibleCount === 0;
    });
  });
}
