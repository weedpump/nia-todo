import { safeColor, safeIconName } from '../icons/lucide-icons.js';

/** Request-private learning intent belongs in the durable queue, never content. */
export function withoutPrivateRoutingMetadata(value) {
  const { routing_feedback, braindump_route, ...content } = value || {};
  return content;
}

export function sameEntityId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

export function createOptimisticMetadataEntity({ id, name, description, color = '#6366f1', icon = null, sort_order = 0,
  createdAt = new Date().toISOString(), household = null, householdManager = false, ownerUserId = null } = {}) {
  const householdOwned = household?.id != null;
  return {
    id, name: String(name || '').trim(), ...(description !== undefined ? { description: String(description || '').trim() } : {}),
    color: safeColor(color, '#6366f1'), icon: safeIconName(icon) || null, sort_order,
    created_at: createdAt, updated_at: createdAt,
    owner_user_id: householdOwned ? null : ownerUserId, owner_household_id: householdOwned ? household.id : null,
    ownership_type: householdOwned ? 'household' : 'user', household_name: householdOwned ? household.name || null : null,
    can_edit: true, can_manage: !householdOwned || householdManager === true,
    is_owner: !householdOwned || householdManager === true, is_shared: householdOwned && householdManager !== true,
    is_pending: true, client_mutation_id: id,
  };
}

export function updateMetadataProjection(entity, changes, updatedAt = new Date().toISOString()) {
  if (!entity) return null;
  return {
    ...entity,
    ...(Object.hasOwn(changes, 'name') ? { name: String(changes.name || '').trim() } : {}),
    ...(Object.hasOwn(changes, 'description') ? { description: String(changes.description || '').trim() } : {}),
    ...(Object.hasOwn(changes, 'color') ? { color: safeColor(changes.color, entity.color || '#6366f1') } : {}),
    ...(Object.hasOwn(changes, 'icon') ? { icon: safeIconName(changes.icon) || null } : {}),
    ...(Object.hasOwn(changes, 'sort_order') ? { sort_order: changes.sort_order } : {}),
    updated_at: updatedAt, is_pending: true,
  };
}

