function knownId(value, entities) {
  const entity = entities.find(candidate => candidate?.id != null && String(candidate.id) === String(value));
  if (!entity) return undefined;
  if (typeof entity.id === 'string' && entity.id.startsWith('temp-')) return entity.id;
  const numeric = Number(entity.id);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

/** Resolve form/Quick Add targets only through the current accessible catalog. */
export function resolveKnownTodoTargets({ projectId = null, sectionId = null, projects = [], sections = [], inheritedSectionProjectId } = {}) {
  const project_id = projectId == null || projectId === '' ? null : knownId(projectId, projects);
  if (project_id === undefined) return null;
  const section_id = sectionId == null || sectionId === '' ? null : knownId(sectionId, sections);
  if (section_id === undefined) return null;
  if (section_id != null) {
    const section = sections.find(candidate => String(candidate.id) === String(section_id));
    if (project_id == null || String(section?.project_id) !== String(project_id)) {
      // A project-only Quick Add override replaces its valid inherited section.
      // Explicit section shortcuts and unavailable defaults must still fail.
      const inheritedProject = inheritedSectionProjectId == null ? undefined : knownId(inheritedSectionProjectId, projects);
      if (project_id != null && inheritedProject !== undefined && String(section?.project_id) === String(inheritedProject)) {
        return { project_id, section_id: null };
      }
      return null;
    }
  }
  return { project_id, section_id };
}
