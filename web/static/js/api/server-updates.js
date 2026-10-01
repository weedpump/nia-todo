import { http } from './http.js';

export const serverUpdatesApi = {
  status: () => http.get('/server-update'),
};
