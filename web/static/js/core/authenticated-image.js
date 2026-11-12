import { getAuthHeaders } from '../api/http.js';
import {
  getAvatarWhenReady,
  getDatabaseGeneration,
  putAvatarWhenReady,
  removeAvatarWhenReady,
} from '../storage/indexed-db.js';

const objectUrls = new WeakMap();
const imageKeys = new WeakMap();
const activeLoads = new WeakMap();
const inFlightFetches = new Map();
const cacheGenerations = new Map();
let readyAvatar = null;

const indexedDbAvatarCache = {
  get: id => getAvatarWhenReady(id),
  getWhenReady: id => getAvatarWhenReady(id),
  put: (record, isCurrent, expectedGeneration) => putAvatarWhenReady(record, isCurrent, expectedGeneration),
  remove: (id, isCurrent, expectedGeneration) => removeAvatarWhenReady(id, isCurrent, expectedGeneration),
};

function rememberAvatar(cache, id, version, blob, databaseGeneration) {
  if (cache !== indexedDbAvatarCache || !id || !version || databaseGeneration !== getDatabaseGeneration()) return;
  // One bounded, generation-fenced handoff from the early menu/settings load to
  // the dashboard's first render. IndexedDB remains the persistent source.
  readyAvatar = { id, version, blob, databaseGeneration, cacheGeneration: cacheGenerations.get(id)?.generation };
}

function selectCacheGeneration(id, version) {
  if (!id || !version) return 0;
  const current = cacheGenerations.get(id);
  if (current?.version === version) return current.generation;
  const generation = (current?.generation || 0) + 1;
  cacheGenerations.set(id, { version, generation });
  return generation;
}

function isCurrentCacheGeneration(id, version, generation) {
  const current = cacheGenerations.get(id);
  return current?.version === version && current.generation === generation;
}

function invalidateCacheGeneration(id) {
  const current = cacheGenerations.get(id);
  cacheGenerations.set(id, { version: null, generation: (current?.generation || 0) + 1 });
}

function avatarCacheKey(url, userId) {
  if (userId === null || userId === undefined || userId === '') return '';
  try {
    return `${new URL(url, location.origin).origin.toLowerCase()}|${String(userId)}`;
  } catch (_error) {
    return '';
  }
}

function showBlob(img, blob, key) {
  releaseAuthenticatedImage(img);
  const objectUrl = URL.createObjectURL(blob);
  objectUrls.set(img, objectUrl);
  imageKeys.set(img, key);
  img.src = objectUrl;
}

export function releaseAuthenticatedImage(img) {
  activeLoads.delete(img);
  imageKeys.delete(img);
  const objectUrl = objectUrls.get(img);
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrls.delete(img);
}

export async function removeCachedAvatar(url, {
  userId, version = null, isCurrent = () => true,
  expectedGeneration = getDatabaseGeneration(), cache = indexedDbAvatarCache,
} = {}) {
  const id = avatarCacheKey(url, userId);
  if (id) {
    if (expectedGeneration !== getDatabaseGeneration() || !isCurrent()
      || (version !== null && cacheGenerations.get(id)?.version !== String(version))) return false;
    if (readyAvatar?.id === id) readyAvatar = null;
    invalidateCacheGeneration(id);
    const removalGeneration = cacheGenerations.get(id).generation;
    await cache.remove(id, () => expectedGeneration === getDatabaseGeneration() && isCurrent()
      && cacheGenerations.get(id)?.generation === removalGeneration, expectedGeneration);
    return true;
  }
  return false;
}

