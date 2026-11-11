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
  onAuthoritativeRefreshCommitted = () => {},
}) {
  function isOnlineForSync() {
    return syncFeature.isOnlineForSync(getWsState());
  }

  async function syncWithServer() {
    await updateConnectionStatusView(getWsState());
    const result = await syncFeature.syncWithServer({ wsState: getWsState(), syncInProgressRef });
    setSyncInProgress(syncInProgressRef.value);
    await updateConnectionStatusView(getWsState());
    return result;
  }

  async function refreshFromServer() {
    await updateConnectionStatusView(getWsState());
    const result = await syncFeature.refreshFromServer({ wsState: getWsState(), syncInProgressRef });
    setSyncInProgress(syncInProgressRef.value);
    await updateConnectionStatusView(getWsState());
    ensureCurrentWorkspace();
    renderWorkspaces();
    renderProjects();
    renderStats();
    renderTodos();
    if (result?.refreshed) onAuthoritativeRefreshCommitted(result);
    return result;
  }

  return {
    isOnlineForSync,
    syncWithServer,
    refreshFromServer,
  };
}
