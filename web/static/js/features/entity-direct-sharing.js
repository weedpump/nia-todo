import { t } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { isHouseholdOwnedEntity } from './entity-ownership-field.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function defaultNormalizeMember(member) {
  if (!member) return null;
  const id = member.user_id ?? member.id;
  if (id == null) return null;
  return {
    ...member,
    id,
    user_id: id,
    username: member.username || '',
    display_name: member.display_name || null,
    status: member.status || 'accepted',
  };
}

function booleanFlag(value) {
  return value === true || value === 1 || value === '1';
}

export function renderEntityDirectSharingSection({ prefix, leaveKey } = {}) {
  const safePrefix = escapeHtml(prefix || 'entity');
  const safeLeaveKey = escapeHtml(leaveKey || 'project.share.leave');
  return `
    <section id="${safePrefix}-sharing-section" class="ui-section-card ui-detail-section ui-section-divider entity-sharing-card ui-detail-shell" hidden>
      <div class="ui-section-heading ui-detail-section-heading">
        <div class="ui-section-icon ui-detail-section-icon" data-icon="share-2"></div>
        <div>
          <h4 data-i18n-key="entity.share.sharedWith">${escapeHtml(t('entity.share.sharedWith'))}</h4>
          <p data-i18n-key="entity.share.hint">${escapeHtml(t('entity.share.hint'))}</p>
        </div>
      </div>
      <div id="${safePrefix}-owner-info" class="entity-sharing-owner-info" hidden><span class="entity-sharing-owner-label" data-i18n-key="entity.share.ownerLabel">${escapeHtml(t('entity.share.ownerLabel'))}</span><span class="entity-sharing-owner-name"></span></div>
      <div id="${safePrefix}-sharing-content" hidden>
        <div id="${safePrefix}-members-list" class="entity-sharing-members-list"></div>
        <div id="${safePrefix}-share-row" class="form-group entity-sharing-row">
          <label for="${safePrefix}-share-identifier" data-i18n-key="entity.share.addUser">${escapeHtml(t('entity.share.addUser'))}</label>
          <div class="entity-sharing-inline">
            <input id="${safePrefix}-share-identifier" type="text" class="ui-field" data-i18n-placeholder-key="entity.share.identifierPlaceholder" placeholder="${escapeHtml(t('entity.share.identifierPlaceholder'))}">
            <button type="button" class="btn btn-primary" data-entity-sharing-action="grant" data-i18n-key="entity.share.add">${escapeHtml(t('entity.share.add'))}</button>
          </div>
        </div>
      </div>
      <div id="${safePrefix}-share-error" class="form-error" role="alert"></div>
      <div id="${safePrefix}-share-start-row" class="entity-sharing-start-row ui-detail-action-row" hidden>
        <button type="button" class="btn btn-secondary" data-entity-sharing-action="show-share-input"><span data-icon="share-2"></span> <span data-i18n-key="entity.share.start">${escapeHtml(t('entity.share.start'))}</span></button>
      </div>
      <div id="${safePrefix}-leave-row" class="entity-sharing-start-row ui-detail-action-row" hidden>
        <button type="button" class="btn btn-secondary" data-entity-sharing-action="leave"><span data-i18n-key="${safeLeaveKey}">${escapeHtml(t(leaveKey || 'project.share.leave'))}</span></button>
      </div>
    </section>
  `;
}

