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
        value: {
          getUserMedia: async (constraints) => {
            window.__braindumpGetUserMediaCalls = (window.__braindumpGetUserMediaCalls || 0) + 1;
            window.__braindumpLastGetUserMediaConstraints = constraints;
            if (window.__braindumpDelayNextGetUserMedia) {
              window.__braindumpDelayNextGetUserMedia = false;
              await new Promise(resolve => { window.__resolveBrainDumpGetUserMedia = resolve; });
            }
            if (constraints?.audio && constraints.audio !== true && !window.__braindumpDisableEnhancedFailure && !window.__braindumpEnhancedConstraintsFailed) {
              window.__braindumpEnhancedConstraintsFailed = true;
              const error = new Error('Could not start audio source');
              error.name = 'NotReadableError';
              throw error;
            }
            return { getTracks: () => [fakeTrack] };
          },
        },
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
          window.__braindumpRecorderStarts = (window.__braindumpRecorderStarts || 0) + 1;
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
        body: JSON.stringify({ json: { candidates: [
          { title: 'Milch kaufen', project_name: 'Einkauf', kind: 'shopping' },
          { title: 'Snoopy Tabletten geben', project_name: 'Privat', kind: 'reminder' },
          { title: 'Keller aufräumen', project_name: 'Privat', kind: 'todo' },
        ] } }),
      });
    });

    await loginApp();
    const parentProject = await page.evaluate(async () => {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: window.getAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify({ name: 'BrainDump Parent', color: '#6366f1' }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    });
    await page.evaluate(async (parentId) => {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: window.getAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify({ name: 'BrainDump Child', color: '#6366f1', parent_id: parentId }),
      });
      if (!response.ok) throw new Error(await response.text());
      if (typeof window.refreshFromServer === 'function') await window.refreshFromServer();
    }, parentProject.id);
    await page.locator('.fab-add-todo').click();
    await page.locator('#todo-modal.active').waitFor({ state: 'visible', timeout: 5000 });
    const todoModalNoHorizontalOverflow = await page.evaluate(() => {
      const modal = document.querySelector('#todo-modal .modal-content');
      return Boolean(modal && modal.scrollWidth <= modal.clientWidth + 1);
    });
    if (!todoModalNoHorizontalOverflow) throw new Error('Todo modal should not scroll horizontally on desktop');
    await page.evaluate(() => window.closeModal('todo-modal'));
    await page.waitForFunction(() => !document.getElementById('todo-modal')?.classList.contains('active'), null, { timeout: 5000 });
    await page.locator('#braindump-fab').waitFor({ state: 'visible', timeout: 10000 });
    const desktopFabOk = await page.evaluate(() => {
      const brainDumpEl = document.getElementById('braindump-fab');
      const addTodoEl = document.querySelector('.fab-add-todo');
      const brainDump = brainDumpEl?.getBoundingClientRect();
      const addTodo = addTodoEl?.getBoundingClientRect();
      const style = brainDumpEl ? getComputedStyle(brainDumpEl) : null;
      return Boolean(
        brainDumpEl && addTodoEl && brainDump && addTodo && style &&
        style.position === 'fixed' &&
        style.display === 'flex' &&
        brainDump.width >= 46 && brainDump.height >= 46 &&
        brainDump.right <= addTodo.left - 8 &&
        brainDump.left >= 0 && brainDump.bottom <= window.innerHeight
      );
    });
    if (!desktopFabOk) throw new Error('Desktop BrainDump FAB is not visibly positioned beside the add-todo FAB');

    await page.evaluate(() => {
      window.__braindumpDelayNextGetUserMedia = true;
      window.__braindumpDisableEnhancedFailure = true;
      window.__braindumpRecorderStarts = 0;
      window.__braindumpRecorderTimeslice = null;
      window.__braindumpTrackStopped = false;
    });
    await page.locator('#braindump-fab').click();
    await page.locator('#braindump-modal.active').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#braindump-close').click();
    await page.evaluate(() => window.__resolveBrainDumpGetUserMedia?.());
    await page.waitForFunction(() => !document.getElementById('braindump-modal')?.classList.contains('active'), null, { timeout: 5000 });
    await page.waitForTimeout(100);
    const closedDuringStartSafe = await page.evaluate(() => ({
      recorderStarts: window.__braindumpRecorderStarts || 0,
      trackStopped: window.__braindumpTrackStopped === true,
      modalActive: document.getElementById('braindump-modal')?.classList.contains('active') || false,
      recorderTimeslice: window.__braindumpRecorderTimeslice,
    }));
    if (closedDuringStartSafe.recorderStarts !== 0 || !closedDuringStartSafe.trackStopped || closedDuringStartSafe.modalActive) {
      throw new Error(`BrainDump close during microphone startup leaked recording state: ${JSON.stringify(closedDuringStartSafe)}`);
    }
    await page.evaluate(() => {
      window.__braindumpDisableEnhancedFailure = false;
      window.__braindumpEnhancedConstraintsFailed = false;
      window.__braindumpGetUserMediaCalls = 0;
      window.__braindumpRecorderStarts = 0;
      window.__braindumpRecorderTimeslice = null;
      window.__braindumpTrackStopped = false;
    });

    await page.locator('#braindump-fab').click();
    await page.locator('#braindump-modal.active').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => window.__braindumpRecorderTimeslice === 1000, null, { timeout: 5000 });
    const immediateRecordingState = await page.evaluate(() => {
      const modal = document.getElementById('braindump-modal');
      const create = document.getElementById('braindump-create');
      const record = document.getElementById('braindump-record');
      return Boolean(
        modal?.classList.contains('is-recording') &&
        record && !record.hidden && /Fertig|Finish/.test(record.textContent || '') &&
        create?.hidden === true
      );
    });
    if (!immediateRecordingState) throw new Error('BrainDump should start recording immediately and show only the finish action before results');
    const usedMinimalFallback = await page.evaluate(() => window.__braindumpEnhancedConstraintsFailed === true && window.__braindumpGetUserMediaCalls === 2 && window.__braindumpLastGetUserMediaConstraints?.audio === true);
    if (!usedMinimalFallback) throw new Error('BrainDump should retry Android WebView microphone capture with minimal audio constraints after NotReadableError');
    await page.evaluate(() => document.getElementById('braindump-record')?.click());
    await page.locator('.braindump-candidate-card').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.todo-title')).some(input => input.textContent?.trim() === 'Milch kaufen'), null, { timeout: 10000 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.todo-title')).some(input => input.textContent?.trim() === 'Snoopy Tabletten geben'), null, { timeout: 10000 });
    const groupedByProject = await page.evaluate(() => {
      const groups = Array.from(document.querySelectorAll('.braindump-candidate-group')).map(group => ({
        heading: group.querySelector('.braindump-candidate-group-head span')?.textContent?.trim() || '',
        titles: Array.from(group.querySelectorAll('.todo-title')).map(title => title.textContent?.trim() || ''),
      }));
      return groups;
    });
    if (JSON.stringify(groupedByProject) !== JSON.stringify([
      { heading: 'Einkauf', titles: ['Milch kaufen'] },
      { heading: 'Privat', titles: ['Snoopy Tabletten geben', 'Keller aufräumen'] },
    ])) throw new Error(`BrainDump preview should group candidates by project in stable order: ${JSON.stringify(groupedByProject)}`);
    const quickFixOk = await page.evaluate(() => {
      document.querySelector('.braindump-candidate-card [data-bd-action="edit"]')?.click();
      const firstCard = document.querySelector('.braindump-candidate-card.is-editing');
      const title = firstCard?.querySelector('.braindump-title-input');
      const customSelects = firstCard?.querySelectorAll('.ui-select-trigger').length || 0;
      const typeField = firstCard?.querySelector('[data-bd-field="kind"]');
      const removeButton = firstCard?.querySelector('[data-bd-action="remove"]');
      const firstTrigger = firstCard?.querySelector('.ui-select-trigger');
      firstTrigger?.click();
      const menu = document.querySelector('.ui-select-menu');
      const menuRows = Array.from(document.querySelectorAll('.ui-select-menu .ui-select-option')).map(option => ({
        label: option.querySelector('.ui-select-option-label')?.textContent?.trim() || '',
        depth: option.dataset.depth || '0',
      })).filter(option => option.label);
      const menuOptions = menuRows.map(option => option.label);
      const modalZ = Number.parseInt(getComputedStyle(document.getElementById('braindump-modal')).zIndex || '0', 10);
      const menuZ = Number.parseInt(getComputedStyle(menu).zIndex || '0', 10);
      const editButton = firstCard?.querySelector('[data-bd-action="edit"]');
      const editIsIconOnly = Boolean(editButton?.querySelector('svg')) && !(editButton?.textContent || '').trim();
      const childIndented = menuRows.some(option => option.label === 'BrainDump Child' && option.depth === '1');
      window.__braindumpQuickFixDebug = { hasTitle: Boolean(title), customSelects, menuRows, modalZ, menuZ, editIsIconOnly, childIndented, hasTypeField: Boolean(typeField), hasRemoveButton: Boolean(removeButton), html: firstCard?.innerHTML || '' };
      if (!title || customSelects < 2 || menuOptions.length === 0 || !childIndented || !(menuZ > modalZ) || !editIsIconOnly || typeField || removeButton) return false;
      title.value = 'Hafermilch kaufen';
      title.dispatchEvent(new Event('input', { bubbles: true }));
      return firstCard.querySelector('.braindump-title-input')?.value === 'Hafermilch kaufen';
    });
    if (!quickFixOk) {
      const debug = await page.evaluate(() => window.__braindumpQuickFixDebug);
      throw new Error(`BrainDump quick-fix controls should use visible shared dropdowns, an icon-only edit button, and avoid type/remove controls: ${JSON.stringify(debug)}`);
    }
    const acceptReady = await page.evaluate(() => {
      const button = document.getElementById('braindump-create');
      return Boolean(button && !button.disabled && !button.classList.contains('is-muted'));
    });
    if (!acceptReady) throw new Error('BrainDump accept button should become prominent when todos are selected');
    if (!transcribeCalls || !extractCalls) throw new Error(`Expected BrainDump live calls, got transcribe=${transcribeCalls} extract=${extractCalls}`);
    const trackStopped = await page.evaluate(() => window.__braindumpTrackStopped === true);
    if (!trackStopped) throw new Error('BrainDump did not stop microphone tracks after recording');
    assertNoFrontendErrors();
  } finally {
    await browser.close();
  }
}

withFreshDb(run);
