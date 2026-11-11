import { escapeHtml, escapeHtmlAttr } from '../core/utils.js';
import { iconSvg, markerHtml } from '../icons/lucide-icons.js';
import { t } from '../i18n/index.js';

export function classifyEntityOwnership(entity) {
  if (entity?.ownership_type === 'household' || entity?.owner_household_id != null) return 'household';
  if (entity?.is_shared) return 'shared';
  return 'personal';
}

function renderAttributes(attributes = {}) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => `${escapeHtmlAttr(name)}="${escapeHtmlAttr(value)}"`)
    .join(' ');
}

export function renderEntitySidebarRow({
  entity,
  entityType,
  active = false,
  count = 0,
  depth = 0,
  rowClass = '',
  selectClass = '',
  selectAttributes = {},
  detailAttributes = {},
} = {}) {
  if (!entity || !entityType) return '';
  const id = String(entity.id ?? '');
  const name = String(entity.name ?? '');
  const indent = Math.max(0, Number(depth) || 0) * 16;
  const extraRowClass = rowClass ? ` ${escapeHtmlAttr(rowClass)}` : '';
  const extraSelectClass = selectClass ? ` ${escapeHtmlAttr(selectClass)}` : '';
  const attributes = renderAttributes(selectAttributes);
  const detailData = renderAttributes(detailAttributes);
  const detailLabel = t('common.openDetailsFor', { name });

  return `<div class="entity-sidebar-item${extraRowClass}" style="padding-left: ${indent}px">
    <div class="nav-item-with-action">
      <button class="nav-btn ui-nav-pill entity-sidebar-select${extraSelectClass}${active ? ' active' : ''}" data-entity-sidebar-action="select" data-entity-type="${escapeHtmlAttr(entityType)}" data-entity-id="${escapeHtmlAttr(id)}" ${attributes} aria-label="${escapeHtmlAttr(name)}" title="${escapeHtmlAttr(name)}"${active ? ' aria-current="page"' : ''}>
        ${markerHtml({ ...entity, color: entity.color || '#6366f1', icon: entity.icon })}
        <span class="nav-label">${escapeHtml(name)}</span>
        <span class="badge">${escapeHtml(String(Math.max(0, Number(count) || 0)))}</span>
      </button>
      <button class="nav-edit entity-sidebar-detail" data-entity-sidebar-action="detail" data-entity-type="${escapeHtmlAttr(entityType)}" data-entity-id="${escapeHtmlAttr(id)}" ${detailData} title="${escapeHtmlAttr(detailLabel)}" aria-label="${escapeHtmlAttr(detailLabel)}">
        ${iconSvg('edit-3')}
      </button>
    </div>
  </div>`;
}

export function renderEntitySidebarSection({
  section,
  title,
  icon = '',
  rows = '',
  titleClass = '',
  sectionAttributes = {},
} = {}) {
  if (!section) return '';
  const householdClass = section === 'household' ? ' household-title' : '';
  const extraTitleClass = titleClass ? ` ${escapeHtmlAttr(titleClass)}` : '';
  const titleMarkup = title
    ? `<div class="nav-title shared-title${householdClass} entity-sidebar-section-title${extraTitleClass}">${icon ? iconSvg(icon) : ''}<span>${escapeHtml(title)}</span></div>`
    : '';
  const attributes = renderAttributes(sectionAttributes);
  return `<div class="entity-sidebar-section" data-entity-section="${escapeHtmlAttr(section)}" ${attributes}>${titleMarkup}${rows}</div>`;
}

export function renderEntitySidebarAddRow({ entityType, label, labelKey = '' } = {}) {
  if (!entityType) return '';
  const i18nLabel = labelKey ? ` data-i18n-key="${escapeHtmlAttr(labelKey)}"` : '';
  const i18nAria = labelKey ? ` data-i18n-aria-label-key="${escapeHtmlAttr(labelKey)}" data-i18n-title-key="${escapeHtmlAttr(labelKey)}"` : '';
  return `<div class="entity-sidebar-item entity-sidebar-add-item">
    <div class="nav-item-with-action">
      <button class="nav-btn ui-nav-pill add-btn entity-sidebar-add" data-entity-sidebar-action="add" data-entity-type="${escapeHtmlAttr(entityType)}" aria-label="${escapeHtmlAttr(label || '')}" title="${escapeHtmlAttr(label || '')}"${i18nAria}>
        <span class="entity-icon entity-sidebar-add-icon" data-icon="plus"></span><span${i18nLabel}>${escapeHtml(label || '')}</span>
      </button>
    </div>
  </div>`;
}

export function bindEntitySidebarNavigation({
  root = document,
  entityType,
  onSelect,
  onDetail,
  onAdd,
  closeSidebar,
} = {}) {
  function handleClick(event) {
    const target = event.target?.closest?.('[data-entity-sidebar-action]');
    if (!target || target.dataset.entityType !== entityType) return;
    const action = target.dataset.entitySidebarAction;
    const id = target.dataset.entityId;
    event.preventDefault();
    if (action === 'detail') event.stopPropagation();

    if (!['select', 'detail', 'add'].includes(action)) return;
    const sidebarClosed = Boolean(closeSidebar?.({ preserveHistory: true }));
    const context = { sidebarClosed };
    if (action === 'select') onSelect?.(id, context);
    else if (action === 'detail') onDetail?.(id, context);
    else onAdd?.(context);
  }

  root?.addEventListener?.('click', handleClick);
  return {
    destroy() {
      root?.removeEventListener?.('click', handleClick);
    },
  };
}
