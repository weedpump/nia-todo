import { API } from '../core/config.js';
import { http, getAuthHeaders } from './http.js';
import { apiErrorFromResponse } from './errors.js';

async function parseOrThrow(response, fallback = 'Request failed') {
  if (!response.ok) await apiErrorFromResponse(response, fallback);
  return response.json().catch(() => ({}));
}


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
  listAttachments: (todoId) => http.get(`/api/todos/${todoId}/attachments`),
  async uploadAttachment(todoId, file) {
    const headers = getAuthHeaders();
    delete headers['Content-Type'];
    const response = await fetch(API + `/api/todos/${todoId}/attachments`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': file.type || 'application/octet-stream',
        'X-Nia-Filename': encodeURIComponent(file.name || 'attachment'),
      },
      body: file,
      credentials: 'include',
    });
    return parseOrThrow(response, 'Attachment upload failed');
  },
  async getAttachmentBlob(todoId, attachmentId) {
    const response = await fetch(API + `/api/todos/${todoId}/attachments/${attachmentId}/download`, {
      headers: getAuthHeaders(),
      credentials: 'include',
    });
    if (!response.ok) await apiErrorFromResponse(response, 'Attachment download failed');
    return response.blob();
  },
  async downloadAttachment(todoId, attachmentId, filename = 'attachment') {
    const blob = await this.getAttachmentBlob(todoId, attachmentId);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || 'attachment';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  async downloadAttachmentNative(todoId, attachmentId, filename = 'attachment', nativeBridge = null) {
    if (!nativeBridge?.downloadToDownloads) return false;
    const url = API + `/api/todos/${todoId}/attachments/${attachmentId}/download`;
    return nativeBridge.downloadToDownloads(url, filename || 'attachment', getAuthHeaders());
  },
  deleteAttachment: (todoId, attachmentId) => http.del(`/api/todos/${todoId}/attachments/${attachmentId}`),
  delete: (todoId) => http.del(`/api/todos/${todoId}`),
};
