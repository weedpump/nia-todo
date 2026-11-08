function queueTodoId(item) {
  if (!item?.data || typeof item.data !== 'object') return null;
  if (['CREATE_TODO'].includes(item.action)) return item.data._tempId ?? null;
  if (['UPDATE_TODO', 'DELETE_TODO'].includes(item.action)) return item.data.id ?? null;
  if (['CREATE_COMMENT', 'UPDATE_COMMENT', 'DELETE_COMMENT', 'CREATE_SUBTASK', 'UPDATE_SUBTASK', 'DELETE_SUBTASK'].includes(item.action)) {
    return item.data.todo_id ?? null;
  }
  return null;
}

export function hasPendingTodoChanges(queue, todoId) {
  return queue.some(item => String(queueTodoId(item)) === String(todoId));
}

export function queueItemReferencesTodo(item, todoId) {
  return String(queueTodoId(item)) === String(todoId);
}

export function enrichTaskQueueBoundary(action, data, {
  todos = [],
  sections = [],
  projects = [],
} = {}) {
  const enriched = { ...(data || {}) };
  if (Array.isArray(enriched.project_boundary_ids) && enriched.project_boundary_ids.length) return enriched;

  const applyProjectBoundary = projectId => {
    if (projectId === undefined || projectId === null) return enriched;
    if (enriched.project_id === undefined || enriched.project_id === null) enriched.project_id = projectId;
    const boundaryIds = [];
    const seen = new Set();
    let currentId = projectId;
    while (currentId !== undefined && currentId !== null && !seen.has(String(currentId))) {
      seen.add(String(currentId));
      boundaryIds.push(currentId);
      const project = projects.find(candidate => String(candidate?.id) === String(currentId));
      currentId = project?.parent_id;
    }
    enriched.project_boundary_ids = boundaryIds;
    return enriched;
  };

  const todoActions = new Set([
    'CREATE_TODO', 'UPDATE_TODO', 'DELETE_TODO',
    'CREATE_COMMENT', 'UPDATE_COMMENT', 'DELETE_COMMENT',
    'CREATE_SUBTASK', 'UPDATE_SUBTASK', 'DELETE_SUBTASK',
  ]);
  if (todoActions.has(action)) {
    const todoId = action === 'CREATE_TODO'
      ? enriched._tempId
      : (['UPDATE_TODO', 'DELETE_TODO'].includes(action) ? enriched.id : enriched.todo_id);
    const todo = todos.find(candidate => String(candidate?.id) === String(todoId));
    return applyProjectBoundary(enriched.project_id ?? todo?.project_id ?? enriched.changes?.project_id);
  }

  if (['CREATE_SECTION', 'UPDATE_SECTION', 'DELETE_SECTION'].includes(action)) {
    const sectionId = action === 'CREATE_SECTION' ? enriched._tempId : enriched.id;
    const section = sections.find(candidate => String(candidate?.id) === String(sectionId));
    return applyProjectBoundary(enriched.project_id ?? section?.project_id);
  }

  if (['CREATE_PROJECT', 'UPDATE_PROJECT', 'DELETE_PROJECT'].includes(action)) {
    const projectId = action === 'CREATE_PROJECT' ? enriched._tempId : enriched.id;
    return applyProjectBoundary(enriched.project_id ?? projectId);
  }
  return enriched;
}

export function runCurrentEntityMutation(entityId, {
  getEntities,
  commit,
  mutate,
}) {
  if (typeof getEntities !== 'function') throw new TypeError('getEntities is required');
  if (typeof commit !== 'function') throw new TypeError('commit is required');
  if (typeof mutate !== 'function') throw new TypeError('mutate is required');
  return commit(async enqueue => {
    const currentId = typeof entityId === 'function' ? entityId() : entityId;
    if (currentId == null) return null;
    const current = (getEntities() || []).find(entity => String(entity?.id) === String(currentId));
    if (!current) return null;
    return mutate(current, enqueue);
  });
}

export async function beginSyncQueueWrite(syncRef) {
  if (!syncRef) return () => {};
  while (true) {
    while (syncRef.commitLocked) await syncRef.commitGate;
    syncRef.pendingQueueWrites = Number(syncRef.pendingQueueWrites || 0) + 1;
    if (!syncRef.commitLocked) break;
    syncRef.pendingQueueWrites -= 1;
  }
  return () => {
    syncRef.pendingQueueWrites = Math.max(0, Number(syncRef.pendingQueueWrites || 0) - 1);
  };
}

