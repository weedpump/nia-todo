import { t } from '../i18n/index.js';
import { hydrateSelect, refreshSelect } from '../ui/dropdowns.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function isHouseholdOwnedEntity(entity) {
  return Boolean(entity?.owner_household_id != null || entity?.ownership_type === 'household');
}

export function renderEntityOwnershipField({ prefix, labelKey } = {}) {
  const safePrefix = escapeHtml(prefix || 'entity');
  const safeLabelKey = escapeHtml(labelKey || 'common.household');
  return `
    <div class="form-group entity-ownership-field" id="${safePrefix}-household-group" hidden>
      <label for="${safePrefix}-household-id" data-i18n-key="${safeLabelKey}">${escapeHtml(t(labelKey || 'common.household'))}</label>
      <select class="ui-field" id="${safePrefix}-household-id" data-ui-select></select>
      <div id="${safePrefix}-household-readonly" class="settings-readonly-value" hidden></div>
    </div>
  `;
}

export function createEntityOwnershipField({
  document: doc = globalThis.document,
  prefix,
  getHousehold = () => null,
  onChange = () => {},
} = {}) {
  const groupId = `${prefix}-household-group`;
  const selectId = `${prefix}-household-id`;
  const readonlyId = `${prefix}-household-readonly`;

  function elements() {
    return {
      group: doc?.getElementById?.(groupId) || null,
      select: doc?.getElementById?.(selectId) || null,
      readonly: doc?.getElementById?.(readonlyId) || null,
    };
  }

  function render(entity = null, { canManage = true } = {}) {
    const { group, select, readonly } = elements();
    if (!group || !select || !readonly) return false;
    const household = getHousehold?.() || null;
    if (!household) {
      group.hidden = true;
      select.innerHTML = '';
      select.value = '';
      readonly.hidden = true;
      return false;
    }

    const householdOwned = isHouseholdOwnedEntity(entity);
    const selectedHouseholdId = householdOwned
      ? String(entity?.owner_household_id ?? household.id)
      : '';
    const householdName = entity?.household_name || household.name || '';
    const mayChoose = !entity || (canManage === true && !householdOwned);
    const managerHouseholdView = householdOwned && canManage === true;

    group.hidden = Boolean(entity && canManage !== true && !householdOwned);
    select.innerHTML = `
      <option value="">${escapeHtml(t('entity.ownership.personal'))}</option>
      <option value="${escapeHtml(household.id)}">${escapeHtml(t('entity.ownership.household', { name: householdName }))}</option>
    `;
    select.value = selectedHouseholdId;
    select.disabled = !mayChoose;
    select.hidden = householdOwned && canManage !== true;
    select.setAttribute('aria-readonly', select.disabled ? 'true' : 'false');
    readonly.hidden = !householdOwned || canManage === true;
    readonly.textContent = householdOwned ? t('entity.ownership.household', { name: householdName }) : '';
    select.onchange = () => {
      refreshSelect(select);
      onChange(select.value || '');
    };
    const selectInstance = hydrateSelect(select);
    refreshSelect(select);
    if (selectInstance?.wrapper) selectInstance.wrapper.hidden = select.hidden;
    if (managerHouseholdView) select.disabled = true;
    return !group.hidden;
  }

  function value() {
    return elements().select?.value || '';
  }

  return { render, value };
}
