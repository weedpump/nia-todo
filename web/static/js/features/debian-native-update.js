export async function installDebianNativeUpdate(nativeBridge, download, onProgress = () => {}) {
  if (!nativeBridge?.installDebianUpdate) throw new Error('Debian update bridge is unavailable');
  const unlisten = await nativeBridge.listenNativeUpdateProgress?.(onProgress);
  try {
    return await nativeBridge.installDebianUpdate(download);
  } finally {
    if (typeof unlisten === 'function') unlisten();
  }
}
