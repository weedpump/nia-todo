#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const defaultCapability = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src-tauri/capabilities/default.json'), 'utf8'));
const windowsPasskeysCapability = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src-tauri/capabilities/windows-passkeys.json'), 'utf8'));

function assertDesktopPasskeyCapabilities() {
  const defaultPermissions = new Set(defaultCapability.permissions || []);
  if (defaultPermissions.has('allow-desktop-passkey-register') || defaultPermissions.has('allow-desktop-passkey-authenticate')) {
    throw new Error('Default desktop capability must not expose passkey commands on Linux/macOS');
  }

  const passkeyPermissions = new Set(windowsPasskeysCapability.permissions || []);
  if (!passkeyPermissions.has('allow-desktop-passkey-register')) {
    throw new Error('Windows passkey capability must allow desktop_passkey_register');
  }
  if (!passkeyPermissions.has('allow-desktop-passkey-authenticate')) {
    throw new Error('Windows passkey capability must allow desktop_passkey_authenticate');
  }
  if (JSON.stringify(windowsPasskeysCapability.platforms || []) !== JSON.stringify(['windows'])) {
    throw new Error('Native desktop passkey capability must stay Windows-only until Linux/macOS bridges exist');
  }
}

function runScenario(name, body) {
  const common = String.raw`
    const calls = [];
    const store = new Map();
    const response = (body, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });
    Object.defineProperty(globalThis, 'location', { value: new URL('https://todo.example.test/'), configurable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    }, configurable: true });
    globalThis.atob = globalThis.atob || ((value) => Buffer.from(value, 'base64').toString('binary'));
    globalThis.btoa = globalThis.btoa || ((value) => Buffer.from(value, 'binary').toString('base64'));
    globalThis.structuredClone = globalThis.structuredClone || ((value) => JSON.parse(JSON.stringify(value)));
    const installNavigator = (userAgent, credentials) => Object.defineProperty(globalThis, 'navigator', { value: { userAgent, credentials }, configurable: true });
    const installWindow = (tauri = null) => { globalThis.isTauri = Boolean(tauri); Object.defineProperty(globalThis, 'window', { value: tauri ? { __TAURI_INTERNALS__: { invoke: tauri.core.invoke } } : {}, configurable: true }); };
    const passkeyOptions = {
      publicKey: {
        challenge: 'AQID',
        rp: { name: 'nia-todo', id: 'todo.example.test' },
        user: { id: 'BAUG', name: 'tobi', displayName: 'Tobi' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        excludeCredentials: [],
      },
      challenge: 'challenge-1',
      origin: 'https://todo.example.test',
    };
    const passkeyRequest = {
      publicKey: {
        challenge: 'AQID',
        rpId: 'todo.example.test',
        allowCredentials: [{ type: 'public-key', id: 'BwgJ' }],
        userVerification: 'required',
      },
      origin: 'https://todo.example.test',
    };
  `;
  const code = `${common}\n${body}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${name} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

runScenario('browser passkeys use navigator.credentials', String.raw`
  let browserCreateCalled = false;
  installWindow(null);
  installNavigator('Mozilla/5.0', {
    create: async ({ publicKey }) => {
      browserCreateCalled = publicKey.challenge instanceof ArrayBuffer && publicKey.user.id instanceof ArrayBuffer;
      return {
        id: 'browser-credential',
        rawId: new Uint8Array([1, 2, 3]).buffer,
        type: 'public-key',
        response: {
          clientDataJSON: new Uint8Array([4]).buffer,
          attestationObject: new Uint8Array([5]).buffer,
          getTransports: () => ['internal'],
        },
      };
    },
  });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/api/me/passkeys/options')) return response(passkeyOptions);
    if (String(url).endsWith('/api/me/passkeys/verify')) return response({ ok: true });
    throw new Error('unexpected fetch ' + url);
  };
  const { authApi } = await import('./web/static/js/api/auth.js');
  await authApi.createPasskey('Browser Key', 'pw');
  if (!browserCreateCalled) throw new Error('navigator.credentials.create was not used with ArrayBuffer publicKey');
  if (calls.some(call => call.options?.body?.includes('desktop_passkey'))) throw new Error('browser path leaked native command');