export async function loadAuthenticatedImage(img, url, {
  userId = null,
  version = '',
  cache = indexedDbAvatarCache,
  cacheKey = null,
  isCurrent: isConsumerCurrent = () => true,
  isAccessible = () => true,
  onDenied = null,
} = {}) {
  if (!img || !url || !isConsumerCurrent() || !isAccessible()) return false;
  const databaseGeneration = getDatabaseGeneration();
  if (readyAvatar?.databaseGeneration !== databaseGeneration) readyAvatar = null;
  const id = cacheKey ?? avatarCacheKey(url, userId);
  const cacheVersion = String(version || '');
  const cacheGeneration = selectCacheGeneration(id, cacheVersion);
  const isCurrent = () => isAccessible() && isCurrentCacheGeneration(id, cacheVersion, cacheGeneration);
  const imageKey = id && cacheVersion
    ? `${databaseGeneration}|${id}|${cacheVersion}|${cacheGeneration}`
    : `${databaseGeneration}|${id}|${String(url)}`;
  if (imageKeys.get(img) === imageKey && objectUrls.has(img)) return true;

  const loadToken = {};
  activeLoads.set(img, loadToken);
  if (cache === indexedDbAvatarCache && readyAvatar?.id === id && readyAvatar.version === cacheVersion
    && readyAvatar.cacheGeneration === cacheGeneration) {
    showBlob(img, readyAvatar.blob, imageKey);
    return true;
  }
  if (id && cacheVersion) {
    let cached = null;
    try { cached = await cache.get(id); } catch (_error) { /* Unavailable local storage falls back to the server. */ }
    if (databaseGeneration !== getDatabaseGeneration()) return false;
    if (activeLoads.get(img) !== loadToken || !isConsumerCurrent() || !isCurrent()) return false;
    if (cached?.version === cacheVersion && cached.blob) {
      rememberAvatar(cache, id, cacheVersion, cached.blob, databaseGeneration);
      showBlob(img, cached.blob, imageKey);
      return true;
    }
  }

  const headers = getAuthHeaders();
  if (!headers.Authorization && !headers['X-Session-Token']) return false;
  const loadDeferredCachedAvatar = async () => {
    if (!id || !cacheVersion || !cache.getWhenReady) return false;
    const cached = await cache.getWhenReady(id);
    if (activeLoads.get(img) !== loadToken || !isConsumerCurrent() || !isCurrent()) return false;
    if (cached?.version !== cacheVersion || !cached.blob) return false;
    rememberAvatar(cache, id, cacheVersion, cached.blob, databaseGeneration);
    showBlob(img, cached.blob, imageKey);
    return true;
  };
  try {
    const fetchKey = id && cacheVersion ? imageKey : '';
    let blobPromise = fetchKey ? inFlightFetches.get(fetchKey) : null;
    if (!blobPromise) {
      blobPromise = (async () => {
        const response = await fetch(url, { headers, credentials: 'include', cache: 'no-store' });
        if (!response.ok) {
          if (onDenied && [401, 403, 404].includes(response.status) && isCurrent()) {
            await onDenied(response.status, {
              isCurrent,
              isConsumerCurrent: () => activeLoads.get(img) === loadToken && isConsumerCurrent(),
            });
            if (id && isCurrent()) invalidateCacheGeneration(id);
          }
          return null;
        }
        const blob = await response.blob();
        if (id && cacheVersion) {
          if (!isCurrent()) return null;
          await cache.put({ id, version: cacheVersion, blob }, isCurrent, databaseGeneration);
          if (!isCurrent()) return null;
          rememberAvatar(cache, id, cacheVersion, blob, databaseGeneration);
        }
        return blob;
      })();
      if (fetchKey) {
        inFlightFetches.set(fetchKey, blobPromise);
        blobPromise.then(
          () => inFlightFetches.delete(fetchKey),
          () => inFlightFetches.delete(fetchKey),
        );
      }
    }
    const blob = await blobPromise;
    if (!blob) return loadDeferredCachedAvatar();
    if (activeLoads.get(img) !== loadToken || !isConsumerCurrent() || (id && cacheVersion && !isCurrent())) return false;
    showBlob(img, blob, imageKey);
    return true;
  } catch (_error) {
    return loadDeferredCachedAvatar();
  }
}
