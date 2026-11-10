import { normalizeQuantityUnit } from '../core/quantity-units.js';
import { isRecipeShoppingTransfer, rewriteRecipeShoppingTransfer, transferReferencesCookbook } from './recipe-shopping-pending.js';
import { sameEntityId } from './entity-metadata.js';

export const recipeActions = new Set(['CREATE_RECIPE', 'UPDATE_RECIPE', 'DELETE_RECIPE']);
export const recipeFields = ['title', 'description', 'base_servings', 'prep_minutes', 'cook_minutes', 'tags', 'ingredient_groups', 'steps', 'image_data', 'source_url', 'source_name', 'source_author', 'source_yield'];
export const recipeId = entry => recipeActions.has(entry?.action) ? entry.data?.id ?? entry.data?.temp_id : null;
export const recipeBookId = entry => recipeActions.has(entry?.action) ? entry.data?.cookbook_id : null;
export const pickRecipeFields = source => Object.fromEntries(recipeFields.filter(key => Object.hasOwn(source || {}, key)).map(key => [key, structuredClone(source[key])]));
export const recipeReferences = (entry, id) => sameEntityId(recipeId(entry), id);
export const pendingRecipeCreate = (queue, id) => queue.some(entry => entry.action === 'CREATE_RECIPE' && recipeReferences(entry, id));
export const editableRecipe = book => book?.can_edit === true || book?.can_edit === 1;
export function sanitizeRecipeEntry(entry) {
  if (!recipeActions.has(entry?.action)) return null;
  const data = entry.data || {};
  return { ...entry, data: { cookbook_id: data.cookbook_id, client_mutation_id: data.client_mutation_id,
    ...(entry.action === 'CREATE_RECIPE' ? { temp_id: data.temp_id, ...pickRecipeFields(data) }
      : { id: data.id, expected_revision: data.expected_revision, ...(entry.action === 'UPDATE_RECIPE' ? { changes: pickRecipeFields(data.changes) } : {}) }) } };
}
export function rewriteRecipeQueue(queue, { from, to, cookbook = false }) {
  return queue.map(entry => {
    if (isRecipeShoppingTransfer(entry)) return rewriteRecipeShoppingTransfer(entry, cookbook ? { cookbookIdFrom: from, cookbookIdTo: to } : { recipeIdFrom: from, recipeIdTo: to });
    if (!recipeActions.has(entry.action)) return entry;
    const key = cookbook ? 'cookbook_id' : entry.action === 'CREATE_RECIPE' ? 'temp_id' : 'id';
    return sameEntityId(entry.data?.[key], from) ? { ...entry, data: { ...entry.data, [key]: to } } : entry;
  });
}
export function rebaseRecipeQueue(queue, id, revision) {
  return queue.map(entry => recipeReferences(entry, id) && entry.action !== 'CREATE_RECIPE' && !entry.attempted
    ? { ...entry, data: { ...entry.data, expected_revision: revision } } : entry);
}
/** Match PATCH semantics without changing durable request bodies: omitted
 * links inherit from the same step key, while an explicit [] clears them. */
