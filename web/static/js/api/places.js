import { http } from './http.js';

export const placesApi = {
  list: () => http.get('/api/places'),
  create: (data) => http.post('/api/places', data),
  update: (placeId, changes) => http.patch(`/api/places/${placeId}`, changes),
  delete: (placeId) => http.del(`/api/places/${placeId}`),
};
