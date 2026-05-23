import { iconSvg } from '../icons/lucide-icons.js';

export function createProjectSharingFeature({
  getProjects,
  setProjects,
  renderProjects,
  renderStats,
  renderTodos,
  showToast,
  projectsApi,
}) {
  let currentProject = null;
  let currentMembers = [];

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function isOwner(project) {
    if (!project) return false;
    if (project.is_owner === true || project.is_owner === 1 || project.is_owner === '1') return true;
    if (project.is_shared) return false;
    return !!project.user_id;
  }

  async function loadMembers(projectId) {
    const res = await projectsApi.listMembers(projectId);
    currentMembers = res?.members || [];
    renderMembers();
    updateSharingVisibility();
    return currentMembers;
  }

  function setShareError(message) {
    const errorEl = document.getElementById('project-share-error');
    if (errorEl) errorEl.textContent = message || '';
  }

  function updateSharingVisibility() {
    const sharingContent = document.getElementById('project-sharing-content');
    const shareStartRow = document.getElementById('project-share-start-row');
    const inviteRow = document.getElementById('project-share-row');
    if (!currentProject) return;

    const hasMembers = currentMembers.some(member => member?.status === 'accepted' || member?.status === 'pending');
    const own = isOwner(currentProject);
    const sharedProject = !!currentProject.is_shared && !own;

    if (own) {
      if (hasMembers) {
        if (sharingContent) sharingContent.style.display = '';
        if (shareStartRow) shareStartRow.style.display = 'none';
        if (inviteRow) inviteRow.style.display = '';
      }
      return;
    }

    if (sharedProject) {
      if (sharingContent) sharingContent.style.display = 'none';
      if (shareStartRow) shareStartRow.style.display = 'none';
      if (inviteRow) inviteRow.style.display = 'none';
    }
  }

  function renderMembers() {
    const el = document.getElementById('project-members-list');
    if (!el) return;
    if (!currentProject) {
      el.innerHTML = '';
      return;
    }

    const rows = [];
    // owner wird nicht angezeigt, nur member

    for (const member of currentMembers) {
      if (!member || member.user_id == null) continue;
      if (member.status !== 'accepted' && member.status !== 'pending') continue;
      const displayName = member.display_name || member.username;
      const usernamePart = member.display_name && member.display_name !== member.username ? ` <span class="sharing-display">(${escapeHtml(member.username)})</span>` : '';
      const status = member.status === 'pending' ? '<span class="sharing-pending">ausstehend</span>' : '';
      const remove = isOwner(currentProject) && member.user_id !== currentProject.user_id
        ? `<button class="sharing-remove" data-remove-member="${member.user_id}" title="Entfernen" aria-label="Mitglied entfernen">${iconSvg('x')}</button>`
        : '';
      rows.push(`
        <div class="sharing-member-row">
          <div class="sharing-member-main">
            <span class="sharing-member-name">${escapeHtml(displayName)}</span>${usernamePart}${status}
          </div>
          <div class="sharing-actions">${remove}</div>
        </div>
      `);
    }

    el.innerHTML = rows.join('');
    el.querySelectorAll('[data-remove-member]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const memberId = Number(btn.getAttribute('data-remove-member'));
        const member = currentMembers.find(m => Number(m.user_id) === memberId);
        if (!member) return;
        if (!confirm(`Mitglied ${member.username} entfernen?`)) return;
        await removeMember(member);
      });
    });
  }

  async function setProject(project) {
    currentProject = project;
    if (!project) return;
    await loadMembers(project.id);
  }

  async function inviteByUsername() {
    if (!currentProject) return;
    const input = document.getElementById('project-share-username');
    if (!input) return;
    const username = input.value.trim();
    setShareError('');
    if (!username) {
      setShareError('Benutzername oder E-Mail eingeben');
      input.focus();
      return;
    }
    try {
      const result = await projectsApi.shareProject(currentProject.id, username);
      input.value = '';
      const member = result?.member;
      const isEmailIdentifier = username.includes('@');
      
      // For email identifiers, don't reveal user details in UI to avoid enumeration hints
      if (isEmailIdentifier) {
        // Neutral response: no undo button to avoid revealing if user exists
        showToast('Einladung verarbeitet');
      } else if (member) {
        // For username identifiers, show detailed success with undo
        showToast('Einladung gesendet', {
          type: 'member_invite',
          data: {
            projectId: currentProject.id,
            userId: member.user_id,
            username: username,
          },
        });
      }
      await loadMembers(currentProject.id);
    } catch (err) {
      const msg = (err?.message || '').toLowerCase();
      if (msg.includes('404') || msg.includes('not found')) {
        setShareError(`Benutzer oder E-Mail "${username}" nicht gefunden`);
      } else if (msg.includes('403') || msg.includes('forbidden')) {
        setShareError('Keine Berechtigung — nur der Owner kann einladen');
      } else if (msg.includes('already')) {
        setShareError(`Benutzer oder E-Mail "${username}" hat bereits Zugriff oder eine ausstehende Einladung`);
      } else {
        setShareError('Fehler beim Einladen: ' + (err?.message || 'Unbekannter Fehler'));
      }
    }
  }

  async function removeMember(member) {
    if (!currentProject) return;
    await projectsApi.removeMember(currentProject.id, member.user_id);
    currentMembers = currentMembers.filter(m => Number(m.user_id) !== Number(member.user_id));
    renderMembers();
    showToast('Benutzer entfernt', {
      type: 'member_remove',
      data: {
        projectId: currentProject.id,
        userId: member.user_id,
        username: member.username,
      },
    });
  }

  async function leaveProject() {
    if (!currentProject) return;
    await projectsApi.leaveProject(currentProject.id);
    const removedProject = currentProject;
    setProjects(getProjects().filter(p => p.id !== currentProject.id));
    renderProjects();
    renderStats();
    renderTodos();
    showToast('Projekt verlassen', {
      type: 'project_leave',
      data: {
        projectId: removedProject.id,
        project: removedProject,
      },
    });
  }

  async function undoLeaveProject(data) {
    if (!data?.projectId) return;
    await projectsApi.undoLeaveProject(data.projectId);
    const res = await projectsApi.list();
    if (res?.projects) {
      setProjects(res.projects);
      renderProjects();
      renderStats();
      renderTodos();
    }
  }

  async function undoRemoveMember(data) {
    if (!data?.projectId || !data?.userId) return;
    await projectsApi.restoreMember(data.projectId, data.userId, 'accepted');
    await loadMembers(data.projectId);
  }

  async function undoInvite(data) {
    if (!data?.projectId || !data?.userId) return;
    await projectsApi.removeMember(data.projectId, data.userId);
    await loadMembers(data.projectId);
  }

  async function acceptInvite(projectId, inviteId) {
    await projectsApi.respondInvite(projectId, inviteId, true);
    showToast('Einladung angenommen');
    // Reload projects from server
    const res = await projectsApi.list();
    if (res?.projects) {
      setProjects(res.projects);
      renderProjects();
      renderStats();
      renderTodos();
    }
    await loadInvites();
  }

  async function declineInvite(projectId, inviteId) {
    const row = document.querySelector(`[data-invite-id="${CSS.escape(String(inviteId))}"]`);
    if (row) row.remove();
    await projectsApi.respondInvite(projectId, inviteId, false);
    showToast('Einladung abgelehnt');
    await loadInvites();
  }

  async function loadInvites() {
    try {
      const res = await projectsApi.listInvites();
      const invites = res?.invites || [];
      // Find renderInvites function - it might be in appRendering
      if (typeof window.renderInvites === 'function') {
        window.renderInvites(invites);
      }
    } catch (e) {
      console.error('Failed to load invites:', e);
    }
  }

  function showShareInput() {
    const content = document.getElementById('project-sharing-content');
    const startRow = document.getElementById('project-share-start-row');
    const inviteRow = document.getElementById('project-share-row');
    if (content) content.style.display = '';
    if (startRow) startRow.style.display = 'none';
    if (inviteRow) inviteRow.style.display = '';
    setShareError('');
  }

  function applyProjectModalState(project, canEdit, shared) {
    currentProject = project;
    const isOwn = isOwner(project);
    const sharingSection = document.getElementById('project-sharing-section');
    const sharingContent = document.getElementById('project-sharing-content');
    const shareStartRow = document.getElementById('project-share-start-row');
    const leaveBtn = document.getElementById('project-leave-btn');
    const ownerInfo = document.getElementById('project-owner-info');
    const inviteRow = document.getElementById('project-share-row');
    const fields = ['project-name', 'project-color', 'project-parent-id', 'project-icon'];

    if (sharingSection) sharingSection.style.display = project ? '' : 'none';
    if (leaveBtn) leaveBtn.style.display = shared && !isOwn ? '' : 'none';
    if (ownerInfo) {
      if (project && shared && !isOwn) {
        const ownerName = project.owner_display_name || project.owner_username || 'Unbekannt';
        const ownerUser = project.owner_username && project.owner_username !== ownerName ? ` (${project.owner_username})` : '';
        const nameEl = ownerInfo.querySelector('.project-owner-name');
        if (nameEl) nameEl.textContent = `${ownerName}${ownerUser}`;
        else ownerInfo.textContent = `Geteilt von ${ownerName}${ownerUser}`;
        ownerInfo.style.display = 'flex';
      } else {
        const nameEl = ownerInfo.querySelector('.project-owner-name');
        if (nameEl) nameEl.textContent = '';
        ownerInfo.style.display = 'none';
      }
    }
    setShareError('');

    if (!project) {
      if (sharingContent) sharingContent.style.display = 'none';
      if (shareStartRow) shareStartRow.style.display = 'none';
      if (inviteRow) inviteRow.style.display = 'none';
    } else if (isOwn) {
      if (shared) {
        if (sharingContent) sharingContent.style.display = '';
        if (shareStartRow) shareStartRow.style.display = 'none';
        if (inviteRow) inviteRow.style.display = '';
      } else {
        if (sharingContent) sharingContent.style.display = 'none';
        if (shareStartRow) shareStartRow.style.display = '';
        if (inviteRow) inviteRow.style.display = 'none';
      }
    } else {
      if (sharingContent) sharingContent.style.display = 'none';
      if (shareStartRow) shareStartRow.style.display = 'none';
      if (inviteRow) inviteRow.style.display = 'none';
    }

    const projectForm = document.getElementById('project-form');
    if (projectForm) projectForm.classList.toggle('readonly-project', !!project && !canEdit);
    for (const id of fields) {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = !canEdit;
        el.setAttribute('aria-readonly', canEdit ? 'false' : 'true');
      }
    }
    if (project?.id) loadMembers(project.id).catch(() => {});
  }

  return {
    setProject,
    inviteByUsername,
    leaveProject,
    undoLeaveProject,
    undoRemoveMember,
    undoInvite,
    acceptInvite,
    declineInvite,
    loadInvites,
    applyProjectModalState,
    loadMembers,
    showShareInput,
  };
}
