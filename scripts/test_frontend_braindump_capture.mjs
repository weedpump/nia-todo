#!/usr/bin/env node
import { withFreshDb, launchPage, ADMIN_PASSWORD, USERNAME, USER_PASSWORD, BASE_URL } from './frontend_test_lib.mjs';

async function adminFetch(path, options = {}) {
  const login = await fetch(`${BASE_URL}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  const loginData = await login.json();
  if (!login.ok) throw new Error(`Admin login failed: ${login.status} ${JSON.stringify(loginData)}`);
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
      Authorization: `Bearer ${loginData.access_token}`,
      'X-CSRF-Token': loginData.csrf_token,
      Cookie: `csrf_token=${loginData.csrf_token}`,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function enableBrainDumpForFrontendUser() {
  await adminFetch('/api/admin/braindump-config', {
    method: 'PATCH',
    body: JSON.stringify({
      enabled: true,
      llm_provider: 'openai_compatible',
      llm_base_url: 'http://llm.example.invalid/v1',
      llm_model: 'test-model',
      stt_provider: 'whisper_cpp_remote',
      stt_url: 'http://stt.example.invalid/inference',
      stt_language: 'de',
    }),
  });
  const users = await adminFetch('/api/admin/users');
  const user = users.users.find((entry) => entry.username === USERNAME);
  if (!user) throw new Error(`Could not find frontend test user ${USERNAME}`);
  await adminFetch(`/api/admin/users/${user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ braindump_enabled: true }),
  });
}

async function run() {
  console.log('🎙️ Running BrainDump frontend capture test...');
  await enableBrainDumpForFrontendUser();
  const { browser, page, loginApp, assertNoFrontendErrors } = await launchPage();
  let transcribeCalls = 0;
  let extractCalls = 0;

  try {
    await page.addInitScript(() => {
      localStorage.setItem('nia-todo-language', 'de');
      const fakeTrack = { stop() { window.__braindumpTrackStopped = true; } };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [fakeTrack] }) },
      });
      class FakeMediaRecorder extends EventTarget {
        static isTypeSupported(type) { return ['audio/webm;codecs=opus', 'audio/webm'].includes(type); }
        constructor(stream, options = {}) {
          super();
          this.stream = stream;
          this.mimeType = options.mimeType || 'audio/webm';
          this.state = 'inactive';
          this._chunks = 0;
        }
        start(timeslice) {
          window.__braindumpRecorderTimeslice = timeslice;
          this.state = 'recording';
          this._timer = window.setTimeout(() => this._emitChunk(), 80);
        }
        requestData() { this._emitChunk(); }
        stop() {
          window.clearTimeout(this._timer);
          this._emitChunk();
          this.state = 'inactive';
          this.dispatchEvent(new Event('stop'));
        }
        _emitChunk() {
          this._chunks += 1;
          const blob = new Blob([`fake desktop/native microphone audio ${this._chunks} `.repeat(8)], { type: this.mimeType });
          this.dispatchEvent(new BlobEvent('dataavailable', { data: blob }));
        }
      }
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, writable: true, value: FakeMediaRecorder });
      window.AudioContext = class {
        createMediaStreamSource() { return { connect() {} }; }
        createAnalyser() {
          return {
            fftSize: 0,
            smoothingTimeConstant: 0,
            frequencyBinCount: 4,
            getByteTimeDomainData(data) { data.fill(128); data[0] = 150; },
          };
        }
        close() {}
      };
    });

    await page.route('**/api/braindump/v2/live/audio-segment/transcribe**', async (route) => {
      transcribeCalls += 1;
      const body = route.request().postDataBuffer();
      if (!body || body.length < 16) throw new Error(`Expected recorded audio body, got ${body?.length || 0} bytes`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transcript: 'Milch kaufen und morgen Snoopy Tabletten geben' }),
      });
    });
    await page.route('**/api/braindump/v2/live/text-segment/extract', async (route) => {
      extractCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ json: { candidates: [{ title: 'Milch kaufen', kind: 'shopping' }, { title: 'Snoopy Tabletten geben', kind: 'reminder' }] } }),
      });
    });

    await loginApp();
    await page.locator('#braindump-fab').waitFor({ state: 'visible', timeout: 10000 });
    const separated = await page.evaluate(() => {
      const brainDump = document.getElementById('braindump-fab').getBoundingClientRect();
      const addTodo = document.querySelector('.fab-add-todo').getBoundingClientRect();
      return brainDump.right <= addTodo.left - 8;
    });
    if (!separated) throw new Error('Desktop BrainDump FAB overlaps the add-todo FAB');

    await page.locator('#braindump-fab').click();
    await page.locator('#braindump-modal.active').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#braindump-record').click();
    await page.waitForFunction(() => window.__braindumpRecorderTimeslice === 1000, null, { timeout: 5000 });
    await page.locator('#braindump-record').click();
    await page.getByText('Milch kaufen', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Snoopy Tabletten geben', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    if (!transcribeCalls || !extractCalls) throw new Error(`Expected BrainDump live calls, got transcribe=${transcribeCalls} extract=${extractCalls}`);
    const trackStopped = await page.evaluate(() => window.__braindumpTrackStopped === true);
    if (!trackStopped) throw new Error('BrainDump did not stop microphone tracks after recording');
    assertNoFrontendErrors();
  } finally {
    await browser.close();
  }
}

withFreshDb(run);