export function mergeRecipeStepIngredients(current, changes) {
  const merged = { ...current, ...changes };
  if (!Array.isArray(merged.steps)) return merged;
  const available = new Set((merged.ingredient_groups || []).flatMap(group => (group.ingredients || []).map(item => item.client_key)));
  merged.steps = merged.steps.map(step => {
    const previous = current?.steps?.find(row => row.client_key === step.client_key);
    if (Object.hasOwn(changes || {}, 'steps') && Object.hasOwn(step, 'ingredients')) return { ...step, ingredients: step.ingredients.map(link => {
      if (Object.hasOwn(link, 'quantity_value') || Object.hasOwn(link, 'quantity_text')) return { ...link, quantity_value: link.quantity_value ?? null, quantity_text: link.quantity_text ?? null };
      if (link.show_quantity === false) return { ...link, quantity_value: null, quantity_text: null };
      const old = previous?.ingredients?.find(value => value.ingredient_client_key === link.ingredient_client_key);
      return { ...link, ...(old && (Object.hasOwn(old, 'quantity_value') || Object.hasOwn(old, 'quantity_text'))
        ? { quantity_value: old.quantity_value ?? null, quantity_text: old.quantity_text ?? null } : {}) };
    }) };
    return { ...step, ingredients: (previous?.ingredients || []).filter(link => available.has(link.ingredient_client_key)).map(link => ({ ...link })) };
  });
  return merged;
}
export function projectRecipeCookbook(book, queue) {
  if (!book) return null;
  if (!Array.isArray(book.recipes) && !(queue || []).some(entry => sameEntityId(recipeBookId(entry), book.id))) return book;
  const recipes = new Map((book.recipes || []).map(recipe => [String(recipe.id), { ...recipe, cookbook_id: book.id, can_edit: editableRecipe(book) }]));
  if (editableRecipe(book)) for (const entry of queue || []) {
    if (!sameEntityId(recipeBookId(entry), book.id)) continue;
    const id = recipeId(entry);
    const current = recipes.get(String(id));
    if (entry.action === 'CREATE_RECIPE') {
      if (!current) recipes.set(String(id), { id, cookbook_id: book.id, ...pickRecipeFields(entry.data), revision: 0,
        created_by_user_id: entry.actor_id, client_mutation_id: entry.data.client_mutation_id, can_edit: true, pending: true });
    } else if (entry.conflict) {
      const local = mergeRecipeStepIngredients(entry.conflict.server || current, entry.conflict.local || current || entry.conflict.server);
      recipes.set(String(id), { ...local, id, cookbook_id: book.id, can_edit: true, pending: true,
        conflict: { ...entry.conflict, local: { ...local } } });
    } else if (entry.action === 'DELETE_RECIPE') recipes.delete(String(id));
    else if (current) recipes.set(String(id), { ...mergeRecipeStepIngredients(current, pickRecipeFields(entry.data.changes)), pending: true });
  }
  return { ...book, recipes: [...recipes.values()], recipe_count: recipes.size };
}
/** Same authorized identity cannot roll an acknowledged aggregate backward. Absence still revokes. */
export function mergeRecipeSnapshot(server, local) {
  return server.map(book => {
    if (!Array.isArray(book.recipes)) return book;
    const previous = local.find(row => sameEntityId(row.id, book.id));
    return { ...book, recipes: book.recipes.map(recipe => {
      const cached = previous?.recipes?.find(row => sameEntityId(row.id, recipe.id));
      const newer = Number.isSafeInteger(cached?.revision) && cached.revision > recipe.revision;
      return { ...(newer ? cached : recipe), cookbook_id: book.id, can_edit: editableRecipe(book) };
    }) };
  });
}
/** Complete authorized snapshot only. Retires own creates, preserves unacknowledged edits. */
export function reconcileRecipeSnapshot(server, local, queue, { actorId = null, authoritative = server } = {}) {
  let next = queue;
  const queueDeleteIds = [];
  const remaps = [];
  for (const book of server) {
    const acknowledgedBook = authoritative.find(record => sameEntityId(record.id, book.id));
    for (const recipe of acknowledgedBook?.recipes || []) {
      if (actorId == null || !sameEntityId(recipe.created_by_user_id, actorId)) continue;
      for (const create of next.filter(entry => entry.action === 'CREATE_RECIPE' && sameEntityId(recipeBookId(entry), book.id)
        && sameEntityId(entry.data.client_mutation_id, recipe.client_mutation_id))) {
        const from = recipeId(create);
        queueDeleteIds.push(create.id);
        next = rewriteRecipeQueue(next, { from, to: recipe.id });
        next = rebaseRecipeQueue(next, recipe.id, 1);
        remaps.push([from, recipe.id]);
      }
    }
    const ids = new Set((book.recipes || []).map(recipe => String(recipe.id)));
    next = next.filter(entry => {
      if (!sameEntityId(recipeBookId(entry), book.id)) return true;
      if (!editableRecipe(book) || (entry.action !== 'CREATE_RECIPE' && !ids.has(String(recipeId(entry))) && !pendingRecipeCreate(next, recipeId(entry)))) {
        queueDeleteIds.push(entry.id); return false;
      }
      return true;
    });
  }
  const books = new Set(server.map(book => String(book.id)));
  const pendingBooks = new Set(queue.filter(entry => entry.action === 'CREATE_COOKBOOK').map(entry => String(entry.data.temp_id)));
  next = next.filter(entry => {
    if (queueDeleteIds.includes(entry.id)) return false;
    if (recipeActions.has(entry.action) && !books.has(String(recipeBookId(entry))) && !pendingBooks.has(String(recipeBookId(entry)))) {
      queueDeleteIds.push(entry.id); return false;
    }
    return true;
  });
  next = next.filter(entry => {
    if (!isRecipeShoppingTransfer(entry)) return true;
    if (actorId == null || !sameEntityId(entry.actor_id, actorId)) return true;
    const book = authoritative.find(book => transferReferencesCookbook(entry, book.id)) || server.find(book => transferReferencesCookbook(entry, book.id));
    const pendingSource = next.some(row => row.action === 'CREATE_RECIPE' && sameEntityId(row.data?.temp_id, entry.data.recipe_id));
    if (book && (pendingSource || entry.attempted || book.recipes?.some(recipe => sameEntityId(recipe.id, entry.data.recipe_id)))) return true;
    queueDeleteIds.push(entry.id); return false;
  });
  const entities = server.map(book => projectRecipeCookbook(book, next));
  return { entities, queueRecords: next.filter(entry => recipeActions.has(entry.action) || isRecipeShoppingTransfer(entry)), queueDeleteIds, remaps, queue: next };
}
export function validateRecipeChanges(input, creating = false) {
  const data = pickRecipeFields(input);
  if (creating || Object.hasOwn(data, 'title')) { data.title = String(data.title || '').trim(); if (!data.title || data.title.length > 200) return null; }
  if (creating) Object.assign(data, { description: data.description ?? '', base_servings: data.base_servings ?? 1, prep_minutes: data.prep_minutes ?? null, cook_minutes: data.cook_minutes ?? null, tags: data.tags ?? [], ingredient_groups: data.ingredient_groups ?? [], steps: data.steps ?? [] });
  if (Object.hasOwn(data, 'description') && (typeof data.description !== 'string' || data.description.length > 4000)) return null;
  for (const [key, limit] of Object.entries({ source_url: 2048, source_name: 200, source_author: 500, source_yield: 500 })) {
    if (!Object.hasOwn(data, key)) continue;
    if (typeof data[key] !== 'string' || data[key].length > limit) return null;
    data[key] = data[key].trim();
    if (key === 'source_url' && data[key]) {
      try { const url = new URL(data[key]); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\x00-\x20\x7f]/u.test(data[key])) return null; }
      catch { return null; }
    }
  }
  if (Object.hasOwn(data, 'base_servings') && !(Number.isFinite(data.base_servings) && data.base_servings > 0 && data.base_servings <= 100000)) return null;
  for (const key of ['prep_minutes', 'cook_minutes']) if (Object.hasOwn(data, key) && data[key] != null && !(Number.isInteger(data[key]) && data[key] >= 0 && data[key] <= 100000)) return null;
  if (Object.hasOwn(data, 'tags') && (!Array.isArray(data.tags) || data.tags.length > 40 || data.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 80))) return null;
  const keys = values => values.every(value => value && typeof value.client_key === 'string' && value.client_key.trim() && value.client_key.length <= 200) && new Set(values.map(value => value.client_key)).size === values.length;
  if (Object.hasOwn(data, 'steps') && (!Array.isArray(data.steps) || data.steps.length > 100 || !keys(data.steps) || data.steps.some(step => typeof step.text !== 'string' || !step.text.trim() || step.text.length > 8000))) return null;
  if (Object.hasOwn(data, 'ingredient_groups')) {
    const groups = data.ingredient_groups;
    if (!Array.isArray(groups) || groups.length > 50 || !keys(groups)) return null;
    let count = 0;
    const ingredientKeys = new Set();
    for (const group of groups) {
      if (typeof group.name !== 'string' || group.name.length > 200 || !Array.isArray(group.ingredients) || !keys(group.ingredients)) return null;
      count += group.ingredients.length;
      for (const item of group.ingredients) {
        if (ingredientKeys.has(item.client_key)) return null;
        ingredientKeys.add(item.client_key);
        if (item.quantity_unit != null && (typeof item.quantity_unit !== 'string' || item.quantity_unit.length > 40)) return null;
        if (Object.hasOwn(item, 'quantity_unit')) item.quantity_unit = normalizeQuantityUnit(item.quantity_unit);
        if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 500) return null;
        if (item.quantity_value != null && !(Number.isFinite(item.quantity_value) && item.quantity_value > 0) || item.quantity_value != null && String(item.quantity_text || '').trim()) return null;
        if (String(item.quantity_text || '').length > 500 || String(item.note || '').length > 2000) return null;
      }
    }
    if (count > 500) return null;
  }
  if (Object.hasOwn(data, 'steps')) {
    const available = Object.hasOwn(data, 'ingredient_groups')
      ? new Map(data.ingredient_groups.flatMap(group => group.ingredients.map(item => [item.client_key, item]))) : null;
    for (const step of data.steps) {
      if (!Object.hasOwn(step, 'ingredients')) {
        if (!creating) continue;
        step.ingredients = [];
      }
      if (!Array.isArray(step.ingredients) || step.ingredients.length > 500) return null;
      const seen = new Set();
      for (const link of step.ingredients) {
        if (!link || Object.keys(link).some(key => !['ingredient_client_key', 'show_quantity', 'quantity_value', 'quantity_text'].includes(key)) || typeof link.ingredient_client_key !== 'string' || !link.ingredient_client_key.trim()
          || link.ingredient_client_key.length > 200 || seen.has(link.ingredient_client_key)
          || available && !available.has(link.ingredient_client_key)
          || Object.hasOwn(link, 'show_quantity') && typeof link.show_quantity !== 'boolean') return null;
        seen.add(link.ingredient_client_key);
        if (!Object.hasOwn(link, 'show_quantity')) link.show_quantity = true;
        const amount = link.quantity_value, free = link.quantity_text;
        if (amount != null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0)
          || free != null && (typeof free !== 'string' || free.length > 500)
          || amount != null && String(free || '').trim()
          || link.show_quantity === false && (amount != null || String(free || '').trim())) return null;
        if (amount != null && available) {
          const source = available.get(link.ingredient_client_key);
          if (!(Number.isFinite(source.quantity_value) && source.quantity_value > 0) || amount > source.quantity_value) return null;
        }
        if (Object.hasOwn(link, 'quantity_text')) link.quantity_text = free?.trim() || null;
      }
    }
  }
  if (Object.hasOwn(data, 'image_data') && data.image_data != null && (typeof data.image_data !== 'string' || data.image_data.length > 430000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data.image_data))) return null;
  if (new TextEncoder().encode(JSON.stringify(data)).length > 512 * 1024) return null;
  return data;
}
