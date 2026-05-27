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
    maxWorkers: 2,
    segments: [],
    candidates: [],
    timer: null,
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
          <div class="bd-subtitle">Roher Test: live sprechen → Fenster senden → JSON + Zeiten sehen</div>
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
        <span>Status: idle</span><span>Aufnahme: 0.0s</span><span>Stop→JSON: –</span><span>Queue: 0</span>
      </div>
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
    const stopToJson = state.stoppedAt && waiting === 0 ? `${((performance.now() - state.stoppedAt) / 1000).toFixed(2)}s` : (state.stoppedAt ? 'läuft…' : '–');
    const status = state.recording ? 'recording' : (waiting ? 'processing' : 'idle/ready');
    const metrics = document.getElementById('bd-metrics');
    if (metrics) {
      metrics.innerHTML = `<span>Status: ${status}</span><span>Aufnahme: ${elapsed.toFixed(1)}s</span><span>Stop→JSON: ${stopToJson}</span><span>Queue: ${waiting}</span>`;
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
    state.segments = [];
    state.candidates = [];
    state.queue = [];
    state.active = 0;
    state.segmentId = 0;
    state.startedAt = performance.now();
    state.stoppedAt = 0;
    state.lastChunkAt = state.startedAt;
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
    state.recorder.addEventListener('dataavailable', onChunk);
    state.recorder.addEventListener('stop', () => {
      state.stream?.getTracks().forEach((track) => track.stop());
      state.stream = null;
    });
    state.recording = true;
    document.getElementById('bd-start').disabled = true;
    document.getElementById('bd-stop').disabled = false;
    state.timer = setInterval(render, 100);
    state.recorder.start(4000);
    render();
  }

  async function stop() {
    if (!state.recording) return;
    state.recording = false;
    state.stoppedAt = performance.now();
    state.recorder?.stop();
    document.getElementById('bd-start').disabled = false;
    document.getElementById('bd-stop').disabled = true;
    render();
  }

  function onChunk(event) {
    const now = performance.now();
    const audioStartMs = Math.round(state.lastChunkAt - state.startedAt);
    const audioEndMs = Math.round(now - state.startedAt);
    state.lastChunkAt = now;
    if (!event.data || event.data.size < 1200 || audioEndMs - audioStartMs < 1000) {
      render();
      return;
    }
    const segmentId = ++state.segmentId;
    const item = { segmentId, audioStartMs, audioEndMs, status: 'queued', transcript: '', timing: null };
    state.segments.push(item);
    state.queue.push({ item, blob: event.data });
    pump();
    render();
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
      headers['Content-Type'] = blob.type || 'audio/webm';
      const params = new URLSearchParams({
        segment_id: String(item.segmentId),
        audio_start_ms: String(item.audioStartMs),
        audio_end_ms: String(item.audioEndMs),
        model,
      });
      const response = await fetch(`${API}/api/braindump/v2/live/audio-segment?${params}`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: blob,
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      item.status = 'done';
      item.transcript = data.transcript || '';
      item.timing = data.timing;
      item.wallMs = Math.round(performance.now() - started);
      const next = Array.isArray(data.json?.candidates) ? data.json.candidates : [];
      state.candidates = dedupe([...state.candidates, ...next]);
    } catch (error) {
      item.status = 'error';
      item.error = String(error?.message || error);
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
