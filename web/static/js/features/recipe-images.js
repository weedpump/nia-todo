import { rasterImageDimensions } from '../core/raster-image.js';
import { apiResourceUrl } from '../core/config.js';
import { loadAuthenticatedImage, releaseAuthenticatedImage } from '../core/authenticated-image.js';
import { acquireSyncCommitLock } from './todo-pending.js';
import { sameEntityId } from './entity-metadata.js';
import { getDatabaseGeneration, getEntityImageIfReady, getEntityImageWhenReady,
  putEntityImageWhenReady, removeEntityImageWhenReady } from '../storage/indexed-db.js';

const IMAGE_LIMIT = 300 * 1024;
const PIXEL_LIMIT = 16 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });

/** Prepare one bounded title image before it enters the durable aggregate queue. */
export async function prepareRecipeImage(file) {
  if (!file || !/^image\/(jpeg|png|webp)$/i.test(file.type || '')) throw fail('recipe.image.invalid');
  if (file.size > 20 * 1024 * 1024) throw fail('recipe.image.tooLarge');
  try {
    const dimensions = rasterImageDimensions(await file.arrayBuffer());
    if (dimensions.some(({ width, height }) => width * height > PIXEL_LIMIT)) throw fail('recipe.image.tooLarge');
  } catch (error) { throw error?.code === 'recipe.image.tooLarge' ? error : fail('recipe.image.invalid'); }
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = objectUrl;
    await image.decode();
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > PIXEL_LIMIT) throw fail('recipe.image.tooLarge');
    const canvas = document.createElement('canvas');
    let blob = null;
    for (const edge of [1280, 1024, 768, 512]) {
      const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw fail('recipe.image.invalid');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [.85, .7, .55]) {
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob && blob.size <= IMAGE_LIMIT) break;
      }
      if (blob && blob.size <= IMAGE_LIMIT) break;
    }
    if (!blob || !/^image\/(webp|png|jpeg)$/.test(blob.type)) throw fail('recipe.image.invalid');
    if (blob.size > IMAGE_LIMIT) throw fail('recipe.image.tooLarge');
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(fail('recipe.image.invalid'));
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    throw error?.code?.startsWith?.('recipe.image.') ? error : fail('recipe.image.invalid');
  } finally { URL.revokeObjectURL(objectUrl); }
}

/** Reuse the authenticated image loader with an entity-scoped private cache. */
export function createRecipeImagesFeature({ getCookbooks = () => [], getCurrentUser = () => null,
  getSessionIdentity = () => null, syncInProgressRef } = {}) {
  function release(img) {
    releaseAuthenticatedImage(img);
    img?.removeAttribute?.('src');
  }
  async function load(img, recipe, { isCurrent = () => true, draft = false } = {}) {
    const session = getSessionIdentity();
    const userId = getCurrentUser()?.id;
    const databaseGeneration = getDatabaseGeneration();
    const version = String(recipe?.image_version || '');
    const requestedUrl = Object.hasOwn(recipe || {}, 'image_data') ? recipe.image_data : recipe?.image_url;
    const isLocalImage = typeof requestedUrl === 'string' && requestedUrl.length <= 430000
      && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(requestedUrl);
    const allowed = () => {
      if (session == null || userId == null || session !== getSessionIdentity()) return false;
      const book = getCookbooks().find(book => sameEntityId(book.id, recipe?.cookbook_id));
      if (draft && isLocalImage) return book?.can_edit === true || book?.can_edit === 1;
      const current = book?.recipes?.find(candidate => sameEntityId(candidate.id, recipe?.id));
      return Boolean(current && String(current.image_version || '') === version && (Object.hasOwn(current, 'image_data') ? current.image_data : current.image_url) === requestedUrl);
    };
    if (!img) return false;
    if (!requestedUrl || !isCurrent() || !allowed()) { release(img); return false; }
    if (isLocalImage) {
      if (img.src !== requestedUrl) { release(img); img.src = requestedUrl; }
      return true;
    }
    if (!/^\/api\/recipes\/recipes\/\d+\/image(?:\?v=[a-f0-9]{64})?$/.test(requestedUrl) || !version) { release(img); return false; }
    const url = apiResourceUrl(requestedUrl);
    const key = `recipe|${new URL(url, location.origin).origin.toLowerCase()}|${userId}|${recipe.cookbook_id}|${recipe.id}`;
    const cache = {
      get: async id => allowed() ? getEntityImageIfReady(id) : null,
      getWhenReady: async id => allowed() ? getEntityImageWhenReady(id) : null,
      put: async (record, loaderIsCurrent, generation) => {
        const release = await acquireSyncCommitLock(syncInProgressRef);
        try {
          if (!allowed() || !loaderIsCurrent() || generation !== getDatabaseGeneration()) return;
          await putEntityImageWhenReady({ ...record, cookbook_id: recipe.cookbook_id, recipe_id: recipe.id, user_id: userId },
            () => allowed() && loaderIsCurrent(), generation);
        } finally { release(); }
      },
      remove: id => removeEntityImageWhenReady(id),
    };
    return loadAuthenticatedImage(img, url, { userId, version, cache, cacheKey: key, isCurrent, isAccessible: allowed,
      onDenied: async (_status, origin) => {
        const releaseLock = await acquireSyncCommitLock(syncInProgressRef);
        try {
          if (!origin.isCurrent() || session !== getSessionIdentity() || databaseGeneration !== getDatabaseGeneration()) return;
          await removeEntityImageWhenReady(key);
          if (origin.isConsumerCurrent()) release(img);
        } finally { releaseLock(); }
      },
    });
  }
  return { load, release };
}
