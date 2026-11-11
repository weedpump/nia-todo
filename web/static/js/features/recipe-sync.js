import { isRecipeShoppingTransfer, transferReferencesRecipe } from './recipe-shopping-pending.js';
import { acquireSyncCommitLock } from './todo-pending.js';
import { sameEntityId } from './entity-metadata.js';
import { pickRecipeFields, projectRecipeCookbook, rebaseRecipeQueue, recipeActions, recipeBookId, recipeId, recipeReferences, rewriteRecipeQueue, sanitizeRecipeEntry } from './recipe-pending.js';

export function createRecipeSyncAdapter({ api, getCookbooks, setCookbooks, readQueue, markAttempt, commitReplay,
  onIdRemap = () => {}, render = () => {} } = {}) {
  async function locked(item, ref, generation, work) {
    const release = await acquireSyncCommitLock(ref);
    try {
      if (Number(ref?.privacyGeneration || 0) !== generation) return false;
      const queue = await readQueue();
      if (!queue.some(row => sameEntityId(row.id, item.id) && row.action === item.action)) return false;
      return await work(queue);
    } finally { release(); }
  }
  async function replay(queued, ref, generation) {
    let item;
    await locked(queued, ref, generation, async () => {
      const marked = await markAttempt(queued.id);
      if (marked && !marked.conflict) item = sanitizeRecipeEntry(marked);
      return Boolean(item);
    });
    if (!item || Number(ref?.privacyGeneration || 0) !== generation) return false;
    const from = recipeId(item);
    let server;
    let conflict = false;
    let missing = false;
    try {
      if (item.action === 'CREATE_RECIPE') server = await api.createRecipe(item.data.cookbook_id, { ...pickRecipeFields(item.data), client_mutation_id: item.data.client_mutation_id });
      else if (item.action === 'UPDATE_RECIPE') server = await api.updateRecipe(from, { ...item.data.changes, expected_revision: item.data.expected_revision, client_mutation_id: item.data.client_mutation_id });
      else server = await api.deleteRecipe(from, { expected_revision: item.data.expected_revision, client_mutation_id: item.data.client_mutation_id });
    } catch (error) {
      if (Number(error.status) === 409) {
        server = error.data?.detail?.current || await api.getRecipe(from);
        conflict = true;
      } else if ([403, 404].includes(Number(error.status))) missing = true;
      else throw error;
    }
    const to = item.action === 'CREATE_RECIPE' ? server?.id ?? from : from;
    const committed = await locked(item, ref, generation, async queue => {
      const book = getCookbooks().find(row => sameEntityId(row.id, recipeBookId(item)));
      if (!book) return false;
      let remaining = queue.filter(row => !sameEntityId(row.id, item.id));
      let deletes = [item.id];
      let base = { ...book, recipes: (book.recipes || []).filter(recipe => !sameEntityId(recipe.id, from) && !sameEntityId(recipe.id, to)) };
      if (conflict) {
        const related = queue.filter(row => recipeReferences(row, from));
        const last = related.at(-1);
        const local = book.recipes?.find(recipe => sameEntityId(recipe.id, from)) || last?.localRecipe || item.localRecipe || server;
        const descriptor = { server, local: { ...local }, operation: last?.action === 'DELETE_RECIPE' ? 'delete' : 'update' };
        delete descriptor.local.conflict;
        remaining = remaining.filter(row => !recipeReferences(row, from));
        deletes = related.filter(row => !sameEntityId(row.id, item.id)).map(row => row.id);
        remaining.push({ ...item, conflict: descriptor });
        base.recipes.push(server);
      } else if (missing || item.action === 'DELETE_RECIPE') {
        const revokedTransfer = row => missing && transferReferencesRecipe(row, from) && sameEntityId(row.actor_id, item.actor_id);
        const related = remaining.filter(row => recipeReferences(row, from) || revokedTransfer(row));
        deletes.push(...related.map(row => row.id));
        remaining = remaining.filter(row => !recipeReferences(row, from) && !revokedTransfer(row));
      } else {
        remaining = rewriteRecipeQueue(remaining, { from, to });
        remaining = rebaseRecipeQueue(remaining, to, server.applied_revision);
        const clean = { ...server };
        delete clean.applied_revision;
        base.recipes.push(clean);
      }
      const projected = projectRecipeCookbook(base, remaining);
      const applied = await commitReplay({ entity: projected, queueRecords: remaining.filter(row => recipeActions.has(row.action) || isRecipeShoppingTransfer(row)),
        queueDeleteIds: deletes, requireQueueId: item.id, removeRecipeIds: missing || item.action === 'DELETE_RECIPE' && !conflict ? [from] : [] });
      if (applied === false) return false;
      setCookbooks(getCookbooks().map(row => sameEntityId(row.id, book.id) ? projected : row));
      render();
      return true;
    });
    if (committed && !conflict && !missing && !sameEntityId(from, to)) onIdRemap(from, to);
    return committed;
  }
  return { replay };
}
