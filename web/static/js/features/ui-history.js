const UI_STATE_KEY = 'niaTodoUi';
const CLOSE_FALLBACK_DELAY_MS = 250;

function cleanAppRoute(location) {
  return `${String(location?.pathname || '/')}${String(location?.search || '')}`;
}

export function createUiHistory({
  window = globalThis.window,
  history = globalThis.history,
  location = globalThis.location,
  document = globalThis.document,
} = {}) {
  const closeHandlers = new Map();
  const pendingCloses = new Map();
  const ignoredClosures = new Set();
  let currentLayers = [];
  let bound = false;

  function layerIdForElement(element) {
    if (!element?.id) return '';
    if (element.classList?.contains('modal')) return element.id;
    if (element.id === 'sidebar') return 'sidebar';
    if (element.id === 'search-box') return 'mobile-search';
    if (element.id === 'user-menu') return 'user-menu';
    return '';
  }

  function elementIsOpen(element) {
    if (element?.classList?.contains('modal') || element?.id === 'user-menu') return element.classList.contains('active');
    return element?.classList?.contains('open') || false;
  }

  function elementForLayer(id) {
    const elementId = id === 'mobile-search' ? 'search-box' : id;
    return document?.getElementById?.(elementId) || null;
  }

  function stateLayers(state = history?.state) {
    const layers = state?.[UI_STATE_KEY]?.layers;
    return Array.isArray(layers) ? layers.map(String) : [];
  }

  function layersOpenInDom(layers) {
    if (!document?.getElementById) return [...layers];
    return layers.filter(id => elementIsOpen(elementForLayer(id)));
  }

  function nextState(layers) {
    return {
      ...(history?.state || {}),
      [UI_STATE_KEY]: { layers: [...layers] },
    };
  }

  function fallbackClose(id) {
    const element = document?.getElementById?.(id);
    element?.classList?.remove?.('active', 'open', 'show');
    element?.setAttribute?.('aria-hidden', 'true');
  }

  function takePendingClose(id) {
    const pending = pendingCloses.get(id);
    pendingCloses.delete(id);
    if (pending?.fallbackTimer != null) globalThis.clearTimeout?.(pending.fallbackTimer);
    return pending;
  }

  function closeRemovedLayers(previousLayers, targetLayers) {
    let shared = 0;
    while (
      shared < previousLayers.length
      && shared < targetLayers.length
      && previousLayers[shared] === targetLayers[shared]
    ) shared += 1;

    const removed = previousLayers.slice(shared).reverse();
    for (const id of removed) {
      const pending = takePendingClose(id);
      const payload = pending?.payload ?? { reason: 'history' };
      const handler = closeHandlers.get(id);
      ignoredClosures.add(id);
      if (handler) handler(payload);
      else fallbackClose(id);
      pending?.afterClose?.();
      globalThis.setTimeout?.(() => ignoredClosures.delete(id), 0);
    }
  }

  function onPopState(event) {
    const requestedLayers = stateLayers(event?.state);
    const targetLayers = layersOpenInDom(requestedLayers);
    const previousLayers = currentLayers;
    currentLayers = targetLayers;
    if (targetLayers.length !== requestedLayers.length) {
      history?.replaceState?.(nextState(targetLayers), '', cleanAppRoute(location));
    }
    closeRemovedLayers(previousLayers, targetLayers);
  }

  function closeThroughLayer(layerId) {
    const index = currentLayers.lastIndexOf(layerId);
    if (index === -1) return false;
    const previousLayers = currentLayers;
    currentLayers = currentLayers.slice(0, index);
    history?.replaceState?.(nextState(currentLayers), '', cleanAppRoute(location));
    closeRemovedLayers(previousLayers, currentLayers);
    return true;
  }

  function reconcilePersistedLayers() {
    const persistedLayers = stateLayers();
    currentLayers = layersOpenInDom(persistedLayers);
    history?.replaceState?.(nextState(currentLayers), '', cleanAppRoute(location));
  }

  function bind() {
    if (bound || !window?.addEventListener || !history?.replaceState) return;
    bound = true;
    reconcilePersistedLayers();
    window.addEventListener('popstate', onPopState);
    window.addEventListener('pageshow', reconcilePersistedLayers);
    if (document?.documentElement && globalThis.MutationObserver) {
      const observer = new globalThis.MutationObserver((records) => {
        for (const record of records) {
          const id = layerIdForElement(record.target);
          if (!id) continue;
          const wasOpen = String(record.oldValue || '').split(/\s+/).some(name => name === 'active' || name === 'open');
          const isOpen = elementIsOpen(record.target);
          if (!wasOpen && isOpen) {
            openLayer(id);
          } else if (wasOpen && !isOpen) {
            if (ignoredClosures.delete(id)) continue;
            requestCloseLayer(id, { reason: 'ui-observed' });
          }
        }
      });
      observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    }
  }

  function registerLayer(id, closeHandler) {
    if (!id || typeof closeHandler !== 'function') return () => {};
    closeHandlers.set(String(id), closeHandler);
    return () => closeHandlers.delete(String(id));
  }

  function openLayer(id) {
    if (!id || !history?.pushState) return false;
    bind();
    const layerId = String(id);
    if (currentLayers.at(-1) === layerId) return false;
    currentLayers = [...currentLayers.filter(layer => layer !== layerId), layerId];
    history.pushState(nextState(currentLayers), '', cleanAppRoute(location));
    return true;
  }

  function requestCloseLayer(id, payload = { reason: 'ui' }, { afterClose = null } = {}) {
    if (!id || !history?.back) return false;
    bind();
    const layerId = String(id);
    const layerIndex = currentLayers.lastIndexOf(layerId);
    if (layerIndex === -1) return false;
    if (pendingCloses.has(layerId)) return true;
    const distance = currentLayers.length - layerIndex;
    if (distance > 1 && typeof history.go !== 'function') return false;
    const pending = {
      payload,
      afterClose: typeof afterClose === 'function' ? afterClose : null,
      fallbackTimer: null,
    };
    pendingCloses.set(layerId, pending);
    pending.fallbackTimer = globalThis.setTimeout?.(() => {
      if (pendingCloses.get(layerId) !== pending) return;
      closeThroughLayer(layerId);
    }, CLOSE_FALLBACK_DELAY_MS);
    if (distance === 1) history.back();
    else history.go(-distance);
    return true;
  }

  function replaceLayer(fromId, toId) {
    if (!fromId || !toId || !history?.replaceState) return false;
    bind();
    if (currentLayers.at(-1) !== String(fromId)) return false;
    currentLayers = [...currentLayers.slice(0, -1), String(toId)];
    history.replaceState(nextState(currentLayers), '', cleanAppRoute(location));
    return true;
  }

  function closeLayerNow(id, payload = { reason: 'programmatic' }) {
    const layerId = String(id || '');
    const index = currentLayers.lastIndexOf(layerId);
    if (index === -1) return false;
    const pending = takePendingClose(layerId);
    currentLayers = currentLayers.slice(0, index);
    history?.replaceState?.(nextState(currentLayers), '', cleanAppRoute(location));
    const handler = closeHandlers.get(layerId);
    if (handler) handler(payload);
    else fallbackClose(layerId);
    pending?.afterClose?.();
    return true;
  }

  function hasOpenLayer() {
    return currentLayers.length > 0;
  }

  return {
    bind,
    registerLayer,
    openLayer,
    replaceLayer,
    requestCloseLayer,
    closeLayerNow,
    hasOpenLayer,
    getLayers: () => [...currentLayers],
  };
}

let defaultUiHistory = null;

function getDefaultUiHistory() {
  if (!defaultUiHistory) defaultUiHistory = createUiHistory();
  return defaultUiHistory;
}

export const bindUiHistory = () => getDefaultUiHistory().bind();
export const registerUiLayer = (...args) => getDefaultUiHistory().registerLayer(...args);
export const openUiLayer = (...args) => getDefaultUiHistory().openLayer(...args);
export const replaceUiLayer = (...args) => getDefaultUiHistory().replaceLayer(...args);
export const requestCloseUiLayer = (...args) => getDefaultUiHistory().requestCloseLayer(...args);
export const closeUiLayerNow = (...args) => getDefaultUiHistory().closeLayerNow(...args);
export const hasOpenUiLayer = () => getDefaultUiHistory().hasOpenLayer();