export function createEntityDirectSharingFeature({
  document: doc = globalThis.document,
  prefix,
  listMembers = async () => [],
  grantMember = async () => null,
  revokeMember = async () => {},
  leaveEntity = async () => {},
  normalizeMember = defaultNormalizeMember,
  confirmDanger = async () => false,
  onMemberAdded = () => {},
  onMemberRemoved = () => {},
  onLeft = () => {},
  onError = () => {},
} = {}) {
  let entity = null;
  let members = [];
  let bound = false;
  let busy = false;
  let entityGeneration = 0;

  const id = suffix => `${prefix}-${suffix}`;
  const element = suffix => doc?.getElementById?.(id(suffix)) || null;

  function canManage() {
    return booleanFlag(entity?.can_manage) || booleanFlag(entity?.is_owner);
  }

  function isDirectRecipient() {
    return Boolean(entity && !isHouseholdOwnedEntity(entity) && booleanFlag(entity.is_shared) && !canManage());
  }

  function setError(message = '') {
    const target = element('share-error');
    if (target) target.textContent = message;
  }

  function normalizedMembers(values = []) {
    return values.map(normalizeMember).filter(Boolean);
  }

  function renderMembers() {
    const target = element('members-list');
    if (!target) return;
    target.innerHTML = members.map(member => {
      const name = member.display_name || member.username || '';
      const username = member.display_name && member.username && member.display_name !== member.username
        ? ` <span class="entity-sharing-display">(${escapeHtml(member.username)})</span>`
        : '';
      const pending = member.status === 'pending'
        ? `<span class="entity-sharing-pending">${escapeHtml(t('entity.share.pending'))}</span>`
        : '';
      const remove = canManage()
        ? `<button type="button" class="entity-sharing-remove" data-entity-sharing-action="revoke" data-member-id="${escapeHtml(member.id)}" title="${escapeHtml(t('entity.share.remove'))}" aria-label="${escapeHtml(t('entity.share.removeMember'))}">${iconSvg('x')}</button>`
        : '';
      return `
        <div class="entity-sharing-member-row">
          <div class="entity-sharing-member-main"><span class="entity-sharing-member-name">${escapeHtml(name)}</span>${username}${pending}</div>
          <div class="entity-sharing-actions">${remove}</div>
        </div>
      `;
    }).join('');
  }

  function renderState() {
    const section = element('sharing-section');
    const content = element('sharing-content');
    const start = element('share-start-row');
    const leave = element('leave-row');
    const owner = element('owner-info');
    if (!section || !content || !start || !leave || !owner) return;
    section.style?.removeProperty?.('display');
    const householdOwned = isHouseholdOwnedEntity(entity);
    section.hidden = !entity || householdOwned;
    if (!entity || householdOwned) {
      content.hidden = true;
      start.hidden = true;
      leave.hidden = true;
      owner.hidden = true;
      return;
    }
    const manager = canManage();
    const recipient = isDirectRecipient();
    const hasMembers = members.length > 0 || entity.has_sharing_activity === true;
    content.hidden = !manager || !hasMembers;
    start.hidden = !manager || hasMembers;
    leave.hidden = !recipient;
    owner.hidden = !recipient;
    if (recipient) {
      const ownerName = entity.owner_display_name || entity.owner_username || '';
      const ownerUsername = entity.owner_username && entity.owner_username !== ownerName ? ` (${entity.owner_username})` : '';
      const name = owner.querySelector?.('.entity-sharing-owner-name');
      if (name) name.textContent = `${ownerName}${ownerUsername}`;
    }
  }

  function showShareInput() {
    if (!canManage() || isHouseholdOwnedEntity(entity)) return false;
    element('sharing-content').hidden = false;
    element('share-start-row').hidden = true;
    setError();
    element('share-identifier')?.focus?.();
    return true;
  }

  async function setEntity(nextEntity) {
    const generation = ++entityGeneration;
    entity = nextEntity || null;
    members = [];
    setError();
    renderMembers();
    renderState();
    if (!entity || isHouseholdOwnedEntity(entity) || !canManage()) return;
    const result = await listMembers(entity.id);
    const values = Array.isArray(result) ? result : (result?.members || []);
    if (generation !== entityGeneration || entity !== nextEntity) return;
    members = normalizedMembers(values);
    renderMembers();
    renderState();
  }

  async function grant() {
    if (busy || !canManage() || isHouseholdOwnedEntity(entity)) return false;
    const input = element('share-identifier');
    const identifier = input?.value?.trim?.() || '';
    setError();
    if (!identifier) {
      setError(t('entity.share.identifierRequired'));
      input?.focus?.();
      return false;
    }
    const activeEntity = entity;
    const generation = entityGeneration;
    busy = true;
    try {
      const result = await grantMember(activeEntity.id, identifier);
      if (generation !== entityGeneration || entity !== activeEntity) return false;
      const member = normalizeMember(result?.member || result);
      if (!member) throw new Error('Share response did not include a member');
      members = members.filter(item => String(item.id) !== String(member.id)).concat(member);
      activeEntity.has_sharing_activity = true;
      if (input) input.value = '';
      renderMembers();
      renderState();
      onMemberAdded(member, activeEntity);
      return true;
    } catch (error) {
      if (generation !== entityGeneration || entity !== activeEntity) return false;
      const message = String(error?.message || '').toLowerCase();
      if (message.includes('404') || message.includes('not found')) setError(t('entity.share.notFound', { identifier }));
      else if (message.includes('403') || message.includes('forbidden')) setError(t('entity.share.forbidden'));
      else if (message.includes('already')) setError(t('entity.share.alreadyHasAccess', { identifier }));
      else setError(t('entity.share.failed', { error: error?.message || t('entity.share.unknownError') }));
      onError(error);
      return false;
    } finally {
      busy = false;
    }
  }

  async function revoke(memberId) {
    if (busy || !canManage() || isHouseholdOwnedEntity(entity)) return false;
    const member = members.find(item => String(item.id) === String(memberId));
    if (!member) return false;
    const activeEntity = entity;
    const generation = entityGeneration;
    const confirmed = await confirmDanger({
      title: t('entity.share.removeMember'),
      message: t('entity.share.removeMemberConfirm', { username: member.username || member.display_name || '' }),
      confirmText: t('entity.share.remove'),
    });
    if (!confirmed) return false;
    if (generation !== entityGeneration || entity !== activeEntity) return false;
    busy = true;
    try {
      await revokeMember(activeEntity.id, member.id);
      if (generation !== entityGeneration || entity !== activeEntity) return false;
      members = members.filter(item => String(item.id) !== String(member.id));
      renderMembers();
      renderState();
      onMemberRemoved(member, activeEntity);
      return true;
    } catch (error) {
      if (generation !== entityGeneration || entity !== activeEntity) return false;
      setError(t('entity.share.operationFailed'));
      onError(error);
      globalThis.setTimeout?.(() => {
        const escapedMemberId = globalThis.CSS?.escape?.(String(member.id)) || String(member.id);
        element('sharing-section')?.querySelector?.(`[data-entity-sharing-action="revoke"][data-member-id="${escapedMemberId}"]`)?.focus?.();
      }, 0);
      return false;
    } finally {
      busy = false;
    }
  }

  async function leave() {
    if (busy || !isDirectRecipient()) return false;
    const leaving = entity;
    const generation = entityGeneration;
    busy = true;
    try {
      await leaveEntity(leaving.id);
      if (generation !== entityGeneration || entity !== leaving) return false;
      onLeft(leaving);
      return true;
    } catch (error) {
      if (generation !== entityGeneration || entity !== leaving) return false;
      setError(t('entity.share.operationFailed'));
      onError(error);
      return false;
    } finally {
      busy = false;
    }
  }

  function handleClick(event) {
    const action = event.target?.closest?.('[data-entity-sharing-action]');
    if (!action || !action.closest?.(`#${id('sharing-section')}`)) return;
    event.preventDefault?.();
    const value = action.dataset.entitySharingAction;
    if (value === 'show-share-input') showShareInput();
    else if (value === 'grant') grant();
    else if (value === 'revoke') revoke(action.dataset.memberId);
    else if (value === 'leave') leave();
  }

  function bind() {
    if (bound) return;
    bound = true;
    doc?.addEventListener?.('click', handleClick);
  }

  return { bind, setEntity, showShareInput, grant, revoke, leave };
}
