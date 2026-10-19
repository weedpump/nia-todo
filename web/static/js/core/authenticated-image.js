import { authenticatedFetch, getAuthHeaders } from '../api/http.js';
import {
  getAvatarIfReady,
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

const indexedDbAvatarCache = {
  get: id => getAvatarIfReady(id),
  getWhenReady: id => getAvatarWhenReady(id),
  put: (record, isCurrent, expectedGeneration) => putAvatarWhenReady(record, isCurrent, expectedGeneration),
  remove: id => removeAvatarWhenReady(id),
};

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

export async function removeCachedAvatar(url, { userId, cache = indexedDbAvatarCache } = {}) {
  const id = avatarCacheKey(url, userId);
  if (id) {
    invalidateCacheGeneration(id);
    await cache.remove(id);
  }
}

export async function loadAuthenticatedImage(img, url, {
  userId = null,
  version = '',
  cache = indexedDbAvatarCache,
} = {}) {
  if (!img || !url) return false;
  const databaseGeneration = getDatabaseGeneration();
  const id = avatarCacheKey(url, userId);
  const cacheVersion = String(version || '');
  const cacheGeneration = selectCacheGeneration(id, cacheVersion);
  const isCurrent = () => isCurrentCacheGeneration(id, cacheVersion, cacheGeneration);
  const imageKey = id && cacheVersion ? `${id}|${cacheVersion}` : String(url);
  if (imageKeys.get(img) === imageKey && objectUrls.has(img)) return true;

  const loadToken = {};
  activeLoads.set(img, loadToken);
  if (id && cacheVersion) {
    const cached = await cache.get(id);
    if (activeLoads.get(img) !== loadToken || !isCurrent()) return false;
    if (cached?.version === cacheVersion && cached.blob) {
      showBlob(img, cached.blob, imageKey);
      return true;
    }
  }

  const headers = getAuthHeaders();
  if (!headers.Authorization && !headers['X-Session-Token']) return false;
  const loadDeferredCachedAvatar = async () => {
    if (!id || !cacheVersion || !cache.getWhenReady) return false;
    const cached = await cache.getWhenReady(id);
    if (activeLoads.get(img) !== loadToken || !isCurrent()) return false;
    if (cached?.version !== cacheVersion || !cached.blob) return false;
    showBlob(img, cached.blob, imageKey);
    return true;
  };
  try {
    const fetchKey = id && cacheVersion ? imageKey : '';
    let blobPromise = fetchKey ? inFlightFetches.get(fetchKey) : null;
    if (!blobPromise) {
      blobPromise = (async () => {
        const response = await authenticatedFetch(url, { headers, credentials: 'include', cache: 'no-store' });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (id && cacheVersion) {
          if (!isCurrent()) return null;
          await cache.put({ id, version: cacheVersion, blob }, isCurrent, databaseGeneration);
          if (!isCurrent()) return null;
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
    if (activeLoads.get(img) !== loadToken || (id && cacheVersion && !isCurrent())) return false;
    showBlob(img, blob, imageKey);
    return true;
  } catch (_error) {
    return loadDeferredCachedAvatar();
  }
}
