import { createEntityMutationQueue, sameEntityId } from './entity-metadata.js';

export const TRANSFER_RECIPE_TO_SHOPPING = 'TRANSFER_RECIPE_TO_SHOPPING';
export const isRecipeShoppingTransfer = entry => entry?.action === TRANSFER_RECIPE_TO_SHOPPING;
export const transferReferencesCookbook = (entry, id) => isRecipeShoppingTransfer(entry) && sameEntityId(entry.data?.cookbook_id, id);
export const transferReferencesRecipe = (entry, id) => isRecipeShoppingTransfer(entry) && sameEntityId(entry.data?.recipe_id, id);
export function sanitizeRecipeShoppingTransfer(entry) {
  if (!isRecipeShoppingTransfer(entry)) return null;
  const data = entry.data || {};
  return { ...entry, data: {
    cookbook_id: data.cookbook_id, recipe_id: data.recipe_id, shopping_list_id: data.shopping_list_id,
    servings: data.servings, expected_revision: data.expected_revision,
    client_mutation_id: data.client_mutation_id,
    ...(data.source_mutation_id != null ? { source_mutation_id: data.source_mutation_id } : {}),
    ingredients: (data.ingredients || []).map(row => ({ ingredient_client_key: row.ingredient_client_key,
      section_id: row.section_id ?? null, store_ids: [...(row.store_ids || [])],
      ...(row.merge_group != null ? { merge_group: row.merge_group } : {}) })),
  } };
}
export function recipeShoppingTransferPayload(entry) {
  const { cookbook_id, recipe_id, ...payload } = sanitizeRecipeShoppingTransfer(entry).data;
  return payload;
}
/** Only identities awaiting their first dispatch may change. Attempted bodies are frozen. */
export function rewriteRecipeShoppingTransfer(entry, { recipeIdFrom, recipeIdTo, cookbookIdFrom, cookbookIdTo,
  listIdFrom, listIdTo, sectionIdFrom, sectionIdTo, storeIdFrom, storeIdTo } = {}) {
  if (!isRecipeShoppingTransfer(entry) || entry.attempted) return entry;
  const next = sanitizeRecipeShoppingTransfer(entry), data = next.data;
  if (sameEntityId(data.recipe_id, recipeIdFrom)) data.recipe_id = recipeIdTo;
  if (sameEntityId(data.cookbook_id, cookbookIdFrom)) data.cookbook_id = cookbookIdTo;
  if (sameEntityId(data.shopping_list_id, listIdFrom)) data.shopping_list_id = listIdTo;
  data.ingredients = data.ingredients.map(row => ({ ...row,
    section_id: sameEntityId(row.section_id, sectionIdFrom) ? sectionIdTo : row.section_id,
    store_ids: row.store_ids.map(id => sameEntityId(id, storeIdFrom) ? storeIdTo : id) }));
  return next;
}
const pendingId = id => typeof id === 'string' && id.startsWith('temp-');
export function transferHasPendingDependencies(entry, queue) {
  if (!isRecipeShoppingTransfer(entry)) return false;
  const data = entry.data;
  if ([data.recipe_id, data.cookbook_id, data.shopping_list_id,
    ...data.ingredients.flatMap(row => [row.section_id, ...row.store_ids])].some(pendingId)) return true;
  return queue.some(row => row.id !== entry.id && Number(row.id) < Number(entry.id)
    && (row.actor_id == null || sameEntityId(row.actor_id, entry.actor_id)) && (
    (['CREATE_RECIPE', 'UPDATE_RECIPE', 'DELETE_RECIPE'].includes(row.action)
      && sameEntityId(row.data?.id ?? row.data?.temp_id, data.recipe_id))
    || row.action === 'DELETE_COOKBOOK' && sameEntityId(row.data?.id, data.cookbook_id)));
}
export function transferSourceIsAccessible(entry, books, queue = []) {
  const book = books.find(book => sameEntityId(book.id, entry.data.cookbook_id));
  const later = row => Number(row.id) > Number(entry.id);
  const locallyDeletedBook = queue.some(row => later(row) && row.action === 'DELETE_COOKBOOK' && sameEntityId(row.data?.id, entry.data.cookbook_id));
  const locallyDeletedRecipe = queue.some(row => later(row) && row.action === 'DELETE_RECIPE' && sameEntityId(row.data?.id, entry.data.recipe_id));
  // An ambiguous request may already have copied a recipe subsequently deleted
  // on another device. Its receipt remains replayable within the known book.
  return Boolean(book?.recipes?.some(recipe => sameEntityId(recipe.id, entry.data.recipe_id))
    || book && (locallyDeletedRecipe || entry.attempted) || locallyDeletedBook);
}

