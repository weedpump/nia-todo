export function createSyncController({
  syncFeature,
  syncInProgressRef,
  getWsState,
  updateConnectionStatusView,
  setSyncInProgress,
  ensureCurrentWorkspace,
  renderWorkspaces,
  renderProjects,
  renderStats,
  renderTodos,
}) {
  function isOnlineForSync() {
    return syncFeature.isOnlineForSync(getWsState());
  }

  async function syncWithServer() {
    await updateConnectionStatusView(getWsState());
    await syncFeature.syncWithServer({ wsState: getWsState(), syncInProgressRef });
    setSyncInProgress(syncInProgressRef.value);
    await updateConnectionStatusView(getWsState());
  }

  async function refreshFromServer() {
    await updateConnectionStatusView(getWsState());
    await syncFeature.refreshFromServer({ wsState: getWsState(), syncInProgressRef });
    setSyncInProgress(syncInProgressRef.value);
    await updateConnectionStatusView(getWsState());
    ensureCurrentWorkspace();
    renderWorkspaces();
    renderProjects();
    renderStats();
    renderTodos();
  }

  return {
    isOnlineForSync,
    syncWithServer,
    refreshFromServer,
  };
}
