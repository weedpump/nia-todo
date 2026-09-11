const objectUrls = new WeakMap();

export async function loadAuthenticatedImage(img, url) {
  if (!img || !url) return false;
  const token = localStorage.getItem('jwt_token');
  if (!token) return false;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return false;
  const previous = objectUrls.get(img);
  if (previous) URL.revokeObjectURL(previous);
  const objectUrl = URL.createObjectURL(await response.blob());
  objectUrls.set(img, objectUrl);
  img.src = objectUrl;
  return true;
}
