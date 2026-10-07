const ENABLED_KEY = 'nia-dashboard-preferences-sync-enabled';
const PENDING_KEY = 'nia-dashboard-preferences-sync-pending';
const TERMINAL_PENDING_STATUSES = new Set([400, 404, 422]);
const FLUSH_OK = 'ok';
const FLUSH_TRANSIENT = 'transient';
const FLUSH_TERMINAL = 'terminal';

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
  let flushPromise = null;
  let stateGeneration = 0;

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
    stateGeneration += 1;
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
    if (!payload || typeof payload !== 'object') return false;
    if (storage?.getItem?.(scopedKey(PENDING_KEY))) return false;
    persistEnabled(Boolean(payload.enabled));
    if (payload.enabled && payload.preferences && typeof payload.preferences === 'object') {
      Object.entries(payload.preferences).forEach(([workspaceId, preferences]) => {
        setPreferences?.(workspaceId, preferences);
      });
      renderDashboard?.();
    }
    stateGeneration += 1;
    return true;
  }

  function flushPending() {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      while (true) {
        const key = scopedKey(PENDING_KEY);
        const pendingRaw = storage?.getItem?.(key);
        if (!pendingRaw) return FLUSH_OK;
        let pending;
        try {
          pending = JSON.parse(pendingRaw);
        } catch {
          storage?.removeItem?.(key);
          continue;
        }
        try {
          const response = await api.updateDashboardPreferences(pending);
          if (storage?.getItem?.(key) === pendingRaw) {
            storage?.removeItem?.(key);
            applyRemote(response);
          }
        } catch (error) {
          if (TERMINAL_PENDING_STATUSES.has(Number(error?.status))) {
            if (storage?.getItem?.(key) === pendingRaw) {
              storage?.removeItem?.(key);
              return FLUSH_TERMINAL;
            }
            continue;
          }
          return FLUSH_TRANSIENT;
        }
      }
    })().finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  async function refresh() {
    const flushResult = await flushPending();
    if (flushResult === FLUSH_TRANSIENT) return false;
    const generation = stateGeneration;
    try {
      const payload = await api.getDashboardPreferences();
      if (generation !== stateGeneration) return false;
      applyRemote(payload);
      return true;
    } catch {
      return false;
    }
  }

  async function initialize() {
    enabled = storage?.getItem?.(scopedKey(ENABLED_KEY)) === 'true';
    await refresh();
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
    const flushResult = await flushPending();
    if (flushResult === FLUSH_TERMINAL) await refresh();
  }

  async function saveWorkspace(workspaceId, preferences) {
    if (!enabled) return;
    writePending(mergePending({ enabled: true, preferences: { [String(workspaceId)]: preferences } }));
    const flushResult = await flushPending();
    if (flushResult === FLUSH_TERMINAL) await refresh();
  }

  return {
    applyRemote,
    flushPending,
    initialize,
    isEnabled: () => enabled,
    refresh,
    saveWorkspace,
    setEnabled,
  };
}
