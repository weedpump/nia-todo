import { routingMemoryApi } from '../api/routing-memory.js';
import { API } from '../core/config.js';
import { routingMemoryRules as rules } from '../core/routing-memory-rule-data.js';
import { normalizeRoutingName, createPreparedRoutingMatcher } from './routing-memory-matcher.js';

export { normalizeRoutingName };
export { mergeRoutingFeedback } from './routing-memory-matcher.js';
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const cachePrefix = 'nia-routing-memory-v1:';
const fields = new Set(['module', 'list', 'section', 'stores']);

/** Personal proposals only. Every caller retains control over explicit fields.
 * Cached identities are checked against the current recipient's entity snapshot
 * on every lookup; they never authorize a write or change queued requests.
 */
export function createRoutingMemoryFeature({ getActorId = () => null, getSessionIdentity = () => null,
  getLists = () => [], getStores = () => [], getProjects = () => [], getSections = () => [], getEnabled = () => true,
  onEnabledChange = () => {},
  getServerIdentity = () => API || globalThis.location?.origin || 'local',
  api = routingMemoryApi, storage = globalThis.localStorage, eventTarget = globalThis.window,
  createEventId = () => `routing-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  let actor = null, session = null, server = null, epoch = 0, pending = null, state = null, lastEnabledFlag = null;
  let preparedShopping = null, preparedTasks = null;
  const clearPrepared = () => { preparedShopping = preparedTasks = null; };
  const cacheKey = () => `${cachePrefix}${encodeURIComponent(server)}:${actor}`;
  const clean = data => data && typeof data.enabled === 'boolean' && Number.isSafeInteger(data.generation) && data.generation >= 0
    ? { enabled: data.enabled, generation: data.generation, revision: Number.isSafeInteger(data.revision) && data.revision >= 0 ? data.revision : 0, learned_routes: Number(data.learned_routes || 0),
      entries: Array.isArray(data.entries) ? structuredClone(data.entries.filter(row => typeof row?.name_key === 'string' && row.shopping_list_id != null).slice(0, rules.max_model_entries)) : [],
      task_entries: Array.isArray(data.task_entries) ? structuredClone(data.task_entries.filter(row => typeof row?.name_key === 'string' && row.project_id != null).slice(0, rules.max_model_entries)) : [] } : null;
  function notify() {
    eventTarget?.dispatchEvent?.(new CustomEvent('nia-routing-memory-changed', { detail: { enabled: Boolean(state?.enabled), generation: state?.generation ?? 0 } }));
  }
  function context() {
    const nextActor = getActorId(), nextSession = getSessionIdentity(), nextServer = getServerIdentity();
    const nextEnabled = Boolean(getEnabled());
    if (!sameId(nextActor, actor) || nextSession !== session || nextServer !== server) {
      epoch++; actor = nextActor; session = nextSession; server = nextServer; pending = null; state = null; clearPrepared();
      lastEnabledFlag = nextEnabled;
      if (actor != null && session != null) {
        try {
          storage?.removeItem(`${cachePrefix}${actor}`); // Discard pre-namespace development caches.
          state = clean(JSON.parse(storage?.getItem(cacheKey()) || 'null'));
          if (state && !getEnabled()) state = { ...state, enabled: false, entries: [], task_entries: [] };
        } catch { /* No valid offline cache. */ }
      }
    } else if (nextEnabled !== lastEnabledFlag) {
      lastEnabledFlag = nextEnabled;
      if (!nextEnabled) {
        // A new authenticated opt-out must fence even an earlier in-flight GET.
        epoch++; pending = null; clearPrepared();
        if (state) state = { ...state, enabled: false, entries: [], task_entries: [] };
        try { storage?.removeItem(cacheKey()); } catch { /* Memory still disabled. */ }
        notify();
      }
    }
    return actor != null && session != null;
  }
  function authorized(row) {
    const list = getLists().find(list => sameId(list.id, row.shopping_list_id) && (list.can_edit === true || list.can_edit === 1));
    if (!list) return null;
    const sectionValid = row.section_id == null || (list.sections || []).some(section => sameId(section.id, row.section_id));
    const storeIds = Array.isArray(row.store_ids) ? [...new Set(row.store_ids)] : [];
    const storesValid = storeIds.every(id => getStores().some(store => sameId(store.id, id)
      && sameId(store.shopping_list_id, list.id) && store.active !== false && store.active !== 0));
    const history = row.history_fields || ['list', 'section', 'stores'].filter(field => row[`${field}_known`]);
    return { ...row, history_fields: history, section_id: sectionValid ? row.section_id ?? null : null,
      section_known: Boolean(row.section_known && sectionValid), store_ids: storesValid ? storeIds : [],
      stores_known: Boolean(row.stores_known && storesValid) };
  }
  function snapshot() {
    context();
    return { enabled: Boolean(state?.enabled), generation: state?.generation ?? 0, revision: state?.revision ?? 0,
      learned_routes: state?.learned_routes ?? 0, entries: structuredClone((state?.entries || []).map(authorized).filter(Boolean)),
      task_entries: structuredClone((state?.task_entries || []).map(row => authorizedTask(row)).filter(Boolean)) };
  }
  function authorizedTask(row, sectionCatalog = getSections()) {
    const project = getProjects().find(value => sameId(value.id, row.project_id)
      && !value.archived && value.can_edit !== false && value.can_edit !== 0
      && value.can_edit_content !== false && value.can_edit_content !== 0);
    if (!project || !((row.workspace_id == null && project.workspace_id == null) || sameId(row.workspace_id, project.workspace_id))) return null;
    const sectionValid = row.section_id == null || sectionCatalog.some(section => sameId(section.id, row.section_id) && sameId(section.project_id, project.id));
    const listKnown = Boolean(row.list_known ?? row.project_known ?? row.preferred);
    const history = row.history_fields || [...(listKnown ? ['list'] : []), ...(row.section_known ? ['section'] : [])];
    return { ...row, list_known: listKnown, project_known: listKnown, history_fields: history,
      section_id: sectionValid ? row.section_id ?? null : null, section_known: Boolean(row.section_known && sectionValid) };
  }
  function adopt(data, captured) {
    if (!context() || captured !== epoch) return null;
    const next = clean(data);
    if (!next || next.generation < (state?.generation ?? 0)
      || next.generation === state?.generation && next.revision < state.revision) return null;
    state = next; clearPrepared();
    onEnabledChange(next.enabled);
    lastEnabledFlag = Boolean(getEnabled());
    try { storage?.setItem(cacheKey(), JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
    notify();
    return snapshot();
  }
  async function refresh() {
    if (!context()) return snapshot();
    if (pending) { pending.again = true; return pending.promise; }
    const request = { captured: epoch, again: false, promise: null };
    pending = request;
    request.promise = Promise.resolve().then(async () => {
      do {
        request.again = false;
        try {
          const data = await api.read();
          if (request.captured !== epoch) break;
          adopt(data, request.captured);
        } catch { /* Same-account offline cache remains usable. */ }
      } while (request.again && context() && request.captured === epoch);
      return snapshot();
    }).finally(() => { if (pending === request) pending = null; });
    return request.promise;
  }
  // Model analysis is reused only while content visibility is unchanged. These
  // fingerprints also catch mutable in-place permission/section/store changes.
  const identity = value => value == null ? null : String(value);
  function authorizationKey(kind, sectionCatalog) {
    return JSON.stringify(kind === 'shopping' ? [
      getLists().map(list => [identity(list.id), list.can_edit === true || list.can_edit === 1,
        (list.sections || []).map(section => identity(section.id))]),
      getStores().map(store => [identity(store.id), identity(store.shopping_list_id), store.active !== false && store.active !== 0]),
    ] : [
      getProjects().map(project => [identity(project.id), identity(project.workspace_id), Boolean(project.archived),
        project.can_edit !== false && project.can_edit !== 0, project.can_edit_content !== false && project.can_edit_content !== 0]),
      sectionCatalog.map(section => [identity(section.id), identity(section.project_id)]),
    ]);
  }
  function preparedFor(source, kind, sectionCatalog = getSections(), previous = null) {
    const key = authorizationKey(kind, sectionCatalog);
    const cached = previous || (kind === 'shopping' ? preparedShopping : preparedTasks);
    if (cached?.source === source && cached.key === key) return cached;
    const rows = kind === 'shopping' ? (source?.entries || []).map(authorized).filter(Boolean)
      : (source?.task_entries || []).map(row => authorizedTask(row, sectionCatalog)).filter(Boolean);
    const prepared = { source, key, matcher: createPreparedRoutingMatcher(rows), results: new Map() };
    if (source === state) {
      if (kind === 'shopping') preparedShopping = prepared; else preparedTasks = prepared;
    }
    return prepared;
  }
  function memoized(prepared, key, read) {
    const policy = JSON.stringify(rules);
    if (prepared.policy !== policy) { prepared.policy = policy; prepared.results.clear(); }
    if (!prepared.results.has(key)) {
      prepared.results.set(key, read());
      if (prepared.results.size > 128) prepared.results.delete(prepared.results.keys().next().value);
    }
    return structuredClone(prepared.results.get(key));
  }
  function suggest(name, listId = null) {
    if (!context() || !state?.enabled) return null;
    const prepared = preparedFor(state, 'shopping');
    return memoized(prepared, JSON.stringify([normalizeRoutingName(name), identity(listId)]), () => prepared.matcher.suggest(name, listId));
  }
  function suggestTask(name, workspaceId = null, projectId = null, sectionCatalog = getSections()) {
    if (!context() || !state?.enabled) return null;
    const prepared = preparedFor(state, 'tasks', sectionCatalog);
    return memoized(prepared, JSON.stringify([normalizeRoutingName(name), identity(workspaceId), identity(projectId)]),
      () => prepared.matcher.suggestTask(name, workspaceId, projectId));
  }
  function capture() {
    context();
    const source = state, captured = epoch, generation = source?.generation ?? 0;
    let taskModel = null;
    const isCurrent = () => context() && captured === epoch && source?.enabled === true
      && state?.enabled === true && state.generation === generation;
    return Object.freeze({
      generation, isCurrent,
      suggestTask(name, workspaceId = null, projectId = null, sectionCatalog = getSections()) {
        if (!isCurrent()) return null;
        taskModel = preparedFor(source, 'tasks', sectionCatalog, taskModel);
        return memoized(taskModel, JSON.stringify([normalizeRoutingName(name), identity(workspaceId), identity(projectId)]),
          () => taskModel.matcher.suggestTask(name, workspaceId, projectId));
      },
      feedback(chosenFields = [], { eventId = createEventId() } = {}) {
        return { event_id: eventId, generation,
          fields: isCurrent() ? [...new Set(chosenFields.filter(field => fields.has(field)))] : [] };
      },
    });
  }
  function feedback(chosenFields = [], { eventId = createEventId() } = {}) {
    if (!context()) return undefined;
    // An empty envelope distinguishes modern predicted routes from legacy
    // BrainDump clients, even before the first online memory read completes.
    return { event_id: eventId, generation: state?.generation ?? 0,
      fields: state?.enabled ? [...new Set(chosenFields.filter(field => fields.has(field)))] : [] };
  }
  async function change(action) {
    if (!context()) return null;
    const captured = ++epoch;
    pending = null;
    return adopt(await action(), captured);
  }
  function clear() {
    epoch++; state = null; pending = null; clearPrepared();
    try {
      for (let i = (storage?.length || 0) - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith(cachePrefix)) storage.removeItem(key);
      }
    } catch { /* Session invalidation still clears in-memory proposals. */ }
    notify();
  }
  eventTarget?.addEventListener?.('storage', event => {
    if (context() && event.key === cacheKey()) {
      try {
        const next = clean(JSON.parse(event.newValue || 'null'));
        if (!next || next.generation > (state?.generation ?? -1)
          || next.generation === state?.generation && next.revision >= state.revision) {
          // A same-generation cross-tab update is a newer model revision, not
          // a reset. Keep captured saves valid; adopt() rejects older GETs.
          if (!next || next.generation !== state?.generation || next.enabled !== state?.enabled) {
            epoch++; pending = null;
          }
          state = next; clearPrepared();
          if (next) onEnabledChange(next.enabled);
          lastEnabledFlag = Boolean(getEnabled());
          notify();
        }
      } catch { /* Ignore corrupt storage. */ }
    }
  });
  eventTarget?.addEventListener?.('focus', () => { if (context()) void refresh(); });
  return { suggest, suggestTask, feedback, refresh, snapshot, capture, clear, settings: refresh,
    setEnabled: enabled => change(() => api.update(enabled)), reset: () => change(() => api.reset()) };
}
