import { getAuthHeaders } from '../api/http.js';

const objectUrls = new WeakMap();

export function releaseAuthenticatedImage(img) {
  const objectUrl = objectUrls.get(img);
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrls.delete(img);
}

export async function loadAuthenticatedImage(img, url) {
  if (!img || !url) return false;
  const headers = getAuthHeaders();
  if (!headers.Authorization && !headers['X-Session-Token']) return false;
  let response;
  try {
    response = await fetch(url, { headers, credentials: 'include' });
    if (!response.ok) return false;
    releaseAuthenticatedImage(img);
    const objectUrl = URL.createObjectURL(await response.blob());
    objectUrls.set(img, objectUrl);
    img.src = objectUrl;
    return true;
  } catch (_error) {
    return false;
  }
}
