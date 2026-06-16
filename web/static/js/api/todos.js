import { http } from './http.js';

export const todosApi = {
  list: () => http.get('/api/todos'),
  create: (data) => http.post('/api/todos', data),
  update: (todoId, changes) => http.patch(`/api/todos/${todoId}`, changes),
  createSubtask: (todoId, data) => http.post(`/api/todos/${todoId}/subtasks`, data),
  updateSubtask: (todoId, subtaskId, data) => http.patch(`/api/todos/${todoId}/subtasks/${subtaskId}`, data),
  deleteSubtask: (todoId, subtaskId) => http.del(`/api/todos/${todoId}/subtasks/${subtaskId}`),
  createComment: (todoId, data) => http.post(`/api/todos/${todoId}/comments`, data),
  updateComment: (todoId, commentId, data) => http.patch(`/api/todos/${todoId}/comments/${commentId}`, data),
  deleteComment: (todoId, commentId) => http.del(`/api/todos/${todoId}/comments/${commentId}`),
  delete: (todoId) => http.del(`/api/todos/${todoId}`),
};
