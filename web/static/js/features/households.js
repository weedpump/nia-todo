import { t } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function createHouseholdsFeature({
  householdsApi,
  getCurrentUser,
  getAccessSnapshot,
  setAccessSnapshot,
  showSettingsPage,
  confirmDanger,
  promptText,
  onChanged = () => {},
}) {
  let bound = false;
  let loading = false;

  function snapshot() {
    return getAccessSnapshot?.() || { household: null, householdInvites: [] };
  }

  function setSnapshot(next) {
    const normalized = {
      ...snapshot(),
      ...next,
      household: next.household ?? null,
      householdInvites: Array.isArray(next.householdInvites) ? next.householdInvites : [],
    };
    setAccessSnapshot?.(normalized);
    window.niaAccessSnapshot = normalized;
    render(normalized);
    return normalized;
  }

  function isOwner(household) {
    const user = getCurrentUser?.();
    return household?.role === 'owner' || (user?.id != null && String(household?.owner_user_id) === String(user.id));
  }

  function renderInviteBadge(invites) {
    const hasInvite = invites.length > 0;
    const badges = [
      document.getElementById('user-menu-household-badge'),
      document.getElementById('settings-household-nav-badge'),
    ].filter(Boolean);
    badges.forEach(badge => {
      badge.hidden = !hasInvite;
      badge.textContent = '';
      badge.setAttribute('aria-label', t('settings.household.pendingInviteCount', { count: invites.length }));
    });
    const menuEntry = document.getElementById('user-menu-household');
    if (menuEntry) menuEntry.hidden = !hasInvite;
    const sidebarIndicator = document.getElementById('user-menu-household-indicator');
    if (sidebarIndicator) sidebarIndicator.hidden = !hasInvite;
    const sidebarToggleIndicator = document.getElementById('sidebar-toggle-household-indicator');
    if (sidebarToggleIndicator) sidebarToggleIndicator.hidden = !hasInvite;
  }

  function memberName(member) {
    return member.display_name || member.username || t('settings.household.unknownMember');
  }

  function renderIncoming(invites) {
    const container = document.getElementById('settings-household-incoming');
    if (!container) return;
    const section = document.getElementById('settings-household-incoming-section');
    const visibleInvites = snapshot().household ? [] : invites;
    if (section) section.hidden = visibleInvites.length === 0;
    container.innerHTML = visibleInvites.map(invite => `
      <div class="settings-household-row" data-household-invite-id="${escapeAttr(invite.id)}">
        <div><strong>${escapeHtml(invite.household_name)}</strong><span>${escapeHtml(t('settings.household.invitedBy', { name: invite.invited_by_display_name || invite.invited_by_username || '–' }))}</span></div>
        <div class="settings-household-actions">
          <button type="button" class="btn btn-primary btn-small" data-household-action="respond-invite" data-household-id="${escapeAttr(invite.household_id)}" data-invite-id="${escapeAttr(invite.id)}" data-accept="true">${escapeHtml(t('settings.household.accept'))}</button>
          <button type="button" class="btn btn-secondary btn-small" data-household-action="respond-invite" data-household-id="${escapeAttr(invite.household_id)}" data-invite-id="${escapeAttr(invite.id)}" data-accept="false">${escapeHtml(t('settings.household.decline'))}</button>
        </div>
      </div>`).join('');
  }

  function renderHousehold(household) {
    const createPanel = document.getElementById('settings-household-create');
    const currentPanel = document.getElementById('settings-household-current');
    if (createPanel) createPanel.hidden = Boolean(household);
    if (currentPanel) currentPanel.hidden = !household;
    if (!household) return;

    const owner = isOwner(household);
    const nameInput = document.getElementById('settings-household-name');
    if (nameInput) {
      nameInput.value = household.name || '';
      nameInput.disabled = !owner;
      nameInput.readOnly = !owner;
    }
    const ownerEl = document.getElementById('settings-household-owner');
    if (ownerEl) ownerEl.textContent = household.owner_display_name || household.owner_username || '–';
    const inviteButton = document.querySelector('[data-household-action="invite"]');
    const inviteInput = document.getElementById('settings-household-invite-identifier');
    const renameButton = document.querySelector('[data-household-action="rename"]');
    if (inviteButton) inviteButton.hidden = !owner;
    if (inviteInput) inviteInput.closest('.settings-household-invite-row')?.toggleAttribute('hidden', !owner);
    if (renameButton) renameButton.hidden = !owner;

    const accepted = (household.members || []).filter(member => member.status === 'accepted');
    const pending = (household.members || []).filter(member => member.status === 'pending');
    const members = document.getElementById('settings-household-members');
    if (members) {
      const ownerRow = `<div class="settings-household-row"><div><strong>${escapeHtml(household.owner_display_name || household.owner_username || t('settings.household.owner'))}</strong><span>${escapeHtml(t('settings.household.owner'))}</span></div>${iconSvg('crown')}</div>`;
      members.innerHTML = ownerRow + accepted.filter(member => String(member.user_id) !== String(household.owner_user_id)).map(member => `
        <div class="settings-household-row" data-household-member-id="${escapeAttr(member.user_id)}">
          <div><strong>${escapeHtml(memberName(member))}</strong><span>@${escapeHtml(member.username || '')}</span></div>
          ${owner ? `<div class="settings-household-actions"><button type="button" class="btn btn-secondary btn-small" data-household-action="transfer-owner" data-user-id="${escapeAttr(member.user_id)}" data-member-name="${escapeAttr(memberName(member))}">${escapeHtml(t('settings.household.transferOwner'))}</button><button type="button" class="btn btn-danger btn-small" data-household-action="remove-member" data-user-id="${escapeAttr(member.user_id)}" data-member-name="${escapeAttr(memberName(member))}">${escapeHtml(t('settings.household.removeMember'))}</button></div>` : ''}
        </div>`).join('');
    }
    const outgoing = document.getElementById('settings-household-outgoing');
    const outgoingSection = document.getElementById('settings-household-outgoing-section');
    if (outgoingSection) outgoingSection.hidden = pending.length === 0;
    if (outgoing) outgoing.innerHTML = pending.map(member => `<div class="settings-household-row" data-household-status="pending"><div><strong>${escapeHtml(memberName(member))}</strong><span>${escapeHtml(t('settings.household.pending'))}</span></div></div>`).join('');

    const leave = document.getElementById('settings-household-leave');
    const dissolve = document.getElementById('settings-household-dissolve');
    const dissolveWrap = document.getElementById('settings-household-dissolve-wrap');
    if (leave) leave.hidden = owner;
    if (dissolve) dissolve.hidden = !owner;
    if (dissolveWrap) dissolveWrap.hidden = !owner;
  }

  function render(state = snapshot()) {
    renderInviteBadge(state.householdInvites || []);
    renderHousehold(state.household || null);
    renderIncoming(state.householdInvites || []);
    const loadingEl = document.getElementById('settings-household-loading');
    if (loadingEl) loadingEl.hidden = !loading;
  }

  async function refresh() {
    if (loading) return snapshot();
    loading = true;
    render();
    const error = document.getElementById('settings-household-error');
    if (error) error.textContent = '';
    try {
      const [current, invites] = await Promise.all([householdsApi.current(), householdsApi.listInvites()]);
      return setSnapshot({ household: current.household ?? null, householdInvites: invites.invites || [] });
    } catch (err) {
      if (error) error.textContent = err?.message || t('settings.household.loadFailed');
      return snapshot();
    } finally {
      loading = false;
      render();
    }
  }

  async function openSettings() {
    showSettingsPage?.('household');
    await refresh();
  }

  async function mutate(action) {
    const error = document.getElementById('settings-household-error');
    const success = document.getElementById('settings-household-success');
    if (error) error.textContent = '';
    if (success) success.textContent = '';
    try {
      await action();
      await refresh();
      onChanged();
    } catch (err) {
      if (error) error.textContent = err?.message || String(err);
    }
  }

  async function create() {
    const name = document.getElementById('settings-household-create-name')?.value?.trim() || '';
    if (!name) return;
    await mutate(async () => {
      const result = await householdsApi.create({ name });
      setSnapshot({ household: result.household, householdInvites: snapshot().householdInvites || [] });
    });
  }

  async function rename() {
    const household = snapshot().household;
    const name = document.getElementById('settings-household-name')?.value?.trim() || '';
    if (!household || !name || name === household.name) return;
    await mutate(async () => {
      const result = await householdsApi.update(household.id, { name });
      setSnapshot({ household: result.household || { ...household, name }, householdInvites: snapshot().householdInvites || [] });
    });
  }

  async function invite() {
    const household = snapshot().household;
    const input = document.getElementById('settings-household-invite-identifier');
    const identifier = input?.value?.trim() || '';
    if (!household || !identifier) return;
    await mutate(async () => {
      await householdsApi.invite(household.id, identifier);
      if (input) input.value = '';
    });
  }

  async function respond(target) {
    await mutate(() => householdsApi.respondInvite(Number(target.dataset.householdId), Number(target.dataset.inviteId), target.dataset.accept === 'true'));
  }

  async function leave() {
    const household = snapshot().household;
    if (!household) return;
    const confirmed = await confirmDanger({ title: t('settings.household.leaveTitle'), message: t('settings.household.leaveMessage', { name: household.name }), confirmText: t('settings.household.leave') });
    if (confirmed) await mutate(() => householdsApi.leave(household.id));
  }

  async function removeMember(target) {
    const household = snapshot().household;
    if (!household) return;
    const confirmed = await confirmDanger({ title: t('settings.household.removeTitle'), message: t('settings.household.removeMessage', { name: target.dataset.memberName }), confirmText: t('settings.household.removeMember') });
    if (confirmed) await mutate(() => householdsApi.removeMember(household.id, Number(target.dataset.userId)));
  }

  async function transferOwner(target) {
    const household = snapshot().household;
    if (!household) return;
    const confirmed = await confirmDanger({ title: t('settings.household.transferTitle'), message: t('settings.household.transferMessage', { name: target.dataset.memberName }), confirmText: t('settings.household.transferOwner') });
    if (confirmed) await mutate(() => householdsApi.transferOwner(household.id, Number(target.dataset.userId)));
  }

  async function dissolve() {
    const household = snapshot().household;
    if (!household) return;
    const typed = await promptText({ title: t('settings.household.dissolveTitle'), message: t('settings.household.dissolveMessage', { name: household.name }), label: t('settings.household.dissolveNameLabel'), required: true, primaryText: t('settings.household.dissolve') });
    if (typed !== household.name) {
      const error = document.getElementById('settings-household-error');
      if (error && typed != null) error.textContent = t('settings.household.dissolveNameMismatch');
      return;
    }
    await mutate(() => householdsApi.dissolve(household.id));
  }

  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', async event => {
      const target = event.target?.closest?.('[data-household-action]');
      if (!target) return;
      event.preventDefault();
      const action = target.dataset.householdAction;
      if (action === 'create') await create();
      else if (action === 'rename') await rename();
      else if (action === 'invite') await invite();
      else if (action === 'respond-invite') await respond(target);
      else if (action === 'leave') await leave();
      else if (action === 'remove-member') await removeMember(target);
      else if (action === 'transfer-owner') await transferOwner(target);
      else if (action === 'dissolve') await dissolve();
    });
    window.addEventListener('nia:access-snapshot', event => applyAccessSnapshot(event.detail));
    window.addEventListener('nia:settings-opened', () => { refresh().catch(() => {}); });
    render();
  }

  function applyAccessSnapshot(next) {
    if (!next) return;
    setSnapshot({ household: next.household ?? null, householdInvites: next.householdInvites || [] });
  }

  return { bind, render, refresh, openSettings, applyAccessSnapshot };
}
