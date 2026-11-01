import { t } from '../i18n/index.js';
import { refreshSelect } from '../ui/dropdowns.js';
import { createEntityDirectSharingFeature } from './entity-direct-sharing.js';
import { createEntityInvitationsFeature, renderEntityInvitationsHost } from './entity-invitations.js';
import { isHouseholdOwnedEntity } from './entity-ownership-field.js';
import { createEntityAccessPrivacyController } from './entity-access-privacy.js';

export function createProjectSharingFeature({
  getProjects,
  setProjects,
  renderProjects,
  renderStats,
  renderTodos,
  showToast,
  confirmDanger,
  projectsApi,
  loadAuthoritativeProjection = () => projectsApi.list(),
  removePendingEntities = async () => {},
}) {
  let currentProject = null;
  const localPendingMembersByProject = new Map();
  const privacy = createEntityAccessPrivacyController({
    evictEntities: removePendingEntities,
    onError: error => console.error('Failed to evict pending project data', error),
  });

  function isOwner(project) {
    if (!project) return false;
    if (Object.prototype.hasOwnProperty.call(project, 'is_owner')) {
      return project.is_owner === true || project.is_owner === 1 || project.is_owner === '1';
    }
    if (project.is_shared) return false;
    return !!project.user_id;
  }

  function pendingMembers(projectId) {
    return localPendingMembersByProject.get(Number(projectId)) || [];
  }

  async function listMembers(projectId) {
    const response = await projectsApi.listMembers(projectId);
    const serverMembers = response?.members || [];
    const seen = new Set(serverMembers.map(member => Number(member.user_id ?? member.id)));
    return serverMembers.concat(pendingMembers(projectId).filter(member => !seen.has(Number(member.user_id ?? member.id))));
  }

  const directSharing = createEntityDirectSharingFeature({
    prefix: 'project',
    listMembers,
    grantMember: (projectId, identifier) => projectsApi.shareProject(projectId, identifier),
    revokeMember: (projectId, userId) => projectsApi.removeMember(projectId, userId),
    leaveEntity: projectId => projectsApi.leaveProject(projectId),
    confirmDanger,
    onMemberAdded: (member, project) => {
      project.has_sharing_activity = true;
      const key = Number(project.id);
      const pending = pendingMembers(key).filter(item => Number(item.user_id ?? item.id) !== Number(member.user_id ?? member.id));
      if (member.status === 'pending') pending.push(member);
      localPendingMembersByProject.set(key, pending);
      showToast(t('project.share.inviteSent'), {
        type: 'member_invite',
        data: { projectId: project.id, userId: member.user_id ?? member.id, username: member.username },
      });
    },
    onMemberRemoved: (member, project) => {
      const key = Number(project.id);
      localPendingMembersByProject.set(key, pendingMembers(key).filter(item => Number(item.user_id ?? item.id) !== Number(member.user_id ?? member.id)));
      showToast(t('entity.share.userRemoved'), {
        type: 'member_remove',
        data: { projectId: project.id, userId: member.user_id ?? member.id, username: member.username },
      });
    },
    onLeft: project => {
      setProjects(getProjects().filter(candidate => candidate.id !== project.id));
      renderProjects();
      renderStats();
      renderTodos();
      showToast(t('project.share.left'), {
        type: 'project_leave',
        data: { projectId: project.id, project },
      });
    },
  });

  const invitations = createEntityInvitationsFeature({
    entityType: 'project',
    listInvitations: async () => {
      const response = await projectsApi.listInvites();
      privacy.beginGeneration();
      return response;
    },
    normalizeInvitation: invite => ({
      ...invite,
      entityId: invite.project_id ?? invite.entity_id,
      name: invite.project_name ?? invite.entity_name ?? invite.name,
    }),
    respondInvitation: (invite, accept) => projectsApi.respondInvite(invite.entityId, invite.id, accept),
    loadAuthoritativeProjection,
    applyAuthoritativeProjection: (response, invitation, context) => {
      if (!Array.isArray(response?.projects)) return;
      setProjects(response.projects);
      if (context?.isCurrent?.()) privacy.commitAccessible([invitation.entityId]);
      renderProjects();
      renderStats();
      renderTodos();
    },
    render: state => {
      privacy.schedulePending(state.invitations.map(invite => invite.entityId));
      renderEntityInvitationsHost({
        sectionId: 'invites-section',
        listId: 'invites-list',
        entityType: 'project',
        state,
      });
    },
  });

  async function loadMembers(projectId) {
    if (!currentProject || String(currentProject.id) !== String(projectId)) {
      currentProject = getProjects().find(project => String(project.id) === String(projectId)) || null;
    }
    await directSharing.setEntity(currentProject);
    return [];
  }

  async function setProject(project) {
    currentProject = project || null;
    await directSharing.setEntity(currentProject);
  }

  async function inviteByUsername() {
    return directSharing.grant();
  }

  async function removeMember(member) {
    return directSharing.revoke(member?.user_id ?? member?.id);
  }

  async function leaveProject() {
    return directSharing.leave();
  }

  async function undoLeaveProject(data) {
    if (!data?.projectId) return;
    await projectsApi.undoLeaveProject(data.projectId);
    const response = await projectsApi.list();
    if (response?.projects) {
      setProjects(response.projects);
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
    const accepted = await invitations.respond(inviteId, true);
    if (accepted) showToast(t('project.share.accepted'));
    return accepted;
  }

  async function declineInvite(projectId, inviteId) {
    const declined = await invitations.respond(inviteId, false);
    if (declined) showToast(t('project.share.declined'));
    return declined;
  }

  async function loadInvites() {
    return invitations.load();
  }

  function setInvites(next) {
    privacy.beginGeneration();
    return invitations.setInvitations(next);
  }

  function commitAuthoritativeSnapshot(authoritativeProjects) {
    const accessibleProjects = Array.isArray(authoritativeProjects) ? authoritativeProjects : getProjects();
    privacy.commitAccessible(accessibleProjects.map(project => project?.id));
    invitations.render();
  }

  function renderInvites() {
    invitations.render();
  }

  function bindProjectSharingActions() {
    directSharing.bind();
    invitations.bind();
  }

  function showShareInput() {
    return directSharing.showShareInput();
  }

  function applyProjectModalState(project, canEdit, shared) {
    currentProject = project;
    const own = isOwner(project);
    const householdProject = isHouseholdOwnedEntity(project);
    const fields = ['project-name', 'project-color', 'project-parent-id', 'project-icon'];
    const displayWorkspace = document.getElementById('project-display-workspace-id');
    const iconPicker = document.getElementById('project-icon-picker');
    const saveBtn = document.getElementById('project-save-btn');

    const projectForm = document.getElementById('project-form');
    if (projectForm) projectForm.classList.toggle('readonly-project', !!project && !canEdit);
    for (const id of fields) {
      const element = document.getElementById(id);
      if (element) {
        element.disabled = !canEdit;
        element.setAttribute('aria-readonly', canEdit ? 'false' : 'true');
        if (element.tagName === 'SELECT') refreshSelect(element);
      }
    }
    const canMoveSharedDisplay = !!project && shared && !own && !householdProject;
    const canMoveOwnProject = !!project && own && !project.is_inbox && !householdProject;
    if (displayWorkspace) {
      displayWorkspace.disabled = !(canMoveSharedDisplay || canMoveOwnProject);
      refreshSelect(displayWorkspace);
    }
    if (iconPicker) {
      iconPicker.style.pointerEvents = canEdit ? '' : 'none';
      iconPicker.style.opacity = canEdit ? '' : '0.6';
      iconPicker.setAttribute('aria-disabled', canEdit ? 'false' : 'true');
    }
    if (saveBtn) saveBtn.style.display = (canEdit || canMoveSharedDisplay || canMoveOwnProject) ? '' : 'none';
    directSharing.setEntity(project).catch(() => {});
  }

  return {
    setProject,
    inviteByUsername,
    removeMember,
    leaveProject,
    undoLeaveProject,
    undoRemoveMember,
    undoInvite,
    acceptInvite,
    declineInvite,
    loadInvites,
    setInvites,
    commitAuthoritativeSnapshot,
    renderInvites,
    bindProjectSharingActions,
    applyProjectModalState,
    loadMembers,
    showShareInput,
  };
}
