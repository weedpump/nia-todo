import { http } from './http.js';

export const todosApi = {
  list: () => http.get('/api/todos'),
  create: (data) => http.post('/api/todos', data),
  update: (todoId, changes) => http.patch(`/api/todos/${todoId}`, changes),
  delete: (todoId) => http.del(`/api/todos/${todoId}`),
};
