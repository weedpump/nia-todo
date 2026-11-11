import { sameEntityId } from './entity-metadata.js';
import { queueItemReferencesTodo } from './todo-pending.js';
import { queueItemReferencesShoppingList } from './shopping-pending.js';
import { isRecipeShoppingTransfer } from './recipe-shopping-pending.js';

const creationTypes = Object.freeze({ CREATE_TODO: 'todo', CREATE_SHOPPING_LIST: 'shopping_list',
  CREATE_SHOPPING_SECTION: 'shopping_section', CREATE_SHOPPING_STORE: 'shopping_store', CREATE_SHOPPING_ITEM: 'shopping_item' });
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const matches = (ids, value) => ids.some(id => sameEntityId(id, value));

/** A deletion receipt belongs only to the specific create and its known parent. */
export function creationTombstoneFor(item, error) {
  const detail = error?.data?.detail;
  const expected = creationTypes[item?.action];
  if (!expected) return null;
  if (Number(error?.status) !== 410 || detail?.code !== 'sync.creationDeleted'
    || detail.entity_type !== expected || !positiveId(detail.id)) return null;
  if (!['todo', 'shopping_list'].includes(detail.entity_type)
    && (!positiveId(detail.shopping_list_id) || !sameEntityId(detail.shopping_list_id, item.data.shopping_list_id))) return null;
  return detail;
}

function clearAssociation(content, kind, ids, eventId) {
  if (!content) return null;
  const field = kind === 'shopping_section' ? 'section' : 'stores';
  const changed = field === 'section' ? matches(ids, content.section_id)
    : Array.isArray(content.store_ids) && content.store_ids.some(id => matches(ids, id));
  if (!changed) return null;
  const next = structuredClone(content);
  if (field === 'section') next.section_id = null;
  else next.store_ids = next.store_ids.filter(id => !matches(ids, id));
  if (typeof next.routing_feedback?.event_id === 'string' && next.routing_feedback.event_id.trim()
    && next.routing_feedback.event_id.length <= 200 && Number.isSafeInteger(next.routing_feedback.generation)
    && next.routing_feedback.generation >= 0 && Array.isArray(next.routing_feedback.fields)
    && next.routing_feedback.fields.every(value => ['module','list','section','stores'].includes(value))) {
    next.routing_feedback.fields = next.routing_feedback.fields.filter(value => value !== field);
  } else {
    // An automatic fallback is not a user correction. Legacy updates may learn
    // changed routing even when they carry no BrainDump provenance at all.
    next.routing_feedback = { event_id: `deleted-parent-${eventId}`.slice(0, 200), generation: 0, fields: [] };
  }
  return next;
}

/** Pure plan; caller fences account/privacy/queue presence and commits atomically. */
export function planCreationTombstone(item, detail, { queue, shoppingLists = [], shoppingStores = [], actorId = null }) {
  const own = row => row.actor_id == null || sameEntityId(row.actor_id, actorId);
  if (!own(item)) return null;
  const kind = detail.entity_type, ids = [item.data._tempId ?? item.data.temp_id, detail.id].filter(id => id != null);
  const parentId = detail.shopping_list_id ?? item.data.shopping_list_id;
  const remove = {}, writes = {}, queueDeleteIds = new Set([item.id]), queueRecords = [];
  const inParent = row => sameEntityId(row.shopping_list_id, parentId);
  if (kind === 'todo') remove.todos = ids;
  else if (kind === 'shopping_list') {
    remove.shoppingLists = ids;
    remove.shoppingStores = shoppingStores.filter(store => matches(ids, store.shopping_list_id)).map(store => store.id);
  } else {
    if (kind === 'shopping_store') remove.shoppingStores = shoppingStores.filter(store => inParent(store) && matches(ids, store.id)).map(store => store.id);
    writes.shoppingLists = shoppingLists.filter(list => sameEntityId(list.id, parentId)).map(list => {
      if (kind === 'shopping_item') return { ...list, items: (list.items || []).filter(row => !matches(ids, row.id)) };
      return { ...list,
        ...(kind === 'shopping_section' ? { sections: (list.sections || []).filter(row => !matches(ids, row.id)) } : {}),
        items: (list.items || []).map(row => {
          if (kind === 'shopping_section') return matches(ids, row.section_id) ? { ...row, section_id: null } : row;
          return { ...row,
            ...(Array.isArray(row.store_ids) ? { store_ids: row.store_ids.filter(id => !matches(ids, id)) } : {}),
            ...(Array.isArray(row.stores) ? { stores: row.stores.filter(store => !matches(ids, store.id)) } : {}),
          };
        }),
      };
    });
  }
  for (const row of queue) {
    if (!own(row)) continue;
    if (queueDeleteIds.has(row.id)) continue;
    const data = row.data || {};
    if (kind === 'todo') {
      if (ids.some(id => queueItemReferencesTodo(row, id))) queueDeleteIds.add(row.id);
      continue;
    }
    if (kind === 'shopping_list') {
      if (ids.some(id => queueItemReferencesShoppingList(row, id, shoppingStores))) queueDeleteIds.add(row.id);
      continue;
    }
    if (!sameEntityId(data.shopping_list_id, parentId)) continue;
    const actions = kind === 'shopping_item' ? ['CREATE_SHOPPING_ITEM','UPDATE_SHOPPING_ITEM','DELETE_SHOPPING_ITEM']
      : kind === 'shopping_section' ? ['CREATE_SHOPPING_SECTION','UPDATE_SHOPPING_SECTION','DELETE_SHOPPING_SECTION']
        : ['CREATE_SHOPPING_STORE','UPDATE_SHOPPING_STORE','DELETE_SHOPPING_STORE'];
    const key = kind === 'shopping_item' ? 'item_id' : kind === 'shopping_section' ? 'section_id' : 'store_id';
    if (actions.includes(row.action) && matches(ids, data[key] ?? data.temp_id)) { queueDeleteIds.add(row.id); continue; }
    if (kind === 'shopping_item' || row.attempted || data.create_attempted) continue;
    if (['CREATE_SHOPPING_ITEM','UPDATE_SHOPPING_ITEM'].includes(row.action)) {
      const field = row.action === 'CREATE_SHOPPING_ITEM' ? 'item' : 'changes';
      const content = clearAssociation(data[field], kind, ids, row.id);
      if (content) queueRecords.push({ ...row, data: { ...data, [field]: content } });
    } else if (isRecipeShoppingTransfer(row)) {
      const ingredients = data.ingredients.map(value => clearAssociation(value, kind, ids, row.id) || value);
      if (ingredients.some((value, index) => value !== data.ingredients[index])) queueRecords.push({ ...row, data: { ...data, ingredients } });
    }
  }
  return { writes, remove, queueRecords, queueDeleteIds: [...queueDeleteIds], requireQueueId: item.id };
}