/** Queue-only transfer: the server owns all quantity scaling and Shopping merges. */
export function createRecipeShoppingTransferController({ getCookbooks = () => [], getLists = () => [], getStores = () => [],
  getCurrentUser = () => null, getSessionIdentity = () => null, readQueue = async () => [], commit,
  enqueueListMutation = null, isOnlineForSync = () => false, syncWithServer = async () => {}, onError = console.error,
  createMutationId = () => `recipe-shopping-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  const run = enqueueListMutation || createEntityMutationQueue({ getSessionIdentity });
  const recipes = () => getCookbooks().flatMap(book => (book.recipes || []).map(recipe => ({ book, recipe })));
  const ownReceipt = (row, identity, actor) => actor != null && sameEntityId(row?.created_by_user_id, actor)
    && row.client_mutation_id != null && sameEntityId(row.client_mutation_id, identity);
  const findRecipe = (id, previous, actor) => recipes().find(row => sameEntityId(row.recipe.id, id))
    || (previous && sameEntityId(previous.recipe.created_by_user_id, actor)
      ? recipes().find(row => ownReceipt(row.recipe, previous.recipe.client_mutation_id, actor)) : null);
  const findList = (id, previous, actor) => getLists().find(row => sameEntityId(row.id, id))
    || (previous && (sameEntityId(previous.created_by_user_id, actor) || previous.is_pending === true && pendingId(previous.id))
      ? getLists().find(row => ownReceipt(row, previous.client_mutation_id, actor)) : null);
  async function transfer({ recipeId, shoppingListId, servings, ingredients, clientMutationId = createMutationId() }, { isCurrent = () => true } = {}) {
    const actor = getCurrentUser()?.id, session = getSessionIdentity();
    const initialRecipe = findRecipe(recipeId, null, actor), initialList = findList(shoppingListId, null, actor);
    if (actor == null || session == null || !initialRecipe || !initialList || !Number.isFinite(servings) || servings <= 0 || servings > 100000
      || typeof clientMutationId !== 'string' || !clientMutationId.trim() || clientMutationId.length > 200
      || !Array.isArray(ingredients) || !ingredients.length || ingredients.length > 500) return null;
    const selections = structuredClone(ingredients);
    const originalSections = initialList.sections || [], originalStores = getStores().filter(row => sameEntityId(row.shopping_list_id, initialList.id));
    const current = () => session === getSessionIdentity() && sameEntityId(getCurrentUser()?.id, actor) && isCurrent();
    return run(initialList.client_mutation_id ?? initialList.id, async () => {
      if (!current()) return null;
      const result = await commit(async () => {
        const queue = await readQueue();
        if (!current()) return null;
        const source = findRecipe(recipeId, initialRecipe, actor), list = findList(shoppingListId, initialList, actor);
        const duplicate = queue.find(row => isRecipeShoppingTransfer(row) && sameEntityId(row.actor_id, actor)
          && (sameEntityId(row.data?.client_mutation_id, clientMutationId.trim()) || sameEntityId(row.data?.recipe_id, source?.recipe.id)));
        if (duplicate) return duplicate;
        if (!source || !list || !(list.can_edit === true || list.can_edit === 1) || source.recipe.conflict) return null;
        const available = new Set((source.recipe.ingredient_groups || []).flatMap(group => group.ingredients || []).map(row => row.client_key));
        const keys = new Set();
        const resolve = (id, rows, previous) => {
          if (id == null) return null;
          const exact = rows.find(row => sameEntityId(row.id, id));
          if (exact) return exact.id;
          const old = previous.find(row => sameEntityId(row.id, id));
          return old && (sameEntityId(old.created_by_user_id, actor) || old.is_pending === true && pendingId(old.id))
            ? rows.find(row => ownReceipt(row, old.client_mutation_id, actor))?.id : undefined;
        };
        const selected = [];
        for (const row of selections) {
          if (!available.has(row.ingredient_client_key) || keys.has(row.ingredient_client_key) || !Array.isArray(row.store_ids ?? []) || (row.store_ids || []).length > 50) return null;
          if (row.merge_group != null && (typeof row.merge_group !== 'string' || !row.merge_group.trim() || row.merge_group.trim().length > 200)) return null;
          keys.add(row.ingredient_client_key);
          const section = resolve(row.section_id, list.sections || [], originalSections);
          const stores = (row.store_ids || []).map(id => resolve(id, getStores().filter(store => sameEntityId(store.shopping_list_id, list.id)), originalStores));
          if (section === undefined || stores.some(id => id == null) || new Set(stores.map(String)).size !== stores.length) return null;
          selected.push({ ingredient_client_key: row.ingredient_client_key, section_id: section, store_ids: stores,
            ...(row.merge_group != null ? { merge_group: row.merge_group.trim() } : {}) });
        }
        const pending = queue.filter(row => ['CREATE_RECIPE', 'UPDATE_RECIPE'].includes(row.action)
          && sameEntityId(row.data?.id ?? row.data?.temp_id, source.recipe.id) && sameEntityId(row.actor_id, actor)).at(-1);
        if (!Number.isSafeInteger(source.recipe.revision) || source.recipe.revision < 0) return null;
        return { action: TRANSFER_RECIPE_TO_SHOPPING, actor_id: actor, data: {
          recipe_id: source.recipe.id, cookbook_id: source.book.id, shopping_list_id: list.id,
          servings, expected_revision: source.recipe.revision, client_mutation_id: clientMutationId.trim(), ingredients: selected,
          ...(pending?.data.client_mutation_id ? { source_mutation_id: pending.data.client_mutation_id } : {}) } };
      });
      if (!result || !current()) return null;
      if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
      return { client_mutation_id: result.data.client_mutation_id, shopping_list_id: result.data.shopping_list_id,
        status: result.blocked ? 'blocked' : 'queued' };
    });
  }
  async function cancel(clientMutationId) {
    const actor = getCurrentUser()?.id, session = getSessionIdentity();
    if (actor == null || session == null) return false;
    return run(clientMutationId, () => commit(() => session === getSessionIdentity() && sameEntityId(getCurrentUser()?.id, actor)
      ? { cancelMutationId: clientMutationId, actor_id: actor } : null));
  }
  const listPending = async () => {
    const actor = getCurrentUser()?.id, session = getSessionIdentity();
    if (actor == null || session == null) return [];
    const queue = await readQueue();
    if (session !== getSessionIdentity() || !sameEntityId(actor, getCurrentUser()?.id)) return [];
    return queue.filter(row => isRecipeShoppingTransfer(row) && sameEntityId(row.actor_id, actor)).map(row => ({ ...row,
      status: row.blocked ? 'blocked' : 'queued', can_cancel: !row.attempted || Boolean(row.blocked),
      client_mutation_id: row.data.client_mutation_id, recipe_id: row.data.recipe_id }));
  };
  return { transfer, cancel, listPending };
}
