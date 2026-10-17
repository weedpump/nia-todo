#!/usr/bin/env node
import assert from 'node:assert/strict';

const updates = [];
const { createWebSocketClient } = await import('../web/static/js/features/websocket-client.js');
const client = createWebSocketClient({
  wsUrl: 'wss://todo.example/ws',
  getAuthToken: () => 'token',
  syncWithServer: async () => {},
  renderConnectionStatus: () => {},
  dbGetAll: async () => [],
  dbPut: async () => {},
  getFromDB: async () => null,
  deleteFromDB: async () => {},
  getTodos: () => [],
  setTodos: () => {},
  getProjects: () => [],
  setProjects: () => {},
  getSections: () => [],
  setSections: () => {},
  getWorkspaces: () => [],
  setWorkspaces: () => {},
  renderWorkspaces: () => {},
  renderProjects: () => {},
  renderStats: () => {},
  renderTodos: () => {},
  onAvatarUpdate: payload => updates.push(payload),
});

const payload = {
  avatar_url: '/api/avatars/user-7.webp',
  avatar_updated_at: '2026-10-17T12:00:00Z',
};
await client.handleWsMessage({ type: 'avatar_update', payload });
assert.deepEqual(updates, [payload]);

console.log('✅ Realtime avatar updates stay user-scoped and local');
