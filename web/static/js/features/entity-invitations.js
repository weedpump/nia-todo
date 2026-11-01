import { escapeHtmlAttr } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { t } from '../i18n/index.js';

const escapeHtml = escapeHtmlAttr;

function invitationKey(value) {
  return String(value ?? '');
}

function normalizedInvitations(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.invitations)) return value.invitations;
  if (Array.isArray(value?.invites)) return value.invites;
  return [];
}

export function renderEntityInvitationRows({
  entityType,
  invitations = [],
  busyIds = [],
  errors = {},
  translate = t,
  renderIcon = iconSvg,
} = {}) {
  const busy = new Set(busyIds.map(invitationKey));
  return invitations.map(invitation => {
    const id = invitationKey(invitation.id);
    const entityId = invitation.entityId ?? invitation.entity_id;
    const name = invitation.name ?? invitation.entityName ?? invitation.entity_name ?? '';
    const isBusy = busy.has(id);
    const errorKey = errors[id] || '';
    return `
      <div class="invite-item entity-invitation-item${isBusy ? ' is-busy' : ''}" data-entity-invitation-id="${escapeHtmlAttr(id)}">
        <span class="invite-title entity-invitation-title">${renderIcon('mail')} ${escapeHtml(name)}</span>
        <div class="invite-actions entity-invitation-actions">
          <button type="button" class="btn btn-secondary btn-icon invite-action invite-accept" data-entity-invitation-action="accept" data-entity-type="${escapeHtmlAttr(entityType)}" data-entity-id="${escapeHtmlAttr(entityId)}" data-invitation-id="${escapeHtmlAttr(id)}" title="${escapeHtmlAttr(translate('invite.accept'))}" aria-label="${escapeHtmlAttr(translate('invite.acceptAria', { name }))}" ${isBusy ? 'disabled aria-busy="true"' : ''}>${renderIcon('check')}</button>
          <button type="button" class="btn btn-danger btn-icon invite-action invite-decline" data-entity-invitation-action="decline" data-entity-type="${escapeHtmlAttr(entityType)}" data-entity-id="${escapeHtmlAttr(entityId)}" data-invitation-id="${escapeHtmlAttr(id)}" title="${escapeHtmlAttr(translate('invite.decline'))}" aria-label="${escapeHtmlAttr(translate('invite.declineAria', { name }))}" ${isBusy ? 'disabled aria-busy="true"' : ''}>${renderIcon('x')}</button>
        </div>
        <div class="entity-invitation-error" role="status" ${errorKey ? '' : 'hidden'}>${errorKey ? escapeHtml(translate(errorKey)) : ''}</div>
      </div>`;
  }).join('');
}

export function renderEntityInvitationsHost({
  document: doc = globalThis.document,
  sectionId,
  listId,
  entityType,
  state,
} = {}) {
  const section = doc?.getElementById?.(sectionId);
  const list = doc?.getElementById?.(listId);
  if (!section || !list) return false;
  const invitations = state?.invitations || [];
  section.hidden = invitations.length === 0;
  list.innerHTML = invitations.length ? renderEntityInvitationRows({
    entityType,
    invitations,
    busyIds: state?.busyIds || [],
    errors: state?.errors || {},
  }) : '';
  return true;
}

