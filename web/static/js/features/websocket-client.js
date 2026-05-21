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
  renderProjects,
  renderStats,
  renderTodos,
  onAuthOk = () => {},
  onReminderDue = () => {},
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
      console.log('[WS] ✅ Connected');
      wsState = 'connected';
      reconnectAttempts = 0;
      updateConnectionStatus();

      // Send auth token as first message
      const token = getAuthToken();
      if (token) {
        wsSend({ type: 'auth', token: token });
      }

      // ERST: Lokale Änderungen pushen (wenn Queue vorhanden)
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
      console.log('[WS] ❌ Closed (code=' + event.code + ', reason=' + (event.reason || 'none') + ')');
      stopPingInterval();
      ws = null;
      if (!wsIntentionalClose) {
        wsState = 'disconnected';
        updateConnectionStatus();
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] 💥 Error:', err);
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

  switch (msg.type) {
    case 'auth_ok':
      onAuthOk(msg);
      break;
    case 'auth_fail':
      console.warn('[WS] Auth failed');
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
            // Lokale Version ist neuer → nicht überschreiben
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
        const local = await getFromDB('projects', msg.payload.id);
        if (local) {
          const localTime = new Date(local.updated_at || 0).getTime();
          const serverTime = new Date(msg.payload.updated_at || 0).getTime();
          if (serverTime >= localTime) {
            await dbPut('projects', msg.payload);
            projects = projects.map(p => p.id === msg.payload.id ? msg.payload : p);
            renderProjects();
            renderStats();
            renderTodos();
          }
        } else {
          await dbPut('projects', msg.payload);
          projects = projects.map(p => p.id === msg.payload.id ? msg.payload : p);
          renderProjects();
          renderStats();
          renderTodos();
        }
      }
      break;
    case 'project_delete':
      if (msg.payload?.id) {
        await deleteFromDB('projects', msg.payload.id);
        projects = projects.filter(p => p.id !== msg.payload.id);
        renderProjects();
        renderStats();
        renderTodos();
      }
      break;
    case 'member_invited':
    case 'member_accepted':
    case 'member_declined':
    case 'member_removed':
    case 'member_left':
    case 'member_color_changed':
      // refresh from server on sharing events
      await syncWithServer();
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
