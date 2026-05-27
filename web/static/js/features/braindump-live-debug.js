import { API } from '../core/config.js';
import { getAuthHeaders } from '../api/http.js';
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
    segments: [],
    candidates: [],
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
    try {
      const access = await fetch(`${API}/api/braindump/v2/access`, {
        headers: getAuthHeaders(),
        credentials: 'include',
      });
      if (!access.ok) {
        scheduleInitRetry();
        return;
      }
      const data = await access.json();
      if (!data.enabled) return;
    } catch {
      scheduleInitRetry();
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
        <div class="bd-card"><h4>JSON Kandidaten</h4><pre id="bd-json" class="bd-json">[]</pre></div>
      </div>
    `;
    todoList.parentNode.insertBefore(panel, todoList);
    document.getElementById('bd-start')?.addEventListener('click', start);
    document.getElementById('bd-stop')?.addEventListener('click', stop);
  }

  function scheduleInitRetry() {
    if (state.initAttempts >= 8 || document.getElementById('braindump-live-debug')) return;
    state.initAttempts += 1;
    setTimeout(init, 1500);
  }

  function render() {
    const elapsed = state.recording ? (performance.now() - state.startedAt) / 1000 : (state.startedAt ? (state.stoppedAt - state.startedAt) / 1000 : 0);
    const waiting = state.queue.length + state.active;
    if (state.stoppedAt && waiting === 0 && !state.finalJsonAt) state.finalJsonAt = performance.now();
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
    state.candidates = [];
    state.queue = [];
    state.active = 0;
    state.audioChunks = [];
    state.mediaChunks = 0;
    state.lastSnapshotChunkCount = 0;
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
      status: `${reason} queued (${Math.round(blob.size / 1024)} KiB, ${state.audioChunks.length} chunks)`,
      transcript: '',
      timing: null,
    };
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
      item.status = 'done';
      item.transcript = data.transcript || '';
      item.timing = data.timing;
      item.wallMs = Math.round(performance.now() - started);
      const next = Array.isArray(data.json?.candidates) ? data.json.candidates : [];
      if (next.length) state.candidates = dedupe([...state.candidates, ...next]);
      if (!next.length) item.status = 'done (no candidates)';
    } catch (error) {
      item.status = 'error';
      item.error = String(error?.message || error);
      addDebugSegment('segment-error', item.error);
    }
  }

  function dedupe(candidates) {
    const seen = new Set();
    const result = [];
    for (const candidate of candidates) {
      const key = String(candidate.title || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
    return result;
  }

  return { init };
}
