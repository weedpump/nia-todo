export async function runAndroidUpdateBridgeAction(action, onError) {
  try {
    return await action();
  } catch (error) {
    await onError(error);
    return { status: 'error', error };
  }
}

export function createAndroidUpdateResumeCoordinator(resume, refresh) {
  let inFlight = null;
  return function coordinateAndroidUpdateResume() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const result = await resume();
      if (result?.skipRefresh) return result;
      await refresh();
      return result;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
}

export function createAndroidUpdatePermissionFlow(nativeBridge) {
  let pendingUpdate = null;

  async function permissionState() {
    return String(await nativeBridge?.androidUpdatePermissionState?.() || 'unsupported');
  }

  async function continuePending() {
    if (!pendingUpdate) return { status: 'idle', installed: false };
    if (await permissionState() !== 'granted') return { status: 'permission-required', installed: false };
    const { download, onProgress } = pendingUpdate;
    pendingUpdate = null;
    const installPromise = Promise.resolve(nativeBridge.installAndroidUpdate(download, onProgress));
    return { status: 'started', installPromise };
  }

  return {
    async start(download, onProgress = () => {}) {
      pendingUpdate = { download, onProgress };
      return continuePending();
    },
    async openPermissionSettings() {
      if (!pendingUpdate) return false;
      return Boolean(await nativeBridge?.openAndroidUpdatePermissionSettings?.());
    },
    resume: continuePending,
    hasPendingUpdate() {
      return Boolean(pendingUpdate);
    },
    cancel() {
      pendingUpdate = null;
    },
  };
}
