export function createWebSocketClient({
  wsUrl,
  getAuthToken,
  syncWithServer,
  refreshFromServer = null,
  renderConnectionStatus,
  dbGetAll,
  dbPut,
  getFromDB,
  deleteFromDB,
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
  onAuthOk = () => {},
  onReminderDue = () => {},
  onSessionInvalidated = () => {},
}) {
let ws = null;
let wsState = 'disconnected'; // connected, connecting, reconnecting, disconnected
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 1000;
let pingInterval = null;
let reconnectTimer = null;
let wsIntentionalClose = false;

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

      // Start ping interval
      startPingInterval();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        console.error('WS: parse error', e);
      }
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
    ws.close();
    ws = null;
  }
  wsState = 'disconnected';
  updateConnectionStatus();
}

function updateConnectionStatus() {
  renderConnectionStatus(wsState);
}
async function handleWsMessage(msg) {
  let todos = getTodos();
  let projects = getProjects();
  let sections = getSections();
  let workspaces = getWorkspaces?.() || [];

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
    await dbPut('todos', updatedTodo);
    todos = todos.map(todo => String(todo.id) === String(todoId) ? updatedTodo : todo);
    return true;
  }

  async function applyTodoAttachmentPayload(payload, mode) {
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
    await dbPut('todos', updatedTodo);
    todos = todos.map(todo => String(todo.id) === String(todoId) ? updatedTodo : todo);
    return true;
  }

  async function applyTodoSubtaskPayload(payload, mode) {
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
    await dbPut('todos', updatedTodo);
    todos = todos.map(todo => String(todo.id) === String(todoId) ? updatedTodo : todo);
    return true;
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
    case 'pong':
      // keepalive response — nothing to do
      break;
    case 'reminder_due':
      onReminderDue(msg.payload || msg);
      break;
    case 'sync_response':
      // Full data sync from server — nur wenn Server neuer
      if (msg.todos) {
        const serverTodoIds = new Set(msg.todos.map(todo => String(todo.id)));
        const queue = await dbGetAll('syncQueue');
        for (const localTodo of await dbGetAll('todos')) {
          const hasPendingChange = queue.some(q =>
            (q.action === 'CREATE_TODO' && q.data?._tempId === localTodo.id) ||
            (q.action === 'UPDATE_TODO' && q.data?.id === localTodo.id)
          );
          if (!serverTodoIds.has(String(localTodo.id)) && !hasPendingChange) await deleteFromDB('todos', localTodo.id);
        }
        for (const todo of msg.todos) {
          const local = await getFromDB('todos', todo.id);
          const incomingTodo = mergeTodoPayloadWithLocalSubtasks(todo, local);
          if (!local) {
            await dbPut('todos', incomingTodo);
          } else {
            const queue = await dbGetAll('syncQueue');
            const pendingChanges = queue.find(q =>
              q.action === 'UPDATE_TODO' && q.data.id === todo.id
            );
            if (!pendingChanges) {
              const localTime = new Date(local.updated_at || 0).getTime();
              const serverTime = new Date(incomingTodo.updated_at || 0).getTime();
              if (serverTime >= localTime) {
                await dbPut('todos', incomingTodo);
              }
            }
          }
        }
        todos = await dbGetAll('todos');
      }
      if (msg.projects) {
        const serverProjectIds = new Set(msg.projects.map(project => String(project.id)));
        const queue = await dbGetAll('syncQueue');
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
            const queue = await dbGetAll('syncQueue');
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
        const queue = await dbGetAll('syncQueue');
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
            const queue = await dbGetAll('syncQueue');
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
      setTodos(todos);
      setProjects(projects);
      setSections(sections);
      renderProjects();
      renderStats();
      renderTodos();
      break;
    case 'todo_create':
      if (msg.payload) {
        const local = await getFromDB('todos', msg.payload.id);
        const incomingTodo = mergeTodoPayloadWithLocalSubtasks(msg.payload, local);
        await dbPut('todos', incomingTodo);
        // Check if we have a temp todo in queue for this server response
        const queue = await dbGetAll('syncQueue');
        const pendingCreate = queue.find(q =>
          q.action === 'CREATE_TODO' && q.data._tempId
        );
        if (pendingCreate) {
          // Replace temp todo with real server version
          await deleteFromDB('todos', pendingCreate.data._tempId);
          todos = todos.filter(t => t.id !== pendingCreate.data._tempId);
          const existingReal = todos.find(t => t.id === incomingTodo.id);
          if (existingReal) {
            todos = todos.map(t => t.id === incomingTodo.id ? incomingTodo : t);
          } else {
            todos.push(incomingTodo);
          }
        } else {
          // Broadcast from another client → add to list
          const existing = todos.find(t => t.id === incomingTodo.id);
          if (!existing) todos.push(incomingTodo);
          else todos = todos.map(t => t.id === incomingTodo.id ? incomingTodo : t);
        }
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_update':
      if (msg.payload) {
        const local = await getFromDB('todos', msg.payload.id);
        if (local) {
          const localTime = new Date(local.updated_at || 0).getTime();
          const serverTime = new Date(msg.payload.updated_at || 0).getTime();
          if (serverTime < localTime) {
            // Local version is newer → do not overwrite
            break;
          }
        }
        const incomingTodo = mergeTodoPayloadWithLocalSubtasks(msg.payload, local);
        await dbPut('todos', incomingTodo);
        todos = todos.map(t => t.id === incomingTodo.id ? incomingTodo : t);
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'todo_delete':
      if (msg.payload?.id) {
        await deleteFromDB('todos', msg.payload.id);
        todos = todos.filter(t => t.id !== msg.payload.id);
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
    updateConnectionStatus,
    handleWsMessage,
  };
}
