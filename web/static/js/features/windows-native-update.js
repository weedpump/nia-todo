export async function installWindowsNativeUpdate(nativeBridge, onProgress = () => {}) {
  if (!nativeBridge?.installUpdate) throw new Error('Windows update bridge is unavailable');
  const unlisten = await nativeBridge.listenNativeUpdateProgress?.(onProgress);
  try {
    return await nativeBridge.installUpdate();
  } finally {
    if (typeof unlisten === 'function') unlisten();
  }
}
