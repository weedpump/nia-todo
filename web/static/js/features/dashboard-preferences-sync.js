const ENABLED_KEY = 'nia-dashboard-preferences-sync-enabled';
const PENDING_KEY = 'nia-dashboard-preferences-sync-pending';

export function createDashboardPreferencesSync({
  api,
  storage = globalThis.localStorage,
  getUserId = () => null,
  getWorkspaces = () => [],
  getPreferences,
  setPreferences,
  renderDashboard = () => {},
}) {
  let enabled = false;

  function scopedKey(key) {
    const userId = getUserId?.();
    return `${key}:user:${userId ?? 'anonymous'}`;
  }

  function persistEnabled(value) {
    enabled = Boolean(value);
    if (enabled) storage?.setItem?.(scopedKey(ENABLED_KEY), 'true');
    else storage?.removeItem?.(scopedKey(ENABLED_KEY));
  }

  function readPending() {
    try {
      return JSON.parse(storage?.getItem?.(scopedKey(PENDING_KEY)) || 'null');
    } catch {
      return null;
    }
  }

  function writePending(payload) {
    storage?.setItem?.(scopedKey(PENDING_KEY), JSON.stringify(payload));
  }

  function mergePending(payload) {
    const current = readPending();
    if (!payload.enabled) return { enabled: false };
    return {
      enabled: true,
      preferences: {
        ...(current?.enabled ? current.preferences : {}),
        ...(payload.preferences || {}),
      },
    };
  }

  function applyRemote(payload) {
    if (!payload || typeof payload !== 'object') return;
    persistEnabled(Boolean(payload.enabled));
    if (payload.enabled && payload.preferences && typeof payload.preferences === 'object') {
      Object.entries(payload.preferences).forEach(([workspaceId, preferences]) => {
        setPreferences?.(workspaceId, preferences);
      });
      renderDashboard?.();
    }
  }

  async function flushPending() {
    const pending = readPending();
    if (!pending) return true;
    try {
      const response = await api.updateDashboardPreferences(pending);
      storage?.removeItem?.(scopedKey(PENDING_KEY));
      applyRemote(response);
      return true;
    } catch {
      return false;
    }
  }

  async function initialize() {
    enabled = storage?.getItem?.(scopedKey(ENABLED_KEY)) === 'true';
    const flushed = await flushPending();
    if (!flushed) return;
    try {
      applyRemote(await api.getDashboardPreferences());
    } catch {
      // Keep the local cache usable while offline.
    }
  }

  async function setEnabled(nextEnabled) {
    persistEnabled(nextEnabled);
    const payload = nextEnabled
      ? {
          enabled: true,
          preferences: Object.fromEntries((getWorkspaces?.() || []).map(workspace => [
            String(workspace.id),
            getPreferences?.(workspace.id),
          ]).filter(([, preferences]) => preferences)),
        }
      : { enabled: false };
    writePending(payload);
    await flushPending();
  }

  async function saveWorkspace(workspaceId, preferences) {
    if (!enabled) return;
    writePending(mergePending({ enabled: true, preferences: { [String(workspaceId)]: preferences } }));
    await flushPending();
  }

  return {
    applyRemote,
    flushPending,
    initialize,
    isEnabled: () => enabled,
    saveWorkspace,
    setEnabled,
  };
}
