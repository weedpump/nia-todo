import { acquireSyncCommitLock, hasPendingTodoChanges, projectPendingTodoChanges, queueItemReferencesTodo } from './todo-pending.js';
import { attachmentCache as defaultAttachmentCache, getAuthoritativeAttachmentBlobIdsToDelete, getOrphanedPermanentAttachmentQueueItems } from '../storage/attachment-cache.js';

export function createWebSocketClient({
  wsUrl,
  getAuthToken,
  syncWithServer,
  syncInProgressRef,
  refreshFromServer = null,
  renderConnectionStatus,
  dbGetAll,
  dbGetAllStrict = dbGetAll,
  dbPut,
  dbPutStrict = dbPut,
  getFromDB,
  deleteFromDB,
  deleteFromDBStrict = deleteFromDB,
  dbTransactionStrict = null,
  getTodos,
  setTodos,
  getProjects,
  setProjects,
  getSections,
  setSections,
  getWorkspaces,
  setWorkspaces,
  renderWorkspaces,
  renderProjects,
  renderStats,
  renderTodos,
  attachmentCache = defaultAttachmentCache,
  onAuthOk = () => {},
  onReminderDue = () => {},
  onSessionInvalidated = () => {},
  onServerUpdateStatus = () => {},
  onDashboardPreferencesUpdate = () => {},
  onAvatarUpdate = () => {},
}) {
let ws = null;
let wsState = 'disconnected'; // connected, connecting, reconnecting, disconnected
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 1000;
let pingInterval = null;
let reconnectTimer = null;
let wsIntentionalClose = false;
const activeMessageHandlers = new Set();

function mergeTodoPayloadWithLocalSubtasks(incoming, local = null) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const merged = { ...incoming };
  for (const field of ['subtasks', 'comments', 'attachments']) {
    if (Object.prototype.hasOwnProperty.call(incoming, field)) {
      merged[field] = Array.isArray(incoming[field]) ? incoming[field] : [];
    } else if (local && Object.prototype.hasOwnProperty.call(local, field)) {
      merged[field] = Array.isArray(local[field]) ? local[field] : [];
    } else {
      merged[field] = [];
    }
  }
  merged.comments_count = Number.isFinite(Number(incoming.comments_count)) ? Number(incoming.comments_count) : merged.comments.length;
  merged.attachments_count = Number.isFinite(Number(incoming.attachments_count)) ? Number(incoming.attachments_count) : merged.attachments.length;
  return merged;
}

function getReconnectDelay() {
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 30000);
  const jitter = Math.random() * 1000;
  return delay + jitter;
}

function connectWebSocket() {
  if (!getAuthToken()) {
    console.log('[WS] No auth token, skipping connection');
    wsState = 'disconnected';
    updateConnectionStatus();
    return;
  }
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    console.log('[WS] Already connecting or open');
    return;
  }
  if (wsIntentionalClose) {
    console.log('[WS] Intentionally closed, skipping reconnect');
    return;
  }

  wsState = reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
  updateConnectionStatus();
  console.log('[WS] Connecting to ' + wsUrl + ' (attempt ' + (reconnectAttempts + 1) + ')');

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      if (wsIntentionalClose || !getAuthToken()) return;
      console.log('[WS] Connected');
      wsState = 'connected';
      reconnectAttempts = 0;
      updateConnectionStatus();

      // Send auth token as first message
      const token = getAuthToken();
      if (token) {
        wsSend({ type: 'auth', token: token });
      }

      // FIRST: Push local changes (if queue exists). Full cache refreshes are
      // intentionally owned by REST (`refreshFromServer`) so WebSocket startup
      // cannot race the authoritative startup pull.
      try {
        await syncWithServer();
      } catch (e) {
        console.error('Pre-sync failed', e);
      }

      if (wsIntentionalClose || !getAuthToken()) return;
      // Start ping interval
      startPingInterval();
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        console.error('WS: parse error', e);
        return;
      }
      const handler = Promise.resolve(handleWsMessage(msg));
      activeMessageHandlers.add(handler);
      handler.then(
        () => activeMessageHandlers.delete(handler),
        (error) => {
          activeMessageHandlers.delete(handler);
          console.error('WS: message handler failed', error);
        },
      );
    };

    ws.onclose = (event) => {
      console.log('[WS] Closed (code=' + event.code + ', reason=' + (event.reason || 'none') + ')');
      stopPingInterval();
      ws = null;
      if (!wsIntentionalClose) {
        wsState = 'disconnected';
        updateConnectionStatus();
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      wsState = 'disconnected';
      updateConnectionStatus();
    };
  } catch (e) {
    console.error('[WS] Failed to create WebSocket:', e);
    wsState = 'disconnected';
    updateConnectionStatus();
    scheduleReconnect();
  }
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function startPingInterval() {
  stopPingInterval();
  pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      wsSend({ type: 'ping' });
    }
  }, 30000);
}

