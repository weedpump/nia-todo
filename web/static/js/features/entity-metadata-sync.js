import { acquireSyncCommitLock } from './todo-pending.js';
import { sameEntityId } from './entity-metadata.js';

/** One metadata-only replay path; API/collection/storage are configured. */
export function createMetadataSyncAdapter({ contract, api, getEntities, setEntities, readQueue,
  markAttempt, commitReplay, onIdRemap = () => {}, render = () => {} } = {}) {
  async function withCurrentReceipt(item, ref, generation, apply) {
    const release = await acquireSyncCommitLock(ref);
    try {
      if (Number(ref?.privacyGeneration || 0) !== generation) return false;
      const queue = await readQueue();
      if (!queue.some(entry => sameEntityId(entry.id, item.id) && entry.action === item.action)) return false;
      return await apply(queue);
    } finally { release(); }
  }
  async function commit(item, server, ref, generation) {
    const from = contract.idFor(item);
    const created = item.action === contract.createAction;
    const to = created ? server?.id ?? from : from;
    const committed = await withCurrentReceipt(item, ref, generation, async queue => {
      let remaining = queue.filter(entry => !sameEntityId(entry.id, item.id));
      if (created) remaining = contract.rewriteQueue(remaining, { from, to });
      const forbidden = server?.can_manage === false || server?.can_manage === 0;
      const discard = remaining.filter(entry => (contract.references(entry, to) || !server && contract.dependentReferences?.(entry, to))
        && (!server || (forbidden && [contract.updateAction, contract.deleteAction].includes(entry.action))));
      remaining = remaining.filter(entry => !discard.some(rejected => sameEntityId(rejected.id, entry.id)));
      const projected = server ? contract.projectPending(server, remaining) : null;
      const removeIds = [...(created && !sameEntityId(from, to) ? [from] : []), ...(!projected ? [to] : [])].filter(id => id != null);
      const applied = await commitReplay({ entity: projected, removeIds, queueRecords: remaining.filter(entry => (contract.queueActions || contract.actions).has(entry.action)),
        queueDeleteId: item.id, queueDeleteIds: discard.map(entry => entry.id), requireQueueId: item.id });
      if (applied === false) return false;
      const next = getEntities().filter(entity => !removeIds.some(id => sameEntityId(id, entity.id)) && !sameEntityId(entity.id, to));
      setEntities(projected ? [...next, projected] : next);
      render();
      return true;
    });
    if (committed && created && from != null && to != null) onIdRemap(from, to);
    return committed;
  }
  async function replay(queued, ref, generation) {
    if (!api || !markAttempt || !commitReplay) throw new Error('Metadata synchronization adapter is not configured');
    let item = null;
    await withCurrentReceipt(queued, ref, generation, async () => {
      const marked = await markAttempt(queued.id);
      item = marked ? contract.sanitize(marked) : null;
      return Boolean(item);
    });
    if (!item) return false;
    if (Number(ref?.privacyGeneration || 0) !== generation) return false;
    try {
      let server = null;
      if (item.action === contract.createAction) server = await api.create(contract.pick(item.data, [...contract.fields, 'household_id', 'client_mutation_id']));
      else if (item.action === contract.updateAction) server = await api.update(item.data.id, item.data.changes);
      else await api.remove(item.data.id);
      return await commit(item, server, ref, generation);
    } catch (error) {
      const status = Number(error?.status);
      if (!(status >= 400 && status < 500) || [401, 408, 429].includes(status)) throw error;
      let server = null;
      if (item.action !== contract.createAction) {
        try { server = await api.read(contract.idFor(item)); }
        catch (recoveryError) { if (![403, 404, 422].includes(Number(recoveryError?.status))) throw recoveryError; }
      }
      return commit(item, server, ref, generation);
    }
  }
  return { replay };
}