`);

runScenario('windows native passkeys use native bridge with server origin', String.raw`
  installNavigator('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', {
    create: async () => { throw new Error('browser create must not be used in native Windows'); },
    get: async () => { throw new Error('browser get must not be used in native Windows'); },
  });
  installWindow({ core: { invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'desktop_passkey_register') return { id: 'native-register', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 'cdj', attestationObject: 'att' }, transports: ['internal'] };
    if (command === 'desktop_passkey_authenticate') return { id: 'native-auth', rawId: 'def', type: 'public-key', response: { clientDataJSON: 'cdj', authenticatorData: 'auth', signature: 'sig' } };
    throw new Error('unexpected invoke ' + command);
  } } });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/me/passkeys/options')) return response(passkeyOptions);
    if (String(url).endsWith('/api/me/passkeys/verify')) return response({ ok: true });
    if (String(url).endsWith('/api/2fa/passkey/options')) return response(passkeyRequest);
    if (String(url).endsWith('/api/2fa/passkey/verify')) return response({ ok: true });
    throw new Error('unexpected fetch ' + url);
  };
  const { RUNTIME_CAPABILITIES } = await import('./web/static/js/core/config.js');
  if (!RUNTIME_CAPABILITIES.nativePasskeys) throw new Error('nativePasskeys should be available for Windows+Tauri');
  const { authApi } = await import('./web/static/js/api/auth.js');
  await authApi.createPasskey('Native Key', 'pw');
  await authApi.verifyPasskeyLogin('challenge-token', false);
  const register = calls.find(call => call.command === 'desktop_passkey_register');
  const auth = calls.find(call => call.command === 'desktop_passkey_authenticate');
  if (register?.args?.origin !== 'https://todo.example.test') throw new Error('register did not use server origin');
  if (register?.args?.options?.rp?.id !== 'todo.example.test') throw new Error('register did not pass RP ID');
  if (auth?.args?.origin !== 'https://todo.example.test') throw new Error('auth did not use server origin');
  if (auth?.args?.options?.rpId !== 'todo.example.test') throw new Error('auth did not pass RP ID');
`);

runScenario('android native passkeys use javascript interface callbacks', String.raw`
  installNavigator('Mozilla/5.0 (Linux; Android 14)', {
    create: async () => { throw new Error('browser create must not be used on native Android'); },
    get: async () => { throw new Error('browser get must not be used on native Android'); },
  });
  globalThis.isTauri = true;
  Object.defineProperty(globalThis, 'window', { value: {
    __TAURI_INTERNALS__: { invoke: async () => { throw new Error('Tauri passkey invoke must not be used on Android'); } },
    NiaAndroidNative: {
      setConfiguredServerUrl: (serverUrl) => {
        calls.push({ method: 'setConfiguredServerUrl', serverUrl });
        return serverUrl === 'https://todo.example.test';
      },
      supportsPasskeys: () => {
        calls.push({ method: 'supportsPasskeys' });
        return true;
      },
      passkeyRegister: (requestId, origin, optionsJson) => {
        calls.push({ method: 'passkeyRegister', requestId, origin, options: JSON.parse(optionsJson) });
        queueMicrotask(() => window.__niaAndroidPasskeyComplete(requestId, true, JSON.stringify({ id: 'android-register', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 'cdj', attestationObject: 'att' } })));
      },
      passkeyAuthenticate: (requestId, origin, optionsJson) => {
        calls.push({ method: 'passkeyAuthenticate', requestId, origin, options: JSON.parse(optionsJson) });
        queueMicrotask(() => window.__niaAndroidPasskeyComplete(requestId, true, JSON.stringify({ id: 'android-auth', rawId: 'def', type: 'public-key', response: { clientDataJSON: 'cdj', authenticatorData: 'auth', signature: 'sig' } })));
      },
    },
  }, configurable: true });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/me/passkeys/options')) return response(passkeyOptions);
    if (String(url).endsWith('/api/me/passkeys/verify')) return response({ ok: true });
    if (String(url).endsWith('/api/2fa/passkey/options')) return response(passkeyRequest);
    if (String(url).endsWith('/api/2fa/passkey/verify')) return response({ ok: true });
    throw new Error('unexpected fetch ' + url);
  };
  const { RUNTIME_CAPABILITIES } = await import('./web/static/js/core/config.js');
  if (!RUNTIME_CAPABILITIES.nativePasskeys) throw new Error('Android should advertise native passkeys when JS interface is present');
  const { authApi } = await import('./web/static/js/api/auth.js');
  await authApi.createPasskey('Android Key', 'pw');
  await authApi.verifyPasskeyLogin('challenge-token', false);
  const register = calls.find(call => call.method === 'passkeyRegister');
  const auth = calls.find(call => call.method === 'passkeyAuthenticate');
  if (!calls.some(call => call.method === 'supportsPasskeys')) throw new Error('Android passkey support probe was not used');
  if (register?.origin !== 'https://todo.example.test') throw new Error('Android register did not use server origin');
  if (register?.options?.rp?.id !== 'todo.example.test') throw new Error('Android register did not pass RP ID');
  if (auth?.origin !== 'https://todo.example.test') throw new Error('Android auth did not use server origin');
  if (auth?.options?.rpId !== 'todo.example.test') throw new Error('Android auth did not pass RP ID');
`);

assertDesktopPasskeyCapabilities();

console.log('✅ Native passkey frontend regression tests passed');
