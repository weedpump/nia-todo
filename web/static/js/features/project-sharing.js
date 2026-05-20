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
    return !!project && (project.is_owner === true || project.is_owner === 1 || project.is_owner === '1');
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
    await projectsApi.shareProject(currentProject.id, username);
    input.value = '';
    showToast('Einladung gesendet');
    await loadMembers(currentProject.id);
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
    await projectsApi.respondInvite(data.projectId, data.project?.member_id || data.memberId || data.projectId, true).catch(async () => {
      // fallback: re-add local only if no invite exists
    });
    const exists = getProjects().some(p => p.id === data.project.id);
    if (!exists) {
      setProjects([...getProjects(), data.project]);
      renderProjects();
      renderStats();
      renderTodos();
    }
  }

  async function undoRemoveMember(data) {
    if (!data?.projectId || !data?.username) return;
    await projectsApi.shareProject(data.projectId, data.username);
    await loadMembers(data.projectId);
  }

  function applyProjectModalState(project, canEdit, shared) {
    currentProject = project;
    const isOwn = isOwner(currentProject);
    const sharingSection = document.getElementById('project-sharing-section');
    const sharingContent = document.getElementById('project-sharing-content');
    const shareStartRow = document.getElementById('project-share-start-row');
    const leaveBtn = document.getElementById('project-leave-btn');
    const inviteRow = document.getElementById('project-share-row');
    const fields = ['project-name', 'project-color', 'project-parent-id'];

    if (sharingSection) sharingSection.style.display = project ? '' : 'none';
    if (leaveBtn) leaveBtn.style.display = shared && !isOwn ? '' : 'none';
    if (inviteRow) inviteRow.style.display = isOwn ? '' : 'none';
    if (sharingContent) sharingContent.style.display = isOwn ? '' : 'none';
    if (shareStartRow) shareStartRow.style.display = isOwn && !shared ? '' : 'none';

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
    applyProjectModalState,
    loadMembers,
    showShareInput,
  };

  function showShareInput() {
    const content = document.getElementById('project-sharing-content');
    const startRow = document.getElementById('project-share-start-row');
    if (content) content.style.display = '';
    if (startRow) startRow.style.display = 'none';
  }
