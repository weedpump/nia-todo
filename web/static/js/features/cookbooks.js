import { TRANSFER_RECIPE_TO_SHOPPING, transferReferencesCookbook } from './recipe-shopping-pending.js';
import { recipeActions, recipeBookId, mergeRecipeSnapshot, projectRecipeCookbook, reconcileRecipeSnapshot, rewriteRecipeQueue } from './recipe-pending.js';
import { createEntityMutationQueue, createMetadataCollection, createOptimisticMetadataEntity, sameEntityId, updateMetadataProjection } from './entity-metadata.js';

const metadata = createMetadataCollection({ storeName: 'cookbooks',
  createAction: 'CREATE_COOKBOOK', updateAction: 'UPDATE_COOKBOOK', deleteAction: 'DELETE_COOKBOOK',
  canManage: entity => entity.can_manage === true || entity.can_manage === 1,
});

// Cookbook metadata and its recipe aggregate use one projection/receipt boundary.
export const cookbookMetadata = Object.freeze({ ...metadata,
  queueActions: new Set([...metadata.actions, ...recipeActions, TRANSFER_RECIPE_TO_SHOPPING]),
  dependentReferences: (entry, id) => sameEntityId(recipeBookId(entry), id) || transferReferencesCookbook(entry, id),
  projectPending: (book, queue) => projectRecipeCookbook(metadata.projectPending(book, queue), queue),
  rewriteQueue: (queue, remap) => rewriteRecipeQueue(metadata.rewriteQueue(queue, remap), { ...remap, cookbook: true }),
  reconcileSnapshot(server, local, queue, options = {}) {
    const result = metadata.reconcileSnapshot(mergeRecipeSnapshot(server, local), local, queue, options);
    let next = queue.filter(entry => !result.queueDeleteIds.includes(entry.id));
    for (const [from, to] of result.remaps) next = cookbookMetadata.rewriteQueue(next, { from, to });
    const child = reconcileRecipeSnapshot(result.entities, local, next, { ...options, authoritative: server });
    return { ...result, authoritativeCookbookIds: child.entities.map(book => book.id), entities: child.entities, queueRecords: [...result.queueRecords, ...child.queueRecords],
      queueDeleteIds: [...new Set([...result.queueDeleteIds, ...child.queueDeleteIds])], recipeRemaps: child.remaps };
  },
  projectSnapshot(server, local, queue, options = {}) {
    return cookbookMetadata.reconcileSnapshot(server, local, queue, options).entities;
  },
});