/** Pure metadata queue/snapshot rules; domain children stay in their module. */
export function createMetadataCollection({ storeName, createAction, updateAction, deleteAction,
  fields = ['name', 'description', 'color', 'icon', 'sort_order'], canManage = null } = {}) {
  const actions = new Set([createAction, updateAction, deleteAction]);
  const pick = (source, allowed = fields) => Object.fromEntries(allowed.filter(key => Object.hasOwn(source || {}, key)).map(key => [key, source[key]]));
  const idFor = entry => actions.has(entry?.action) ? entry.data?.id ?? entry.data?.temp_id ?? null : null;
  const references = (entry, id) => sameEntityId(idFor(entry), id);
  const hasPendingCreate = (queue, id) => queue.some(entry => entry.action === createAction && sameEntityId(entry.data?.temp_id ?? entry.data?.id, id));
  function projectPending(entity, queue) {
    if (!entity) return null;
    let projected = { ...entity };
    if (canManage && Object.hasOwn(entity, 'can_manage') && !canManage(entity)) return projected;
    for (const entry of queue || []) {
      if (!references(entry, entity.id)) continue;
      if (entry.action === deleteAction) return null;
      if (entry.action === updateAction) projected = { ...projected, ...pick(entry.data?.changes), is_pending: true };
    }
    return projected;
  }
  function rewriteQueue(queue, { from, to }) {
    return queue.map(entry => {
      if (!references(entry, from)) return entry;
      return { ...entry, data: { ...entry.data,
        ...(sameEntityId(entry.data.id, from) ? { id: to } : {}),
        ...(entry.action === createAction && sameEntityId(entry.data.temp_id, from) ? { temp_id: to } : {}),
      } };
    });
  }
  const ownReceipt = (entity, actorId) => actorId == null || sameEntityId(entity.created_by_user_id, actorId);
  function collectRevokedIds(server, local, queue, { resolveQueueId = idFor, actorId = null } = {}) {
    const accessible = new Set(server.map(entity => String(entity.id)));
    const candidates = new Map(local.filter(entity => entity.id != null).map(entity => [String(entity.id), entity.id]));
    for (const entry of queue) {
      const id = resolveQueueId(entry);
      if (id != null) candidates.set(String(id), id);
    }
    const confirmed = new Set(server.filter(entity => ownReceipt(entity, actorId)).map(entity => entity.client_mutation_id).filter(id => id != null).map(String));
    return [...candidates.values()].filter(id => !accessible.has(String(id)) && !confirmed.has(String(id)) && !hasPendingCreate(queue, id));
  }
  function projectSnapshot(server, local, queue, { project = projectPending, rewrite = (records, from, to) => rewriteQueue(records, { from, to }), actorId = null } = {}) {
    let projectedQueue = queue;
    const confirmed = new Set();
    for (const entity of server) {
      if (entity.client_mutation_id == null || !ownReceipt(entity, actorId)) continue;
      confirmed.add(String(entity.client_mutation_id));
      projectedQueue = rewrite(projectedQueue, entity.client_mutation_id, entity.id);
    }
    const ids = new Set(server.map(entity => String(entity.id)));
    const result = server.map(entity => project(entity, projectedQueue)).filter(Boolean);
    for (const entity of local) {
      if (ids.has(String(entity.id)) || confirmed.has(String(entity.id)) || confirmed.has(String(entity.client_mutation_id)) || !hasPendingCreate(queue, entity.id)) continue;
      const projected = project(entity, projectedQueue);
      if (projected) result.push(projected);
    }
    return result;
  }
  function reconcileSnapshot(server, local, queue, { actorId = null } = {}) {
    let nextQueue = queue;
    const queueDeleteIds = [];
    const removeIds = [];
    const remaps = [];
    for (const entity of server) {
      const cmi = entity.client_mutation_id;
      if (cmi == null || !ownReceipt(entity, actorId)) continue;
      const pending = nextQueue.filter(entry => entry.action === createAction && sameEntityId(entry.data?.client_mutation_id, cmi));
      for (const entry of pending) {
        const from = entry.data.temp_id ?? entry.data.id;
        queueDeleteIds.push(entry.id);
        if (!sameEntityId(from, entity.id)) { removeIds.push(from); remaps.push([from, entity.id]); }
        nextQueue = rewriteQueue(nextQueue, { from, to: entity.id });
      }
      nextQueue = nextQueue.filter(entry => !queueDeleteIds.some(id => sameEntityId(id, entry.id)));
    }
    if (canManage) {
      const readOnly = new Set(server.filter(entity => Object.hasOwn(entity, 'can_manage') && !canManage(entity)).map(entity => String(entity.id)));
      nextQueue = nextQueue.filter(entry => {
        if ([updateAction, deleteAction].includes(entry.action) && readOnly.has(String(idFor(entry)))) {
          queueDeleteIds.push(entry.id);
          return false;
        }
        return true;
      });
    }
    const revokedIds = collectRevokedIds(server, local, nextQueue, { actorId });
    nextQueue = nextQueue.filter(entry => {
      if (!revokedIds.some(id => references(entry, id))) return true;
      queueDeleteIds.push(entry.id);
      return false;
    });
    const entities = projectSnapshot(server, local, nextQueue, { actorId });
    const remainingIds = new Set(entities.map(entity => String(entity.id)));
    return { entities, queueRecords: nextQueue.filter(entry => actions.has(entry.action)), queueDeleteIds,
      removeIds: [...new Set([...removeIds, ...revokedIds, ...local.filter(entity => !remainingIds.has(String(entity.id))).map(entity => entity.id)])],
      remaps, revokedIds };
  }
  function sanitize(entry) {
    if (!actions.has(entry?.action)) return null;
    const data = entry.data || {};
    return { ...entry, data: entry.action === createAction
      ? { ...pick(data, [...fields, 'household_id', 'client_mutation_id']), temp_id: data.temp_id }
      : entry.action === updateAction ? { id: data.id, changes: pick(data.changes) } : { id: data.id } };
  }
  return Object.freeze({ storeName, createAction, updateAction, deleteAction, actions, fields, pick, idFor,
    references, hasPendingCreate, projectPending, rewriteQueue, collectRevokedIds, projectSnapshot, reconcileSnapshot, sanitize });
}

export function createEntityMutationQueue({ getSessionIdentity = () => null } = {}) {
  const queues = new Map();
  return (identity, task) => {
    const session = getSessionIdentity();
    const key = `${String(session)}\u0000${String(identity)}`;
    const previous = queues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => getSessionIdentity() === session ? task() : null);
    queues.set(key, operation);
    operation.finally(() => { if (queues.get(key) === operation) queues.delete(key); }).catch(() => {});
    return operation;
  };
}
