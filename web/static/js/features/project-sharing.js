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
    return currentMembers;
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
      const actions = [];
      if (isOwner(currentProject) && member.user_id !== currentProject.user_id) {
        actions.push(`<button class="btn btn-danger btn-sm" data-remove-member="${member.user_id}">Entfernen</button>`);
      }
      if (member.status === 'pending') {
        actions.push(`<span class="sharing-pending">ausstehend</span>`);
      }
      rows.push(`
        <div class="sharing-member-row">
          <div>
            <strong>${escapeHtml(member.username)}</strong>
            ${member.display_name ? `<span class="sharing-display">(${escapeHtml(member.display_name)})</span>` : ''}
          </div>
          <div class="sharing-actions">${actions.join(' ')}</div>
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
    if (!username) return showToast('Benutzername eingeben');
    try {
      const result = await projectsApi.shareProject(currentProject.id, username);
      input.value = '';
      const member = result?.member;
      showToast('Einladung gesendet', {
        type: 'member_invite',
        data: {
          projectId: currentProject.id,
          userId: member?.user_id,
          username: username,
        },
      });
      await loadMembers(currentProject.id);
    } catch (err) {
      const msg = (err?.message || '').toLowerCase();
      if (msg.includes('404') || msg.includes('not found')) {
        showToast(`Benutzer "${username}" nicht gefunden`);
      } else if (msg.includes('403') || msg.includes('forbidden')) {
        showToast('Keine Berechtigung — nur der Owner kann einladen');
      } else if (msg.includes('already')) {
        showToast(`Benutzer "${username}" hat bereits Zugriff oder eine ausstehende Einladung`);
      } else {
        showToast('Fehler beim Einladen: ' + (err?.message || 'Unbekannter Fehler'));
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
  }

  function applyProjectModalState(project, canEdit, shared) {
    currentProject = project;
    const isOwn = isOwner(project);
    const sharingSection = document.getElementById('project-sharing-section');
    const sharingContent = document.getElementById('project-sharing-content');
    const shareStartRow = document.getElementById('project-share-start-row');
    const leaveBtn = document.getElementById('project-leave-btn');
    const inviteRow = document.getElementById('project-share-row');
    const fields = ['project-name', 'project-color', 'project-parent-id'];

    if (sharingSection) sharingSection.style.display = project ? '' : 'none';
    if (leaveBtn) leaveBtn.style.display = shared && !isOwn ? '' : 'none';

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

    for (const id of fields) {
      const el = document.getElementById(id);
      if (el) el.disabled = !canEdit;
    }
    loadMembers(project?.id).catch(() => {});
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