export function createCookbooksController({ getCookbooks = () => [], setCookbooks = () => {}, commitMutation,
  enqueueCookbookMutation = null, getSessionIdentity = null, getCurrentUser = () => null, getAccessSnapshot = () => null,
  isOnlineForSync = () => false, syncWithServer = async () => {}, onError = console.error,
  createTempId = () => `temp-cookbook-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  const session = () => getSessionIdentity ? getSessionIdentity() : 'embedded';
  const run = enqueueCookbookMutation || createEntityMutationQueue({ getSessionIdentity: session });
  const localAliases = new Map();
  const findReceipt = identity => {
    const actor = getCurrentUser()?.id;
    // Embedders without an actor can use exact IDs, never unscoped CMI aliases.
    return actor == null ? null : getCookbooks().find(entity => sameEntityId(entity.client_mutation_id, identity)
      && sameEntityId(entity.created_by_user_id, actor));
  };
  const find = identity => {
    const exact = getCookbooks().find(entity => sameEntityId(entity.id, identity));
    if (exact) return exact;
    const alias = localAliases.get(String(identity));
    return findReceipt(identity) || (alias?.session === session() ? findReceipt(alias.cmi) : null);
  };
  const resolveIdentity = identity => {
    const entity = find(identity);
    return entity && sameEntityId(entity.created_by_user_id, getCurrentUser()?.id)
      ? entity.client_mutation_id ?? entity.id : entity?.id ?? identity;
  };
  const resolveId = identity => find(identity)?.id ?? null;
  const canManage = entity => entity?.can_manage === true || entity?.can_manage === 1;
  function valid(changes, creating = false) {
    const next = cookbookMetadata.pick(changes);
    if (creating || Object.hasOwn(next, 'name')) {
      next.name = String(next.name || '').trim();
      if (!next.name || next.name.length > 200) return null;
    }
    if (creating || Object.hasOwn(next, 'description')) {
      next.description = String(next.description || '').trim();
      if (next.description.length > 4000) return null;
    }
    if (Object.hasOwn(next, 'sort_order') && !Number.isSafeInteger(next.sort_order)) return null;
    return next;
  }
  function publish(mutation, captured) {
    if (!mutation || session() !== captured) return null;
    if (mutation.deleteCookbookId != null) setCookbooks(getCookbooks().filter(entity => !sameEntityId(entity.id, mutation.deleteCookbookId)));
    else if (mutation.cookbook) setCookbooks([...getCookbooks().filter(entity => !sameEntityId(entity.id, mutation.cookbook.id)), mutation.cookbook]);
    if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
    return mutation.result ?? mutation.cookbook ?? null;
  }
  async function create(data, { authorize = () => true, isCurrent = () => true } = {}) {
    const changes = valid(data, true);
    const captured = session();
    if (!changes || captured == null) return null;
    if (data.client_mutation_id != null && (typeof data.client_mutation_id !== 'string' || !data.client_mutation_id.trim() || data.client_mutation_id.length > 200)) return null;
    const cmi = data.client_mutation_id?.trim() || createTempId();
    const id = cmi.startsWith('temp-cookbook-') ? cmi : createTempId();
    return run(cmi, async () => {
      if (session() !== captured || !isCurrent()) return null;
      const duplicate = findReceipt(cmi);
      if (duplicate) return duplicate;
      const mutation = await commitMutation(() => {
        if (session() !== captured || !isCurrent() || !authorize()) return null;
        const household = data.household_id == null ? null : getAccessSnapshot()?.household;
        if (data.household_id != null && !sameEntityId(household?.id, data.household_id)) return null;
        const order = changes.sort_order ?? getCookbooks().reduce((max, entity) => Math.max(max, Number(entity.sort_order) || 0), -1) + 1;
        const cookbook = createOptimisticMetadataEntity({ id, ...changes, sort_order: order, icon: changes.icon ?? 'book-open',
          household, householdManager: household?.role === 'owner', ownerUserId: getCurrentUser()?.id ?? null });
        cookbook.recipes = [];
        cookbook.recipe_count = 0;
        cookbook.created_by_user_id = getCurrentUser()?.id ?? null;
        cookbook.client_mutation_id = cmi;
        return { cookbook, action: cookbookMetadata.createAction,
          data: { ...cookbookMetadata.pick(cookbook), household_id: household?.id ?? null, temp_id: id, client_mutation_id: cmi }, result: cookbook };
      });
      if (mutation) localAliases.set(String(id), { cmi, session: captured });
      return publish(mutation, captured);
    });
  }
  async function update(identity, changes, { authorize = () => true, isCurrent = () => true } = {}) {
    const allowed = valid(changes);
    const captured = session();
    if (!allowed || !Object.keys(allowed).length || captured == null) return null;
    return run(resolveIdentity(identity), async () => {
      const mutation = await commitMutation(() => {
        const current = find(identity);
        if (session() !== captured || !isCurrent() || !canManage(current) || !authorize(current)) return null;
        const cookbook = updateMetadataProjection(current, allowed);
        return { cookbook, action: cookbookMetadata.updateAction, data: { id: current.id, changes: cookbookMetadata.pick(cookbook, Object.keys(allowed)) }, result: cookbook };
      });
      return publish(mutation, captured);
    });
  }
  async function remove(identity, { authorize = () => true, isCurrent = () => true } = {}) {
    const captured = session();
    if (captured == null) return null;
    return run(resolveIdentity(identity), async () => {
      const mutation = await commitMutation(() => {
        const current = find(identity);
        if (session() !== captured || !isCurrent() || !canManage(current) || !authorize(current)) return null;
        return { deleteCookbookId: current.id, action: cookbookMetadata.deleteAction, data: { id: current.id }, result: current };
      });
      return publish(mutation, captured);
    });
  }
  return { create, update, remove, resolveIdentity, resolveId };
}
