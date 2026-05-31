export function createSyncFeature({
  getDb,
  dbGetAll,
  dbPut,
  dbClear,
  getFromDB,
  deleteFromDB,
  getTodos,
  setTodos,
  getProjects,
  setProjects,
  getSections,
  setSections,
  getWorkspaces,
  setWorkspaces,
  todosApi,
  projectsApi,
  sectionsApi,
  workspacesApi,
}) {
  function isOnlineForSync(wsState) {
    // Browser/native offline state must win over a stale WebSocket state.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    return wsState === 'connected' || (typeof navigator !== 'undefined' && navigator.onLine);
  }

  function pickAllowed(source, allowedFields) {
    const out = {};
    if (!source || typeof source !== 'object') return out;
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
    }
    return out;
  }

  function sanitizeQueueItem(item) {
    if (!item || typeof item !== 'object' || typeof item.action !== 'string') return null;
    const data = item.data && typeof item.data === 'object' ? item.data : {};
    const changes = data.changes && typeof data.changes === 'object' ? data.changes : {};
    const todoFields = ['title', 'description', 'priority', 'is_pinned', 'status', 'project_id', 'section_id', 'due_date', 'remind_at', '_tempId'];
    const projectFields = ['name', 'color', 'icon', 'sort_order', 'parent_id', 'workspace_id', '_tempId'];
    const sectionFields = ['name', 'sort_order', 'project_id', '_tempId'];

    switch (item.action) {
      case 'CREATE_TODO':
        return { ...item, data: pickAllowed(data, todoFields) };
      case 'UPDATE_TODO':
        return { ...item, data: { id: data.id, changes: pickAllowed(changes, todoFields.filter(f => f !== '_tempId')) } };
      case 'DELETE_TODO':
        return { ...item, data: { id: data.id } };
      case 'CREATE_PROJECT':
        return { ...item, data: pickAllowed(data, projectFields) };
      case 'UPDATE_PROJECT':
        return { ...item, data: { id: data.id, changes: pickAllowed(changes, projectFields.filter(f => f !== '_tempId')) } };
      case 'DELETE_PROJECT':
        return { ...item, data: { id: data.id } };
      case 'CREATE_SECTION':
        return { ...item, data: pickAllowed(data, sectionFields) };
      case 'UPDATE_SECTION':
        return { ...item, data: { id: data.id, changes: pickAllowed(changes, sectionFields.filter(f => !['_tempId', 'project_id'].includes(f))) } };
      case 'DELETE_SECTION':
        return { ...item, data: { id: data.id } };
      default:
        return null;
    }
  }

  async function syncWithServer({ wsState, syncInProgressRef }) {
    if (!isOnlineForSync(wsState) || !getDb() || syncInProgressRef.value) return;
    syncInProgressRef.value = true;
    const queue = await dbGetAll('syncQueue');
    if (!queue.length) { syncInProgressRef.value = false; return; }

    let successCount = 0;
    let failCount = 0;
    let needsAuthoritativeRefresh = false;
    for (const queuedItem of queue) {
      const item = sanitizeQueueItem(queuedItem);
      if (!item) {
        await deleteFromDB('syncQueue', queuedItem.id);
        continue;
      }
      try {
        if (item.action === 'CREATE_TODO') {
          let res = await todosApi.create(item.data);
          let localTempTodo = null;
          if (item.data._tempId) {
            localTempTodo = await getFromDB('todos', item.data._tempId);
            const localSectionChanged = localTempTodo && localTempTodo.section_id !== item.data.section_id;
            if (localSectionChanged) {
              res = await todosApi.update(res.id, { section_id: localTempTodo.section_id });
            }
            await deleteFromDB('todos', item.data._tempId);
            setTodos(getTodos().filter(t => t.id !== item.data._tempId));
          }
          await dbPut('todos', res);
          const withoutTemp = item.data._tempId ? getTodos().filter(t => t.id !== item.data._tempId) : getTodos();
          if (!withoutTemp.find(t => t.id === res.id)) setTodos([...withoutTemp, res]);
          else setTodos(withoutTemp.map(t => t.id === res.id ? res : t));
          successCount++;
        } else if (item.action === 'UPDATE_TODO') {
          const serverTodo = await todosApi.update(item.data.id, item.data.changes);
          const localTodo = await getFromDB('todos', item.data.id);
          const nextTodo = serverTodo || (localTodo ? { ...localTodo, ...item.data.changes, updated_at: new Date().toISOString() } : null);
          if (nextTodo) {
            await dbPut('todos', nextTodo);
            setTodos(getTodos().map(todo => todo.id === item.data.id ? nextTodo : todo));
          }
          successCount++;
        } else if (item.action === 'DELETE_TODO') {
          await todosApi.delete(item.data.id);
          await deleteFromDB('todos', item.data.id);
          successCount++;
        } else if (item.action === 'CREATE_PROJECT') {
          const res = await projectsApi.create(item.data);
          if (item.data._tempId) {
            await deleteFromDB('projects', item.data._tempId);
            setProjects(getProjects().filter(p => p.id !== item.data._tempId));
          }
          await dbPut('projects', res);
          if (!getProjects().find(p => p.id === res.id)) setProjects([...getProjects(), res]);
          successCount++;
        } else if (item.action === 'DELETE_PROJECT') {
          const res = await projectsApi.delete(item.data.id);
          const deletedIds = res.deleted_ids || [item.data.id];
          await Promise.all(deletedIds.map(projectId => deleteFromDB('projects', projectId)));
          needsAuthoritativeRefresh = true;
          successCount++;
        } else if (item.action === 'UPDATE_PROJECT') {
          const serverProject = await projectsApi.update(item.data.id, item.data.changes);
          const updatedProjects = Array.isArray(serverProject?.updated_projects) ? serverProject.updated_projects : (serverProject ? [serverProject] : []);
          if (updatedProjects.length) {
            await Promise.all(updatedProjects.map(project => dbPut('projects', project)));
            const byId = new Map(updatedProjects.map(project => [String(project.id), project]));
            const existingIds = new Set(getProjects().map(project => String(project.id)));
            const mergedProjects = getProjects().map(project => byId.get(String(project.id)) || project);
            for (const project of updatedProjects) {
              if (!existingIds.has(String(project.id))) mergedProjects.push(project);
            }
            setProjects(mergedProjects);
          } else {
            const localProject = await getFromDB('projects', item.data.id);
            if (localProject) await dbPut('projects', { ...localProject, ...item.data.changes, updated_at: new Date().toISOString() });
          }
          if (item.data.changes && Object.prototype.hasOwnProperty.call(item.data.changes, 'workspace_id')) {
            needsAuthoritativeRefresh = true;
          }
          successCount++;
        } else if (item.action === 'CREATE_SECTION') {
          const res = await sectionsApi.create(item.data.project_id, item.data);
          if (item.data._tempId) {
            await deleteFromDB('sections', item.data._tempId);
            setSections(getSections().filter(s => s.id !== item.data._tempId));
          }
          await dbPut('sections', res);
          if (!getSections().find(s => s.id === res.id)) setSections([...getSections(), res]);
          successCount++;
        } else if (item.action === 'UPDATE_SECTION') {
          await sectionsApi.update(item.data.id, item.data.changes);
          const localSection = await getFromDB('sections', item.data.id);
          if (localSection) await dbPut('sections', { ...localSection, ...item.data.changes, updated_at: new Date().toISOString() });
          successCount++;
        } else if (item.action === 'DELETE_SECTION') {
          await sectionsApi.delete(item.data.id);
          await deleteFromDB('sections', item.data.id);
          successCount++;
        }
        await deleteFromDB('syncQueue', item.id);
      } catch (err) {
        console.error('Sync failed for action', item.action, err);
        if (item.action === 'CREATE_PROJECT' && item.data?._tempId && err?.status && err.status < 500) {
          await deleteFromDB('projects', item.data._tempId);
          setProjects(getProjects().filter(p => p.id !== item.data._tempId));
          await deleteFromDB('syncQueue', item.id);
        }
        failCount++;
      }
    }
    syncInProgressRef.value = false;
    if (needsAuthoritativeRefresh && !failCount) {
      await refreshFromServer({ wsState, syncInProgressRef });
    }
    console.log(`Sync complete: ${successCount} success, ${failCount} failed`);
  }

  async function refreshFromServer({ wsState, syncInProgressRef }) {
    if (!isOnlineForSync(wsState) || !getDb()) return;

    // Local offline edits must be pushed before any authoritative pull clears
    // and rewrites the local cache. Otherwise server state can visually or
    // persistently clobber queued local changes.
    const pendingQueue = await dbGetAll('syncQueue');
    if (pendingQueue.length && !syncInProgressRef.value) {
      await syncWithServer({ wsState, syncInProgressRef });
      const remainingQueue = await dbGetAll('syncQueue');
      if (remainingQueue.length) {
        console.warn('Skipping server refresh while local sync queue still has pending changes');
        return;
      }
    }

    const [todosData, projectsData, sectionsData, workspacesData] = await Promise.all([
      todosApi.list(), projectsApi.list(), sectionsApi.listAll(), workspacesApi.list(),
    ]);
    const nextTodos = todosData.todos || [];
    const nextProjects = projectsData.projects || [];
    const nextSections = sectionsData.sections || [];
    const nextWorkspaces = workspacesData.workspaces || [];

    // Server refresh is authoritative for the current user. Persist it so a
    // reload right after login does not fall back to an empty local cache.
    if (dbClear) {
      await Promise.all([dbClear('todos'), dbClear('projects'), dbClear('sections'), dbClear('workspaces')]);
    }
    await Promise.all([
      ...nextTodos.map(todo => dbPut('todos', todo)),
      ...nextProjects.map(project => dbPut('projects', project)),
      ...nextSections.map(section => dbPut('sections', section)),
      ...nextWorkspaces.map(workspace => dbPut('workspaces', workspace)),
    ]);

    setTodos(nextTodos);
    setProjects(nextProjects);
    setSections(nextSections);
    setWorkspaces(nextWorkspaces);
    syncInProgressRef.value = false;
  }

  return { isOnlineForSync, syncWithServer, refreshFromServer };
}