export async function acquireSyncCommitLock(syncRef) {
  if (!syncRef) return () => {};
  while (syncRef.commitLocked) await syncRef.commitGate;
  let releaseGate;
  syncRef.commitLocked = true;
  syncRef.commitGate = new Promise(resolve => { releaseGate = resolve; });
  while (Number(syncRef.pendingQueueWrites || 0) > 0) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return () => {
    syncRef.commitLocked = false;
    syncRef.commitGate = null;
    releaseGate();
  };
}

export function projectPendingTodoChanges(todo, pendingItems) {
  if (!todo) return null;
  let projected = {
    ...todo,
    comments: Array.isArray(todo.comments) ? [...todo.comments] : [],
    subtasks: Array.isArray(todo.subtasks) ? [...todo.subtasks] : [],
  };

  for (const item of pendingItems) {
    if (!item || typeof item.action !== 'string') continue;
    if (String(queueTodoId(item)) !== String(projected.id)) continue;

    if (item.action === 'DELETE_TODO') return null;
    if (item.action === 'UPDATE_TODO') {
      projected = { ...projected, ...(item.data?.changes || {}) };
    } else if (item.action === 'CREATE_COMMENT') {
      const comment = item.data?.local_comment;
      if (comment && !projected.comments.some(existing => String(existing.id) === String(comment.id))) {
        projected.comments.push(comment);
      }
    } else if (item.action === 'UPDATE_COMMENT') {
      projected.comments = projected.comments.map(comment => (
        String(comment.id) === String(item.data?.comment_id)
          ? { ...comment, ...(item.data?.changes || {}) }
          : comment
      ));
    } else if (item.action === 'DELETE_COMMENT') {
      projected.comments = projected.comments.filter(comment => String(comment.id) !== String(item.data?.comment_id));
    } else if (item.action === 'CREATE_SUBTASK') {
      const subtask = item.data?.local_subtask;
      if (subtask && !projected.subtasks.some(existing => String(existing.id) === String(subtask.id))) {
        projected.subtasks.push(subtask);
      }
    } else if (item.action === 'UPDATE_SUBTASK') {
      projected.subtasks = projected.subtasks.map(subtask => (
        String(subtask.id) === String(item.data?.subtask_id)
          ? { ...subtask, ...(item.data?.changes || {}) }
          : subtask
      ));
    } else if (item.action === 'DELETE_SUBTASK') {
      projected.subtasks = projected.subtasks.filter(subtask => String(subtask.id) !== String(item.data?.subtask_id));
    }
  }

  projected.comments_count = projected.comments.length;
  projected.subtasks.sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || String(a.id).localeCompare(String(b.id)));
  return projected;
}

export function projectPendingProjectChanges(project, pendingItems) {
  if (!project) return null;
  let projected = { ...project };
  for (const item of pendingItems || []) {
    if (String(item?.data?.id) !== String(projected.id)) continue;
    if (item.action === 'DELETE_PROJECT') return null;
    if (item.action === 'UPDATE_PROJECT') projected = { ...projected, ...(item.data?.changes || {}) };
  }
  return projected;
}

export function projectPendingSectionChanges(section, pendingItems) {
  if (!section) return null;
  let projected = { ...section };
  for (const item of pendingItems || []) {
    if (String(item?.data?.id) !== String(projected.id)) continue;
    if (item.action === 'DELETE_SECTION') return null;
    if (item.action === 'UPDATE_SECTION') projected = { ...projected, ...(item.data?.changes || {}) };
  }
  return projected;
}

export function projectPendingSectionsSnapshot(serverSections, localSections, pendingItems, projectId) {
  const queue = pendingItems || [];
  const projected = [];
  const serverIds = new Set();
  for (const section of serverSections || []) {
    serverIds.add(String(section.id));
    const next = projectPendingSectionChanges(section, queue);
    if (next) projected.push(next);
  }
  for (const section of localSections || []) {
    if (String(section.project_id) !== String(projectId) || serverIds.has(String(section.id))) continue;
    const hasPendingChange = queue.some(item => (
      (item.action === 'CREATE_SECTION' && String(item.data?._tempId) === String(section.id))
      || (['UPDATE_SECTION', 'DELETE_SECTION'].includes(item.action) && String(item.data?.id) === String(section.id))
    ));
    if (!hasPendingChange) continue;
    const next = projectPendingSectionChanges(section, queue);
    if (next) projected.push(next);
  }
  return projected;
}
