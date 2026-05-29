import { API } from '../core/config.js';
import { getAuthHeaders, getAuthToken } from '../api/http.js';
import { escapeHtml } from '../core/utils.js';

export function createBrainDumpLiveDebugFeature() {
  const state = {
    recorder: null,
    stream: null,
    recording: false,
    startedAt: 0,
    stoppedAt: 0,
    lastChunkAt: 0,
    segmentId: 0,
    active: 0,
    queue: [],
    maxWorkers: 1,
    audioChunks: [],
    mediaChunks: 0,
    lastSnapshotChunkCount: 0,
    latestQueuedSegmentId: 0,
    latestAppliedSegmentId: 0,
    finalSegmentId: 0,
    finalProcessed: false,
    finalSnapshotApplied: false,
    segments: [],
    candidates: [],
    selectedCandidateKeys: new Set(),
    creating: false,
    createMessage: '',
    timer: null,
    requestTimer: null,
    finalJsonAt: 0,
    sessionClosed: false,
    stopResolve: null,
    initAttempts: 0,
  };

  async function init() {
    const todoList = document.getElementById('todo-list');
    if (!todoList || document.getElementById('braindump-live-debug')) return;
    const loginOverlay = document.getElementById('login-overlay');
    const loginVisible = loginOverlay && window.getComputedStyle(loginOverlay).display !== 'none';
    const userMenuVisible = !!document.getElementById('user-menu-button')?.offsetParent;
    if (loginVisible || !userMenuVisible || !getAuthToken()) return;
    try {
      const access = await fetch(`${API}/api/braindump/v2/access`, {
        headers: getAuthHeaders(),
        credentials: 'include',
      });
      if (!access.ok) return;
      const data = await access.json();
      if (!data.enabled) return;
    } catch {
      return;
    }
    const panel = document.createElement('section');
    panel.id = 'braindump-live-debug';
    panel.className = 'braindump-live-debug';
    panel.innerHTML = `
      <div class="bd-head">
        <div>
          <div class="bd-title">🎙️ BrainDump Live Debug</div>
          <div class="bd-subtitle">Roher Test: live sprechen → kumulierte Snapshots senden → JSON + Zeiten sehen</div>
        </div>
        <div class="bd-controls">
          <select id="bd-model">
            <option value="base">base / schneller</option>
            <option value="small">small / genauer</option>
          </select>
          <button type="button" class="btn btn-primary" id="bd-start">Start</button>
          <button type="button" class="btn btn-secondary" id="bd-stop" disabled>Stop</button>
        </div>
      </div>
      <div class="bd-metrics" id="bd-metrics">
        <span>Status: idle</span><span>Aufnahme: 0.0s</span><span>Stop→JSON: –</span><span>Queue: 0</span><span>Media-Chunks: 0</span>
      </div>
      <div class="bd-note">Sendet absichtlich immer die kumulierte Aufnahme, weil einzelne WebM-Chunks mobil oft nicht standalone dekodierbar sind.</div>
      <div class="bd-columns">
        <div class="bd-card"><h4>Live Segmente</h4><div id="bd-segments" class="bd-log muted">Noch nichts aufgenommen.</div></div>
        <div class="bd-card">
          <h4>Kandidaten</h4>
          <div id="bd-candidates" class="bd-candidates muted">Noch keine Kandidaten.</div>
          <div class="bd-create-row">
            <button type="button" class="btn btn-primary" id="bd-create-todos" disabled>Ausgewählte erstellen</button>
            <span id="bd-create-status" class="bd-create-status"></span>
          </div>
          <details class="bd-json-details"><summary>JSON anzeigen</summary><pre id="bd-json" class="bd-json">[]</pre></details>
        </div>
      </div>
    `;
    todoList.parentNode.insertBefore(panel, todoList);
    document.getElementById('bd-start')?.addEventListener('click', start);
    document.getElementById('bd-stop')?.addEventListener('click', stop);
    document.getElementById('bd-create-todos')?.addEventListener('click', createSelectedTodos);
    panel.addEventListener('change', (event) => {
      const box = event.target?.closest?.('[data-bd-candidate-key]');
      if (!box) return;
      const key = box.getAttribute('data-bd-candidate-key');
      if (!key) return;
      if (box.checked) state.selectedCandidateKeys.add(key);
      else state.selectedCandidateKeys.delete(key);
      render();
    });
  }

  function scheduleInitRetry() {
    if (state.initAttempts >= 8 || document.getElementById('braindump-live-debug')) return;
    state.initAttempts += 1;
    setTimeout(init, 1500);
  }

  function render() {
    const elapsed = state.recording ? (performance.now() - state.startedAt) / 1000 : (state.startedAt ? (state.stoppedAt - state.startedAt) / 1000 : 0);
    const waiting = state.queue.length + state.active;
    if (state.stoppedAt && state.finalProcessed && !state.finalJsonAt) state.finalJsonAt = performance.now();
    const stopToJson = state.finalJsonAt ? `${((state.finalJsonAt - state.stoppedAt) / 1000).toFixed(2)}s` : (state.stoppedAt ? `läuft… (${waiting} offen)` : '–');
    const status = state.recording ? 'recording' : (waiting ? 'processing' : (state.stoppedAt ? 'stopped' : 'idle/ready'));
    const metrics = document.getElementById('bd-metrics');
    if (metrics) {
      metrics.innerHTML = `<span>Status: ${status}</span><span>Aufnahme: ${elapsed.toFixed(1)}s</span><span>Stop→JSON: ${stopToJson}</span><span>Queue: ${waiting}</span><span>Media-Chunks: ${state.mediaChunks}</span>`;
    }
    const seg = document.getElementById('bd-segments');
    if (seg) {
      if (!state.segments.length) seg.textContent = 'Noch nichts aufgenommen.';
      else seg.innerHTML = state.segments.slice().reverse().map((s) => `
        <div class="bd-segment ${s.error ? 'error' : ''}">
          <b>#${s.segmentId}</b> ${escapeHtml(s.status)} · Audio ${(s.audioStartMs/1000).toFixed(1)}–${(s.audioEndMs/1000).toFixed(1)}s
          ${s.timing ? ` · STT ${(s.timing.stt_ms/1000).toFixed(2)}s · LLM ${(s.timing.llm_ms/1000).toFixed(2)}s · Total ${(s.timing.total_ms/1000).toFixed(2)}s` : ''}
          <div class="bd-transcript">${escapeHtml(s.transcript || s.error || '')}</div>
        </div>`).join('');
    }
    const candidatesEl = document.getElementById('bd-candidates');
    if (candidatesEl) {
      if (!state.candidates.length) {
        candidatesEl.className = 'bd-candidates muted';
        candidatesEl.textContent = 'Noch keine Kandidaten.';
      } else {
        candidatesEl.className = 'bd-candidates';
        candidatesEl.innerHTML = state.candidates.map((candidate) => {
          const key = candidateKey(candidate);
          const checked = state.selectedCandidateKeys.has(key) ? 'checked' : '';
          const route = [candidate.project_name, candidate.section_name].filter(Boolean).join(' / ') || 'Inbox/Fallback';
          const dates = [candidate.deadline ? `Deadline: ${candidate.deadline}` : '', candidate.reminder ? `Reminder: ${candidate.reminder}` : ''].filter(Boolean).join(' · ');
          return `<label class="bd-candidate"><input type="checkbox" data-bd-candidate-key="${escapeHtml(key)}" ${checked}> <span><b>${escapeHtml(candidate.title || '')}</b><small>${escapeHtml(route)}${dates ? ` · ${escapeHtml(dates)}` : ''}</small></span></label>`;
        }).join('');
      }
    }
    const selectedCount = selectedCandidates().length;
    const createBtn = document.getElementById('bd-create-todos');
    if (createBtn) {
      createBtn.disabled = state.creating || state.recording || state.active > 0 || !selectedCount;
      createBtn.textContent = state.creating ? 'Erstelle…' : `Ausgewählte erstellen (${selectedCount})`;
    }
    const createStatus = document.getElementById('bd-create-status');
    if (createStatus) createStatus.textContent = state.createMessage || '';
    const json = document.getElementById('bd-json');
    if (json) json.textContent = JSON.stringify({ candidates: state.candidates }, null, 2);
  }

  async function start() {
    if (state.recording) return;
    if (!window.MediaRecorder) {
      addDebugSegment('unsupported', 'MediaRecorder not available in this browser');
      render();
      return;
    }
    state.segments = [];
    applyCandidates([]);
    state.createMessage = '';
    state.queue = [];
    state.active = 0;
    state.audioChunks = [];
    state.mediaChunks = 0;
    state.lastSnapshotChunkCount = 0;
    state.latestQueuedSegmentId = 0;
    state.latestAppliedSegmentId = 0;
    state.finalSegmentId = 0;
    state.finalProcessed = false;
    state.finalSnapshotApplied = false;
    state.segmentId = 0;
    state.startedAt = performance.now();
    state.stoppedAt = 0;
    state.finalJsonAt = 0;
    state.sessionClosed = false;
    state.lastChunkAt = state.startedAt;
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeCandidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    const mimeType = mimeCandidates.find((value) => {
      try { return MediaRecorder.isTypeSupported(value); } catch { return false; }
    }) || '';
    state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
    state.recorder.addEventListener('dataavailable', onChunk);
    state.recorder.addEventListener('error', (event) => {
      addDebugSegment('recorder-error', String(event.error?.message || event.error || 'MediaRecorder error'));
    });
    state.recorder.addEventListener('stop', () => {
      state.stream?.getTracks().forEach((track) => track.stop());
      state.stream = null;
      if (state.requestTimer) clearInterval(state.requestTimer);
      state.requestTimer = null;
      render();
    });
    state.recording = true;
    document.getElementById('bd-start').disabled = true;
    document.getElementById('bd-stop').disabled = false;
    state.timer = setInterval(render, 250);
    state.recorder.start();
    // Some mobile browsers do not reliably emit timeslice chunks. Pull chunks explicitly.
    state.requestTimer = setInterval(() => requestRecorderData('timer'), 4000);
    addDebugSegment('recorder-started', `mime=${state.recorder.mimeType || 'default'} ua=${navigator.userAgent}`);
    render();
  }

  async function stop() {
    if (!state.recording) return;
    state.recording = false;
    state.stoppedAt = performance.now();
    state.sessionClosed = true;
    addDebugSegment('stop-clicked', 'waiting for final chunks');
    if (state.requestTimer) clearInterval(state.requestTimer);
    state.requestTimer = null;
    requestRecorderData('stop');
    setTimeout(() => {
      if (!state.audioChunks.length && state.active === 0 && state.queue.length === 0) {
        addDebugSegment('no-audio-chunks', 'MediaRecorder produced no usable audio blobs');
        render();
      }
    }, 600);
    state.recorder?.stop();
    document.getElementById('bd-start').disabled = false;
    document.getElementById('bd-stop').disabled = true;
    render();
  }

  function requestRecorderData(reason) {
    try {
      if (state.recorder && state.recorder.state === 'recording') {
        state.recorder.requestData();
        addDebugSegment('chunk-requested', reason);
      }
    } catch (error) {
      addDebugSegment('requestData-error', String(error?.message || error));
    }
  }

  function onChunk(event) {
    const now = performance.now();
    const audioEndMs = Math.round(now - state.startedAt);
    const durationMs = Math.round(now - state.lastChunkAt);
    state.lastChunkAt = now;
    const size = event.data?.size || 0;
    addDebugSegment('chunk-received', `size=${size}, duration=${durationMs}ms, type=${event.data?.type || 'unknown'}`);
    if (!event.data || size < 1200) {
      addDebugSegment('chunk-dropped', `size=${size}, duration=${durationMs}ms`);
      render();
      return;
    }
    state.audioChunks.push(event.data);
    state.mediaChunks += 1;
    queueAccumulatedSnapshot(audioEndMs, state.stoppedAt ? 'final-snapshot' : 'snapshot');
    render();
  }

  function queueAccumulatedSnapshot(audioEndMs, reason) {
    if (!state.audioChunks.length) return;
    if (!state.stoppedAt && state.audioChunks.length === state.lastSnapshotChunkCount) return;
    state.lastSnapshotChunkCount = state.audioChunks.length;
    const type = state.recorder?.mimeType || state.audioChunks[0]?.type || 'audio/webm';
    const blob = new Blob(state.audioChunks, { type });
    const segmentId = ++state.segmentId;
    const item = {
      segmentId,
      audioStartMs: 0,
      audioEndMs,
      kind: reason,
      status: `${reason} queued (${Math.round(blob.size / 1024)} KiB, ${state.audioChunks.length} chunks)`,
      transcript: '',
      timing: null,
    };
    state.latestQueuedSegmentId = segmentId;
    if (state.stoppedAt) {
      state.finalSegmentId = segmentId;
      state.finalProcessed = false;
      state.finalSnapshotApplied = false;
    }
    state.segments.push(item);
    pumpItem(item, blob);
  }

  function addDebugSegment(status, message) {
    state.segments.push({
      segmentId: 'dbg',
      audioStartMs: Math.max(0, Math.round((performance.now() || 0) - state.startedAt)),
      audioEndMs: Math.max(0, Math.round((performance.now() || 0) - state.startedAt)),
      status,
      transcript: message,
      timing: null,
    });
  }

  function pumpItem(item, blob) {
    if (state.stoppedAt) state.finalJsonAt = 0;
    for (const pending of state.queue) {
      pending.item.status = `stale skipped by #${item.segmentId}`;
    }
    state.queue = [];
    state.queue.push({ item, blob });
    pump();
  }

  function pump() {
    while (state.active < state.maxWorkers && state.queue.length) {
      const job = state.queue.shift();
      state.active += 1;
      processSegment(job).finally(() => {
        state.active -= 1;
        pump();
        render();
      });
    }
  }

  function candidateKey(candidate) {
    return [candidate.title, candidate.project_name, candidate.section_name, candidate.deadline, candidate.reminder, candidate.kind].map((value) => String(value || '').trim()).join('|');
  }

  function applyCandidates(candidates) {
    state.candidates = Array.isArray(candidates) ? candidates : [];
    state.selectedCandidateKeys = new Set(state.candidates.map(candidateKey));
  }

  function selectedCandidates() {
    return state.candidates.filter((candidate) => state.selectedCandidateKeys.has(candidateKey(candidate)));
  }

  async function createSelectedTodos() {
    const candidates = selectedCandidates();
    if (!candidates.length || state.creating) return;
    state.creating = true;
    state.createMessage = '';
    render();
    try {
      const response = await fetch(`${API}/api/braindump/v2/todos`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ candidates }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      const count = Array.isArray(data.todos) ? data.todos.length : 0;
      state.createMessage = `${count} Todo${count === 1 ? '' : 's'} erstellt`;
      state.selectedCandidateKeys.clear();
      if (typeof window.refreshFromServer === 'function') await window.refreshFromServer();
    } catch (error) {
      state.createMessage = `Fehler: ${String(error?.message || error)}`;
    } finally {
      state.creating = false;
      render();
    }
  }

  async function processSegment({ item, blob }) {
    item.status = 'sending';
    render();
    const model = document.getElementById('bd-model')?.value || 'base';
    const started = performance.now();
    try {
      const headers = getAuthHeaders();
      headers['Content-Type'] = blob.type || 'application/octet-stream';
      const params = new URLSearchParams({
        segment_id: String(item.segmentId),
        audio_start_ms: String(item.audioStartMs),
        audio_end_ms: String(item.audioEndMs),
        model,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45_000);
      let response;
      try {
        response = await fetch(`${API}/api/braindump/v2/live/audio-segment?${params}`, {
          method: 'POST',
          headers,
          credentials: 'include',
          body: blob,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      item.transcript = data.transcript || '';
      item.timing = data.timing;
      item.wallMs = Math.round(performance.now() - started);
      const next = Array.isArray(data.json?.candidates) ? data.json.candidates : [];
      if (state.stoppedAt && item.segmentId < state.finalSegmentId) {
        item.status = `stale done, ignored by final #${state.finalSegmentId}`;
        return;
      }
      if (!state.stoppedAt && item.segmentId < state.latestQueuedSegmentId) {
        item.status = `stale done, ignored by #${state.latestQueuedSegmentId}`;
        return;
      }
      item.status = next.length ? 'done/latest' : 'done/latest (no candidates)';
      state.latestAppliedSegmentId = Math.max(state.latestAppliedSegmentId, item.segmentId);
      applyCandidates(next);
      if (state.stoppedAt && item.segmentId === state.finalSegmentId) {
        state.finalProcessed = true;
      }
    } catch (error) {
      item.status = 'error';
      item.error = String(error?.message || error);
      addDebugSegment('segment-error', item.error);
    }
  }


  return { init };
}