export function createEntityInvitationsFeature({
  entityType,
  listInvitations = async () => [],
  respondInvitation,
  loadAuthoritativeProjection = async () => null,
  applyAuthoritativeProjection = () => {},
  normalizeInvitation = invitation => invitation,
  isOnline = () => globalThis.navigator?.onLine !== false,
  onProjectionError = () => {},
  render = () => {},
  root = globalThis.document,
} = {}) {
  let invitations = [];
  let lifecycleGeneration = 0;
  let loadGeneration = 0;
  let authoritativeGeneration = 0;
  let bound = false;
  const busy = new Set();
  const errors = new Map();
  const committedAccepts = new Map();
  let queuedInvitations = null;
  let projectionChain = Promise.resolve();

  function snapshot() {
    return {
      entityType,
      invitations: invitations.map(invitation => ({ ...invitation })),
      busyIds: [...busy],
      errors: Object.fromEntries(errors),
    };
  }

  function publish() {
    render(snapshot());
  }

  function normalize(next) {
    return normalizedInvitations(next).map(normalizeInvitation).filter(invitation => invitation?.id != null);
  }

  function normalizeWithCommitted(next) {
    const normalized = normalize(next);
    const keys = new Set(normalized.map(invitation => invitationKey(invitation.id)));
    for (const [key, invitation] of committedAccepts) {
      if (!keys.has(key)) normalized.push(invitation);
    }
    return normalized;
  }

  function applyInvitations(next) {
    authoritativeGeneration += 1;
    const normalized = normalize(next);
    if (busy.size) {
      queuedInvitations = normalized;
      return snapshot();
    }
    invitations = normalizeWithCommitted(normalized);
    errors.clear();
    publish();
    return snapshot();
  }

  function setInvitations(next) {
    loadGeneration += 1;
    return applyInvitations(next);
  }

  async function load() {
    const requestGeneration = ++loadGeneration;
    try {
      const response = await listInvitations();
      if (requestGeneration !== loadGeneration) return { ok: false, stale: true };
      applyInvitations(response);
      return { ok: true, invitations: snapshot().invitations };
    } catch (error) {
      if (requestGeneration !== loadGeneration) return { ok: false, stale: true, error };
      return { ok: false, error };
    }
  }

  async function respond(invitationId, accept) {
    const key = invitationKey(invitationId);
    const invitation = invitations.find(candidate => invitationKey(candidate.id) === key);
    if (!invitation || busy.has(key)) return false;
    if (committedAccepts.has(key) && !accept) {
      errors.set(key, 'entity.invitation.error.respondFailed');
      publish();
      return false;
    }
    errors.delete(key);
    if (!isOnline()) {
      errors.set(key, 'entity.invitation.error.onlineOnly');
      publish();
      return false;
    }
    if (typeof respondInvitation !== 'function') return false;

    const operationGeneration = lifecycleGeneration;
    let projectionGeneration = null;
    busy.add(key);
    publish();
    try {
      if (!committedAccepts.has(key)) {
        await respondInvitation(invitation, Boolean(accept));
        if (operationGeneration !== lifecycleGeneration || !busy.has(key)) return false;
        if (accept) committedAccepts.set(key, invitation);
      }
      if (operationGeneration !== lifecycleGeneration || !busy.has(key)) return false;
      if (accept) {
        try {
          projectionGeneration = authoritativeGeneration;
          const applyProjection = async () => {
            if (operationGeneration !== lifecycleGeneration || !busy.has(key)) return false;
            if (projectionGeneration !== authoritativeGeneration) return 'stale-authoritative-snapshot';
            const projection = await loadAuthoritativeProjection(invitation);
            if (operationGeneration !== lifecycleGeneration || !busy.has(key)) return false;
            if (projectionGeneration !== authoritativeGeneration) return 'stale-authoritative-snapshot';
            await applyAuthoritativeProjection(projection, invitation, {
              isCurrent: () => (
                operationGeneration === lifecycleGeneration
                && busy.has(key)
                && projectionGeneration === authoritativeGeneration
              ),
            });
            return operationGeneration === lifecycleGeneration && busy.has(key);
          };
          const projection = projectionChain.then(applyProjection, applyProjection);
          projectionChain = projection.catch(() => {});
          const projectionResult = await projection;
          if (projectionResult === 'stale-authoritative-snapshot') {
            committedAccepts.delete(key);
            busy.delete(key);
            errors.delete(key);
            if (!busy.size && queuedInvitations) {
              invitations = normalizeWithCommitted(queuedInvitations);
              queuedInvitations = null;
            }
            publish();
            return false;
          }
          if (!projectionResult) return false;
        } catch (error) {
          onProjectionError(error, invitation);
          throw error;
        }
      }
      committedAccepts.delete(key);
      invitations = invitations.filter(candidate => invitationKey(candidate.id) !== key);
      if (queuedInvitations) {
        queuedInvitations = queuedInvitations.filter(candidate => invitationKey(candidate.id) !== key);
      }
      busy.delete(key);
      errors.delete(key);
      if (!busy.size && queuedInvitations) {
        invitations = normalizeWithCommitted(queuedInvitations);
        queuedInvitations = null;
      }
      publish();
      return true;
    } catch (error) {
      if (operationGeneration !== lifecycleGeneration || !busy.has(key)) return false;
      if (projectionGeneration != null && projectionGeneration !== authoritativeGeneration) {
        committedAccepts.delete(key);
        busy.delete(key);
        errors.delete(key);
        if (!busy.size && queuedInvitations) {
          invitations = normalize(queuedInvitations);
          queuedInvitations = null;
        }
        publish();
        return false;
      }
      busy.delete(key);
      if (!busy.size && queuedInvitations) {
        invitations = normalizeWithCommitted(queuedInvitations);
        queuedInvitations = null;
      }
      errors.set(key, 'entity.invitation.error.respondFailed');
      publish();
      return false;
    }
  }

  async function handleClick(event) {
    const target = event.target?.closest?.('[data-entity-invitation-action]');
    if (!target || target.dataset.entityType !== entityType) return;
    const action = target.dataset.entityInvitationAction;
    if (action !== 'accept' && action !== 'decline') return;
    event.preventDefault();
    await respond(target.dataset.invitationId, action === 'accept');
  }

  function bind() {
    if (bound) return;
    bound = true;
    root?.addEventListener?.('click', handleClick);
  }

  function destroy() {
    if (bound) root?.removeEventListener?.('click', handleClick);
    bound = false;
    lifecycleGeneration += 1;
    loadGeneration += 1;
    authoritativeGeneration += 1;
    busy.clear();
    committedAccepts.clear();
    queuedInvitations = null;
    projectionChain = Promise.resolve();
  }

  return {
    bind,
    destroy,
    load,
    respond,
    setInvitations,
    snapshot,
    render: publish,
  };
}
