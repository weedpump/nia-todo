export const API = '';

export const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
})();

export const DB_NAME = 'nia-todo-db';
export const DB_VERSION = 3;
export const APP_VERSION = 'v1.3.6-dev';
