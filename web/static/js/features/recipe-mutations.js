import { createEntityMutationQueue, sameEntityId } from './entity-metadata.js';
import { editableRecipe, pickRecipeFields, validateRecipeChanges, mergeRecipeStepIngredients } from './recipe-pending.js';

export function createRecipeController({ getCookbooks = () => [], setCookbooks = () => {}, commitMutation,
  enqueueCookbookMutation, getSessionIdentity = () => null, getCurrentUser = () => null, recipesApi,
  isOnlineForSync = () => false, syncWithServer = async () => {}, onError = console.error,
  createTempId = () => `temp-recipe-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
} = {}) {
  const run = enqueueCookbookMutation || createEntityMutationQueue({ getSessionIdentity });
  const aliases = new Map();
  const all = () => {
    const rows = getCookbooks().flatMap(book => (book.recipes || []).map(recipe => ({ book, recipe })));
    const actor = getCurrentUser()?.id;
    for (const { recipe } of rows) if (actor != null && sameEntityId(recipe.created_by_user_id, actor)
      && String(recipe.id).startsWith('temp-recipe-') && recipe.client_mutation_id != null) {
      aliases.set(String(recipe.id), { cmi: recipe.client_mutation_id, actor, session: getSessionIdentity() });
    }
    return rows;
  };
  all(); // Also remember custom mutation identities restored from the offline cache.
  const find = identity => {
    const rows = all();
    const exact = rows.find(({ recipe }) => sameEntityId(recipe.id, identity));
    if (exact) return exact;
    const actor = getCurrentUser()?.id;
    const alias = aliases.get(String(identity));
    const cmi = alias?.session === getSessionIdentity() && sameEntityId(alias.actor, actor) ? alias.cmi : identity;
    return actor == null ? null : rows.find(({ recipe }) => sameEntityId(recipe.client_mutation_id, cmi) && sameEntityId(recipe.created_by_user_id, actor));
  };
  const getRecipe = identity => find(identity)?.recipe ?? null;
  const resolveId = identity => getRecipe(identity)?.id ?? null;
  const bookFor = identity => getCookbooks().find(book => sameEntityId(book.id, identity))
    || getCookbooks().find(book => sameEntityId(book.client_mutation_id, identity) && sameEntityId(book.created_by_user_id, getCurrentUser()?.id));
  const identityFor = book => sameEntityId(book.created_by_user_id, getCurrentUser()?.id) ? book.client_mutation_id ?? book.id : book.id;
  function publish(mutation, session) {
    if (!mutation || getSessionIdentity() !== session) return null;
    setCookbooks(getCookbooks().map(book => sameEntityId(book.id, mutation.cookbook.id) ? mutation.cookbook : book));
    if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(onError);
    return mutation.result ?? null;
  }
  function changedBook(book, recipe, removeId = null) {
    const recipes = (book.recipes || []).filter(row => !sameEntityId(row.id, recipe?.id ?? removeId));
    if (recipe) recipes.push(recipe);
    return { ...book, recipes, recipe_count: recipes.length };
  }
  async function create(cookbookId, input, { isCurrent = () => true } = {}) {
    const fields = validateRecipeChanges(input, true);
    const session = getSessionIdentity();
    const initial = bookFor(cookbookId);
    if (!fields || !initial || session == null) return null;
    const cmi = typeof input.client_mutation_id === 'string' ? input.client_mutation_id.trim() : input.client_mutation_id ?? createTempId();
    if (typeof cmi !== 'string' || !cmi.trim() || cmi.length > 200) return null;
    const id = cmi.startsWith('temp-recipe-') ? cmi : createTempId();
    return run(identityFor(initial), async () => {
      if (getSessionIdentity() !== session || !isCurrent()) return null;
      const duplicate = all().find(({ recipe }) => sameEntityId(recipe.client_mutation_id, cmi) && sameEntityId(recipe.created_by_user_id, getCurrentUser()?.id));
      if (duplicate) return duplicate.recipe;
      const mutation = await commitMutation(() => {
        const book = bookFor(cookbookId);
        if (getSessionIdentity() !== session || !isCurrent() || !editableRecipe(book)) return null;
        const recipe = { ...fields, id, cookbook_id: book.id, client_mutation_id: cmi, created_by_user_id: getCurrentUser()?.id,
          revision: 0, can_edit: true, pending: true, created_at: new Date().toISOString() };
        return { cookbook: changedBook(book, recipe), recipe, action: 'CREATE_RECIPE',
          data: { ...fields, cookbook_id: book.id, temp_id: id, client_mutation_id: cmi }, actor_id: getCurrentUser()?.id, result: recipe };
      });
      if (mutation) aliases.set(String(id), { cmi, session, actor: getCurrentUser()?.id });
      return publish(mutation, session);
    });
  }
  async function change(identity, fields, deleting, { isCurrent = () => true, expectedRevision } = {}) {
    const session = getSessionIdentity();
    const initial = find(identity);
    if (session == null || !initial) return null;
    const changes = deleting ? {} : validateRecipeChanges(fields);
    if (!changes || !deleting && !Object.keys(changes).length) return null;
    return run(identityFor(initial.book), async () => {
      const mutation = await commitMutation(() => {
        const current = find(identity);
        if (getSessionIdentity() !== session || !isCurrent() || !editableRecipe(current?.book) || current.recipe.conflict) return null;
        if (!deleting && !validateRecipeChanges(mergeRecipeStepIngredients(current.recipe, changes), true)) return null;
        // A draft opened before its own create receipt has no server revision yet.
        // Rebase only that initial baseline to 1, never to a later foreign revision.
        const revision = expectedRevision === 0 && current.recipe.revision > 0
          && sameEntityId(current.recipe.created_by_user_id, getCurrentUser()?.id) ? 1 : expectedRevision ?? current.recipe.revision;
        if (!Number.isInteger(revision) || revision < 0) return null;
        const recipe = deleting ? null : { ...mergeRecipeStepIngredients(current.recipe, changes), pending: true };
        return { cookbook: changedBook(current.book, recipe, current.recipe.id), recipe, deleteRecipeId: deleting ? current.recipe.id : null,
          action: deleting ? 'DELETE_RECIPE' : 'UPDATE_RECIPE', actor_id: getCurrentUser()?.id,
          data: { id: current.recipe.id, cookbook_id: current.book.id, expected_revision: revision, client_mutation_id: createTempId(), ...(!deleting ? { changes } : {}) },
          result: deleting ? current.recipe : recipe };
      });
      return publish(mutation, session);
    });
  }
  async function resolveConflict(identity, { keepLocal, isCurrent = () => true } = {}) {
    const session = getSessionIdentity();
    const initial = find(identity);
    if (!initial?.recipe.conflict || session == null || !recipesApi) return null;
    return run(identityFor(initial.book), async () => {
      const latest = await recipesApi.getRecipe(initial.recipe.id);
      if (!editableRecipe(latest)) return null;
      const mutation = await commitMutation(() => {
        const current = find(identity);
        if (getSessionIdentity() !== session || !isCurrent() || !editableRecipe(current?.book) || !current.recipe.conflict) return null;
        const conflict = current.recipe.conflict;
        const deleting = keepLocal && conflict.operation === 'delete';
        const changes = keepLocal ? pickRecipeFields(mergeRecipeStepIngredients(latest, current.recipe)) : null;
        const recipe = deleting ? null : { ...mergeRecipeStepIngredients(latest, changes || {}), ...(keepLocal ? { pending: true } : {}) };
        if (recipe) delete recipe.conflict;
        return { cookbook: changedBook(current.book, recipe, current.recipe.id), recipe, deleteRecipeId: deleting ? current.recipe.id : null,
          clearRecipeQueueId: current.recipe.id, actor_id: getCurrentUser()?.id,
          ...(keepLocal ? { action: deleting ? 'DELETE_RECIPE' : 'UPDATE_RECIPE', data: { id: latest.id, cookbook_id: current.book.id,
            expected_revision: latest.revision, client_mutation_id: createTempId(), ...(!deleting ? { changes } : {}) } } : {}), result: recipe ?? current.recipe };
      });
      return publish(mutation, session);
    });
  }
  return { create, update: (id, changes, options) => change(id, changes, false, options),
    remove: (id, options) => change(id, {}, true, options), resolveConflict, getRecipe, resolveId };
}
