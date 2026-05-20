export function createSyncFeature({
  getDb,
  dbGetAll,
  dbPut,
  getFromDB,
  deleteFromDB,
  getTodos,
  setTodos,
  getProjects,
  setProjects,
  getSections,
  setSections,
  todosApi,
  projectsApi,
  sectionsApi,
}) {
  function isOnlineForSync(wsState) {
    return wsState === 'connected' || (typeof navigator !== 'undefined' && navigator.onLine);
  }

  async function syncWithServer({ wsState, syncInProgressRef }) {
    if (!isOnlineForSync(wsState) || !getDb() || syncInProgressRef.value) return;
    syncInProgressRef.value = true;
    const queue = await dbGetAll('syncQueue');
    if (!queue.length) { syncInProgressRef.value = false; return; }

    let successCount = 0;
    let failCount = 0;
    for (const item of queue) {
      try {
        if (item.action === 'CREATE_TODO') {
          const res = await todosApi.create(item.data);
          if (item.data._tempId) {
            await deleteFromDB('todos', item.data._tempId);
            setTodos(getTodos().filter(t => t.id !== item.data._tempId));
          }
          await dbPut('todos', res);
          const withoutTemp = item.data._tempId ? getTodos().filter(t => t.id !== item.data._tempId) : getTodos();
          if (!withoutTemp.find(t => t.id === res.id)) setTodos([...withoutTemp, res]);
          else setTodos(withoutTemp.map(t => t.id === res.id ? res : t));
          successCount++;
        } else if (item.action === 'UPDATE_TODO') {
          await todosApi.update(item.data.id, item.data.changes);
          const localTodo = await getFromDB('todos', item.data.id);
          if (localTodo) await dbPut('todos', { ...localTodo, ...item.data.changes, updated_at: new Date().toISOString() });
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
          await projectsApi.delete(item.data.id);
          await deleteFromDB('projects', item.data.id);
          successCount++;
        } else if (item.action === 'UPDATE_PROJECT') {
          await projectsApi.update(item.data.id, item.data.changes);
          const localProject = await getFromDB('projects', item.data.id);
          if (localProject) await dbPut('projects', { ...localProject, ...item.data.changes, updated_at: new Date().toISOString() });
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
        failCount++;
      }
    }
    syncInProgressRef.value = false;
    console.log(`Sync complete: ${successCount} success, ${failCount} failed`);
  }

  async function refreshFromServer({ wsState, syncInProgressRef }) {
    if (!isOnlineForSync(wsState) || !getDb()) return;
    const [todosData, projectsData, sectionsData] = await Promise.all([
      todosApi.list(), projectsApi.list(), sectionsApi.listAll(),
    ]);
    setTodos(todosData.todos || []);
    setProjects(projectsData.projects || []);
    setSections(sectionsData.sections || []);
    syncInProgressRef.value = false;
  }

  return { isOnlineForSync, syncWithServer, refreshFromServer };
}