function stopPingInterval() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

function scheduleReconnect() {
  if (!getAuthToken()) {
    console.log('WS: no auth token, reconnect skipped');
    return;
  }
  if (reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn('WS: max reconnect attempts reached');
    return;
  }
  const delay = getReconnectDelay();
  reconnectAttempts++;
  console.log(`WS: reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function disconnectWebSocket() {
  wsIntentionalClose = true;
  stopPingInterval();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  wsState = 'disconnected';
  updateConnectionStatus();
  return Promise.allSettled([...activeMessageHandlers]);
}

function resumeWebSocket() {
  wsIntentionalClose = false;
  reconnectAttempts = 0;
}

function updateConnectionStatus() {
  renderConnectionStatus(wsState);
}
async function handleWsMessage(msg) {
  let todos = getTodos();
  let projects = getProjects();
  let sections = getSections();
  let workspaces = getWorkspaces?.() || [];

  async function persistTodoPayloadWithPending(todo) {
    if (!todo?.id) return false;
    const queue = await dbGetAllStrict('syncQueue');
    const projected = projectPendingTodoChanges(todo, queue);
    if (!projected) {
      await deleteFromDBStrict('todos', todo.id);
      todos = todos.filter(item => String(item.id) !== String(todo.id));
      return true;
    }
    await dbPutStrict('todos', projected);
    const exists = todos.some(item => String(item.id) === String(projected.id));
    todos = exists
      ? todos.map(item => String(item.id) === String(projected.id) ? projected : item)
      : [...todos, projected];
    return true;
  }

  async function applyProjectPayload(projectPayload) {
    if (!projectPayload?.id) return;
    const local = await getFromDB('projects', projectPayload.id);
    if (local) {
      const localTime = new Date(local.updated_at || 0).getTime();
      const serverTime = new Date(projectPayload.updated_at || 0).getTime();
      if (serverTime < localTime) return;
    }
    await dbPut('projects', projectPayload);
    const existing = projects.find(p => String(p.id) === String(projectPayload.id));
    projects = existing
      ? projects.map(p => String(p.id) === String(projectPayload.id) ? projectPayload : p)
      : [...projects, projectPayload];
  }

  async function applyTodoCommentPayload(payload, mode) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      const todoId = payload?.todo_id;
      if (!todoId) return false;
      const local = await getFromDB('todos', todoId);
      if (!local) return false;
      const comments = Array.isArray(local.comments) ? [...local.comments] : [];
      let nextComments = comments;
      if (mode === 'delete') {
        nextComments = comments.filter(comment => String(comment.id) !== String(payload.comment_id));
      } else if (payload.comment?.id) {
        const existing = comments.find(comment => String(comment.id) === String(payload.comment.id));
        nextComments = existing
          ? comments.map(comment => String(comment.id) === String(payload.comment.id) ? payload.comment : comment)
          : [...comments, payload.comment];
        nextComments.sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime() || Number(a.id || 0) - Number(b.id || 0));
      }
      const updatedTodo = {
        ...local,
        comments: nextComments,
        comments_count: Number.isFinite(Number(payload.comments_count)) ? Number(payload.comments_count) : nextComments.length,
        updated_at: payload.updated_at || local.updated_at,
      };
      return await persistTodoPayloadWithPending(updatedTodo);
    } finally {
      releaseCommitLock();
    }
  }

  async function applyTodoAttachmentPayload(payload, mode) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      const todoId = payload?.todo_id;
      if (!todoId) return false;
      const local = await getFromDB('todos', todoId);
      if (!local) return false;
      const attachments = Array.isArray(local.attachments) ? [...local.attachments] : [];
      let nextAttachments = attachments;
      if (mode === 'delete') {
        nextAttachments = attachments.filter(attachment => String(attachment.id) !== String(payload.attachment_id));
      } else if (payload.attachment?.id) {
        const existing = attachments.find(attachment => String(attachment.id) === String(payload.attachment.id));
        nextAttachments = existing
          ? attachments.map(attachment => String(attachment.id) === String(payload.attachment.id) ? payload.attachment : attachment)
          : [...attachments, payload.attachment];
        nextAttachments.sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime() || Number(a.id || 0) - Number(b.id || 0));
      }
      const updatedTodo = {
        ...local,
        attachments: nextAttachments,
        attachments_count: Number.isFinite(Number(payload.attachments_count)) ? Number(payload.attachments_count) : nextAttachments.length,
        updated_at: payload.updated_at || local.updated_at,
      };
      const persisted = await persistTodoPayloadWithPending(updatedTodo);
      if (persisted && mode === 'delete') await attachmentCache.remove(payload.attachment_id);
      return persisted;
    } finally {
      releaseCommitLock();
    }
  }

  async function applyTodoSubtaskPayload(payload, mode) {
    const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
    try {
      const todoId = payload?.todo_id;
      if (!todoId) return false;
      const local = await getFromDB('todos', todoId);
      if (!local) return false;
      const subtasks = Array.isArray(local.subtasks) ? [...local.subtasks] : [];
      let nextSubtasks = subtasks;
      if (mode === 'delete') {
        nextSubtasks = subtasks.filter(subtask => String(subtask.id) !== String(payload.subtask_id));
      } else if (payload.subtask?.id) {
        const normalizedSubtask = { ...payload.subtask, is_done: Boolean(payload.subtask.is_done) };
        const existing = subtasks.find(subtask => String(subtask.id) === String(normalizedSubtask.id));
        nextSubtasks = existing
          ? subtasks.map(subtask => String(subtask.id) === String(normalizedSubtask.id) ? normalizedSubtask : subtask)
          : [...subtasks, normalizedSubtask];
        nextSubtasks.sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id || 0) - Number(b.id || 0));
      }
      const updatedTodo = {
        ...local,
        subtasks: nextSubtasks,
        updated_at: payload.updated_at || local.updated_at,
      };
      return await persistTodoPayloadWithPending(updatedTodo);
    } finally {
      releaseCommitLock();
    }
  }

  switch (msg.type) {
    case 'auth_ok':
      onAuthOk(msg);
      break;
    case 'auth_fail':
      console.warn('[WS] Auth failed');
      break;
    case 'session_invalidated':
      onSessionInvalidated(msg);
      break;
    case 'server_update_status':
      onServerUpdateStatus(msg.payload || {});
      break;
    case 'dashboard_preferences_update':
      onDashboardPreferencesUpdate(msg.payload || {});
      break;
    case 'avatar_update':
      await onAvatarUpdate(msg.payload || {});
      break;
    case 'pong':
      // keepalive response — nothing to do
      break;
    case 'reminder_due':
      onReminderDue(msg.payload || msg);
      break;
    case 'sync_response': {
      const deferredForActiveSync = Boolean(syncInProgressRef?.value);
      while (syncInProgressRef?.value) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (deferredForActiveSync && refreshFromServer) {
        await refreshFromServer();
        break;
      }
      const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
      try {
      if (dbTransactionStrict) {
        const committed = await dbTransactionStrict(
          ['todos', 'projects', 'sections', 'workspaces', 'syncQueue', 'attachmentBlobs'],
          'readwrite',
          async transaction => {
            const [queue, storedTodos, storedProjects, storedSections, storedWorkspaces, blobRecords] = await Promise.all([
              transaction.getAll('syncQueue'),
              transaction.getAll('todos'),
              transaction.getAll('projects'),
              transaction.getAll('sections'),
              transaction.getAll('workspaces'),
              transaction.getAll('attachmentBlobs'),
            ]);
            let nextTodos = storedTodos;
            let nextProjects = storedProjects;
            let nextSections = storedSections;
            let nextWorkspaces = storedWorkspaces;
            let reconciliationQueue = queue;

            if (msg.todos) {
              const orphanedPermanentItems = getOrphanedPermanentAttachmentQueueItems(queue, msg.todos);
              const orphanedPermanentIds = new Set(orphanedPermanentItems.map(item => String(item.id)));
              const queueForProjection = queue.filter(item => !orphanedPermanentIds.has(String(item.id)));
              reconciliationQueue = queueForProjection;
              for (const orphaned of orphanedPermanentItems) {
                await transaction.delete('syncQueue', orphaned.id);
                await transaction.delete('attachmentBlobs', String(orphaned.data?.blob_id || orphaned.data?.temp_id));
              }
              const localById = new Map(storedTodos.map(todo => [String(todo.id), todo]));
              const incomingIds = new Set(msg.todos.map(todo => String(todo.id)));
              nextTodos = [];
              for (const todo of msg.todos) {
                const local = localById.get(String(todo.id)) || null;
                const incomingTodo = mergeTodoPayloadWithLocalSubtasks(todo, local);
                let nextTodo = incomingTodo;
                if (hasPendingTodoChanges(queueForProjection, todo.id)) {
                  nextTodo = projectPendingTodoChanges(incomingTodo, queueForProjection);
                } else if (local) {
                  const localTime = new Date(local.updated_at || 0).getTime();
                  const serverTime = new Date(incomingTodo.updated_at || 0).getTime();
                  if (serverTime < localTime) nextTodo = local;
                }
                if (nextTodo) nextTodos.push(nextTodo);

              }
              for (const local of storedTodos) {
                if (incomingIds.has(String(local.id))) continue;
                if (hasPendingTodoChanges(queueForProjection, local.id)) nextTodos.push(local);

              }
              await transaction.clear('todos');
              for (const todo of nextTodos) await transaction.put('todos', todo);
            }
            if (msg.projects) {
              const localById = new Map(storedProjects.map(project => [String(project.id), project]));
              const incomingIds = new Set(msg.projects.map(project => String(project.id)));
              nextProjects = msg.projects.map((project) => {
                const local = localById.get(String(project.id));
                const pending = queue.some(item => item.action === 'UPDATE_PROJECT' && String(item.data?.id) === String(project.id));
                if (local && (pending || new Date(project.updated_at || 0).getTime() < new Date(local.updated_at || 0).getTime())) return local;
                return project;
              });
              nextProjects.push(...storedProjects.filter(project => !incomingIds.has(String(project.id)) && queue.some(item =>
                (item.action === 'CREATE_PROJECT' && String(item.data?._tempId) === String(project.id))
                || (item.action === 'UPDATE_PROJECT' && String(item.data?.id) === String(project.id)))));
              await transaction.clear('projects');
              for (const project of nextProjects) await transaction.put('projects', project);
            }
            if (msg.sections) {
              const localById = new Map(storedSections.map(section => [String(section.id), section]));
              const incomingIds = new Set(msg.sections.map(section => String(section.id)));
              nextSections = msg.sections.map((section) => {
                const local = localById.get(String(section.id));
                const pending = queue.some(item => item.action === 'UPDATE_SECTION' && String(item.data?.id) === String(section.id));
                if (local && (pending || new Date(section.updated_at || 0).getTime() < new Date(local.updated_at || 0).getTime())) return local;
                return section;
              });
              nextSections.push(...storedSections.filter(section => !incomingIds.has(String(section.id)) && queue.some(item =>
                (item.action === 'CREATE_SECTION' && String(item.data?._tempId) === String(section.id))
                || (item.action === 'UPDATE_SECTION' && String(item.data?.id) === String(section.id)))));
              await transaction.clear('sections');
              for (const section of nextSections) await transaction.put('sections', section);
            }
            if (msg.workspaces) {
              nextWorkspaces = msg.workspaces;
              await transaction.clear('workspaces');
              for (const workspace of nextWorkspaces) await transaction.put('workspaces', workspace);
            }
            for (const blobId of getAuthoritativeAttachmentBlobIdsToDelete(blobRecords, nextTodos, reconciliationQueue)) {
              await transaction.delete('attachmentBlobs', blobId);
            }
            return { todos: nextTodos, projects: nextProjects, sections: nextSections, workspaces: nextWorkspaces, queue: reconciliationQueue };
          },
        );
        todos = committed.todos;
        projects = committed.projects;
        sections = committed.sections;
        workspaces = committed.workspaces;
        setWorkspaces?.(workspaces);
        renderWorkspaces?.();

      } else {
      // Full data sync from server — nur wenn Server neuer
      if (msg.todos) {
        const serverTodoIds = new Set(msg.todos.map(todo => String(todo.id)));
        const queue = await dbGetAllStrict('syncQueue');
        for (const localTodo of await dbGetAllStrict('todos')) {
          if (!serverTodoIds.has(String(localTodo.id)) && !hasPendingTodoChanges(queue, localTodo.id)) {
            await attachmentCache.removeForTodo(localTodo.id);
            await deleteFromDBStrict('todos', localTodo.id);
          }
        }
        for (const todo of msg.todos) {
          const local = await getFromDB('todos', todo.id);
          if (local) {
            const incomingAttachmentIds = new Set((todo.attachments || []).map(attachment => String(attachment.id)));
            const removedAttachmentIds = (local.attachments || [])
              .filter(attachment => !attachment?.is_pending && !incomingAttachmentIds.has(String(attachment.id)))
              .map(attachment => attachment.id);
            await Promise.all(removedAttachmentIds.map(attachmentId => attachmentCache.remove(attachmentId)));
          }
          const incomingTodo = mergeTodoPayloadWithLocalSubtasks(todo, local);
          if (hasPendingTodoChanges(queue, todo.id)) {
            const projected = projectPendingTodoChanges(incomingTodo, queue);
            if (projected) await dbPutStrict('todos', projected);
            else await deleteFromDBStrict('todos', todo.id);
          } else if (!local) {
            await dbPutStrict('todos', incomingTodo);
          } else {
            const localTime = new Date(local.updated_at || 0).getTime();
            const serverTime = new Date(incomingTodo.updated_at || 0).getTime();
            if (serverTime >= localTime) await dbPutStrict('todos', incomingTodo);
          }
        }
        todos = await dbGetAllStrict('todos');
      }
      if (msg.projects) {
        const serverProjectIds = new Set(msg.projects.map(project => String(project.id)));
        const queue = await dbGetAllStrict('syncQueue');
        for (const localProject of await dbGetAll('projects')) {
          const hasPendingChange = queue.some(q =>
            (q.action === 'CREATE_PROJECT' && q.data?._tempId === localProject.id) ||
            (q.action === 'UPDATE_PROJECT' && q.data?.id === localProject.id)
          );
          if (!serverProjectIds.has(String(localProject.id)) && !hasPendingChange) await deleteFromDB('projects', localProject.id);
        }
        for (const project of msg.projects) {
          const local = await getFromDB('projects', project.id);
          if (!local) {
            await dbPut('projects', project);
          } else {
            const queue = await dbGetAllStrict('syncQueue');
            const pendingChanges = queue.find(q =>
              q.action === 'UPDATE_PROJECT' && q.data.id === project.id
            );
            if (!pendingChanges) {
              const localTime = new Date(local.updated_at || 0).getTime();
              const serverTime = new Date(project.updated_at || 0).getTime();
              if (serverTime >= localTime) {
                await dbPut('projects', project);
              }
            }
          }
        }
        projects = await dbGetAll('projects');
      }
      if (msg.sections) {
        const serverSectionIds = new Set(msg.sections.map(section => String(section.id)));
        const queue = await dbGetAllStrict('syncQueue');
        for (const localSection of await dbGetAll('sections')) {
          const hasPendingChange = queue.some(q =>
            (q.action === 'CREATE_SECTION' && q.data?._tempId === localSection.id) ||
            (q.action === 'UPDATE_SECTION' && q.data?.id === localSection.id)
          );
          if (!serverSectionIds.has(String(localSection.id)) && !hasPendingChange) await deleteFromDB('sections', localSection.id);
        }
        for (const section of msg.sections) {
          const local = await getFromDB('sections', section.id);
          if (!local) {
            await dbPut('sections', section);
          } else {
            const queue = await dbGetAllStrict('syncQueue');
            const pendingChanges = queue.find(q =>
              q.action === 'UPDATE_SECTION' && q.data.id === section.id
            );
            if (!pendingChanges) {
              const localTime = new Date(local.updated_at || 0).getTime();
              const serverTime = new Date(section.updated_at || 0).getTime();
              if (serverTime >= localTime) {
                await dbPut('sections', section);
              }
            }
          }
        }
        sections = await dbGetAll('sections');
      }
      if (msg.workspaces) {
        const serverWorkspaceIds = new Set(msg.workspaces.map(workspace => String(workspace.id)));
        for (const localWorkspace of await dbGetAll('workspaces')) {
          if (!serverWorkspaceIds.has(String(localWorkspace.id))) await deleteFromDB('workspaces', localWorkspace.id);
        }
        for (const workspace of msg.workspaces) {
          await dbPut('workspaces', workspace);
        }
        workspaces = await dbGetAll('workspaces');
        setWorkspaces?.(workspaces);
        renderWorkspaces?.();
      }
      }
      setTodos(todos);
      setProjects(projects);
      setSections(sections);
      renderProjects();
      renderStats();
      renderTodos();
      } finally {
        releaseCommitLock();
      }
      break;
    }
    case 'todo_create':
      if (msg.payload) {
        while (syncInProgressRef?.value) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        todos = getTodos();
        const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
        try {
          const local = await getFromDB('todos', msg.payload.id);
          const queue = await dbGetAllStrict('syncQueue');
          const incomingTodo = projectPendingTodoChanges(
            mergeTodoPayloadWithLocalSubtasks(msg.payload, local),
            queue,
          );
          await dbPutStrict('todos', incomingTodo);
          const existing = todos.find(t => t.id === incomingTodo.id);
          if (!existing) todos.push(incomingTodo);
          else todos = todos.map(t => t.id === incomingTodo.id ? incomingTodo : t);
        } finally {
          releaseCommitLock();
        }
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_update':
      if (msg.payload) {
        const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
        try {
          const local = await getFromDB('todos', msg.payload.id);
          const queue = await dbGetAllStrict('syncQueue');
          const incomingTodo = mergeTodoPayloadWithLocalSubtasks(msg.payload, local);
          if (hasPendingTodoChanges(queue, msg.payload.id)) {
            await persistTodoPayloadWithPending(incomingTodo);
          } else {
            if (local) {
              const localTime = new Date(local.updated_at || 0).getTime();
              const serverTime = new Date(msg.payload.updated_at || 0).getTime();
              if (serverTime < localTime) break;
            }
            await dbPutStrict('todos', incomingTodo);
            todos = todos.map(t => t.id === incomingTodo.id ? incomingTodo : t);
          }
        } finally {
          releaseCommitLock();
        }
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_delete':
      if (msg.payload?.id) {
        const releaseCommitLock = await acquireSyncCommitLock(syncInProgressRef);
        try {
          if (dbTransactionStrict) {
            await dbTransactionStrict(['todos', 'syncQueue', 'attachmentBlobs'], 'readwrite', async transaction => {
              const [queue, blobs] = await Promise.all([
                transaction.getAll('syncQueue'),
                transaction.getAll('attachmentBlobs'),
              ]);
              const childOperations = queue.filter(item => queueItemReferencesTodo(item, msg.payload.id));
              for (const item of childOperations) await transaction.delete('syncQueue', item.id);
              await transaction.delete('todos', msg.payload.id);
              for (const blob of blobs.filter(record => String(record.todo_id) === String(msg.payload.id))) {
                await transaction.delete('attachmentBlobs', blob.id);
              }
            });
          } else {
            const queue = await dbGetAllStrict('syncQueue');
            const childOperations = queue.filter(item => queueItemReferencesTodo(item, msg.payload.id));
            await Promise.all(childOperations.map(item => deleteFromDBStrict('syncQueue', item.id)));
            await deleteFromDBStrict('todos', msg.payload.id);
          }
          todos = todos.filter(t => t.id !== msg.payload.id);
        } finally {
          releaseCommitLock();
        }
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_comment_create':
    case 'todo_comment_update':
      if (await applyTodoCommentPayload(msg.payload, 'upsert')) {
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_comment_delete':
      if (await applyTodoCommentPayload(msg.payload, 'delete')) {
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_subtask_create':
    case 'todo_subtask_update':
      if (await applyTodoSubtaskPayload(msg.payload, 'upsert')) {
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_subtask_delete':
      if (await applyTodoSubtaskPayload(msg.payload, 'delete')) {
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_attachment_create':
      if (await applyTodoAttachmentPayload(msg.payload, 'upsert')) {
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_attachment_delete':
      if (await applyTodoAttachmentPayload(msg.payload, 'delete')) {
        renderStats();
        renderTodos();
      }
      break;
    case 'project_create':
      if (msg.payload) {
        await dbPut('projects', msg.payload);
        // Remove temp project with same name to avoid duplicates
        const tempProject = projects.find(p =>
          p.name === msg.payload.name &&
          String(p.id).startsWith('temp-')
        );
        if (tempProject) {
          projects = projects.filter(p => p.id !== tempProject.id);
        }
        const existing = projects.find(p => p.id === msg.payload.id);
        if (existing) {
          // Server response for our create → replace temp entry
          projects = projects.map(p => p.id === msg.payload.id ? msg.payload : p);
        } else {
          // Broadcast from another client → add to list
          projects.push(msg.payload);
        }
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'project_update':
      if (msg.payload) {
        await applyProjectPayload(msg.payload);
        setProjects(projects);
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'project_update_many':
      if (Array.isArray(msg.payload?.projects)) {
        for (const projectPayload of msg.payload.projects) {
          await applyProjectPayload(projectPayload);
        }
        setProjects(projects);
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'project_delete':
      if (msg.payload?.id) {
        const deletedIds = msg.payload.deleted_ids || [msg.payload.id];
        await Promise.all(deletedIds.map(projectId => deleteFromDB('projects', projectId)));
        projects = projects.filter(p => !deletedIds.includes(p.id));
        setProjects(projects);
        await refreshFromServer?.();
        return;
      }
      break;
    case 'workspace_create':
    case 'workspace_update':
      if (msg.payload) {
        await dbPut('workspaces', msg.payload);
        const existing = workspaces.find(w => String(w.id) === String(msg.payload.id));
        workspaces = existing
          ? workspaces.map(w => String(w.id) === String(msg.payload.id) ? msg.payload : w)
          : [...workspaces, msg.payload];
        setWorkspaces?.(workspaces);
        renderWorkspaces?.();
      }
      break;
    case 'workspace_delete':
      if (msg.payload?.deleted) {
        await deleteFromDB('workspaces', msg.payload.deleted);
        workspaces = workspaces.filter(w => String(w.id) !== String(msg.payload.deleted));
        setWorkspaces?.(workspaces);
        renderWorkspaces?.();
      }
      await refreshFromServer?.();
      return;
    case 'member_invited':
    case 'member_accepted':
    case 'member_declined':
    case 'member_removed':
    case 'member_restored':
    case 'member_left':
    case 'member_color_changed':
      // Refresh from REST on sharing events because membership changes can
      // alter full project/todo visibility, while WebSocket stays delta-only.
      await refreshFromServer?.();
      // reload invites list when membership changes
      if (typeof window.loadInvites === 'function') {
        window.loadInvites();
      }
      return;
    case 'section_create':
      if (msg.payload) {
        await dbPut('sections', msg.payload);
        // Remove temp section with same name+project to avoid duplicates
        const tempSection = sections.find(s =>
          s.name === msg.payload.name &&
          s.project_id === msg.payload.project_id &&
          String(s.id).startsWith('temp-')
        );
        if (tempSection) {
          sections = sections.filter(s => s.id !== tempSection.id);
        }
        const existing = sections.find(s => s.id === msg.payload.id);
        if (!existing) {
          sections.push(msg.payload);
        } else {
          sections = sections.map(s => s.id === msg.payload.id ? msg.payload : s);
        }
        renderTodos();
      }
      break;
    case 'section_update':
      if (msg.payload) {
        const local = await getFromDB('sections', msg.payload.id);
        if (local) {
          const localTime = new Date(local.updated_at || 0).getTime();
          const serverTime = new Date(msg.payload.updated_at || 0).getTime();
          if (serverTime >= localTime) {
            await dbPut('sections', msg.payload);
            sections = sections.map(s => s.id === msg.payload.id ? msg.payload : s);
            renderTodos();
          }
        } else {
          await dbPut('sections', msg.payload);
          sections = sections.map(s => s.id === msg.payload.id ? msg.payload : s);
          renderTodos();
        }
      }
      break;
    case 'section_delete':
      if (msg.payload?.id) {
        await deleteFromDB('sections', msg.payload.id);
        sections = sections.filter(s => s.id !== msg.payload.id);
        // Move todos in this section to unsorted
        for (const todo of todos) {
          if (todo.section_id === msg.payload.id) {
            todo.section_id = null;
            await dbPut('todos', todo);
          }
        }
        renderTodos();
      }
      break;
    default:
      console.log('WS: unknown message type', msg.type);
  }

  setTodos(todos);
  setProjects(projects);
  setSections(sections);

  const dataEvents = new Set([
    'sync_response',
    'todo_create', 'todo_update', 'todo_delete',
    'project_create', 'project_update', 'project_delete',
    'section_create', 'section_update', 'section_delete',
    'workspace_create', 'workspace_update', 'workspace_delete',
    'member_invited', 'member_accepted', 'member_declined', 'member_removed', 'member_restored', 'member_left', 'member_color_changed',
  ]);
  if (dataEvents.has(msg.type)) {
    renderProjects();
    renderStats();
    renderTodos();
  }
}


  function getWsState() {
    return wsState;
  }

  return {
    getWsState,
    getReconnectDelay,
    connectWebSocket,
    wsSend,
    startPingInterval,
    stopPingInterval,
    scheduleReconnect,
    disconnectWebSocket,
    resumeWebSocket,
    updateConnectionStatus,
    handleWsMessage,
  };
}
