export function createWebSocketClient({
  wsUrl,
  getAuthToken,
  syncWithServer,
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

      // FIRST: Push local changes (if queue exists)
      try {
        await syncWithServer();
      } catch (e) {
        console.error('Pre-sync failed', e);
      }

      // DANN: Full sync vom Server holen
      wsSend({ type: 'sync_request' });

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
          if (!local) {
            await dbPut('todos', todo);
          } else {
            const queue = await dbGetAll('syncQueue');
            const pendingChanges = queue.find(q =>
              q.action === 'UPDATE_TODO' && q.data.id === todo.id
            );
            if (!pendingChanges) {
              const localTime = new Date(local.updated_at || 0).getTime();
              const serverTime = new Date(todo.updated_at || 0).getTime();
              if (serverTime >= localTime) {
                await dbPut('todos', todo);
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
        await dbPut('todos', msg.payload);
        // Check if we have a temp todo in queue for this server response
        const queue = await dbGetAll('syncQueue');
        const pendingCreate = queue.find(q =>
          q.action === 'CREATE_TODO' && q.data._tempId
        );
        if (pendingCreate) {
          // Replace temp todo with real server version
          await deleteFromDB('todos', pendingCreate.data._tempId);
          todos = todos.filter(t => t.id !== pendingCreate.data._tempId);
          const existingReal = todos.find(t => t.id === msg.payload.id);
          if (existingReal) {
            todos = todos.map(t => t.id === msg.payload.id ? msg.payload : t);
          } else {
            todos.push(msg.payload);
          }
        } else {
          // Broadcast from another client → add to list
          const existing = todos.find(t => t.id === msg.payload.id);
          if (!existing) todos.push(msg.payload);
          else todos = todos.map(t => t.id === msg.payload.id ? msg.payload : t);
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
        await dbPut('todos', msg.payload);
        todos = todos.map(t => t.id === msg.payload.id ? msg.payload : t);
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
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'sync_request' }));
        }
        renderProjects();
        renderStats();
        renderTodos();
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
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'sync_request' }));
      }
      break;
    case 'member_invited':
    case 'member_accepted':
    case 'member_declined':
    case 'member_removed':
    case 'member_restored':
    case 'member_left':
    case 'member_color_changed':
      // refresh from server on sharing events
      await syncWithServer();
      // reload invites list when membership changes
      if (typeof window.loadInvites === 'function') {
        window.loadInvites();
      }
      break;
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
