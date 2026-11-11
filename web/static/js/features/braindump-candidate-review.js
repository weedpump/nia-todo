import { resolveEntityIdentity } from '../core/entity-identity.js';
import { normalizeQuantityUnit } from '../core/quantity-units.js';
// Candidate routing is independent of the recorder, modal and active navigation.
const routeField = field => field === 'container' || field === 'project' ? 'list' : field;
const positiveId = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const sameId = (left, right) => left != null && right != null && String(left) === String(right);

export function brainDumpCandidateModule(candidate = {}) {
  return candidate.module_id === 'shopping' ? 'shopping' : 'tasks';
}

export function brainDumpCandidateRoutingFields(candidate = {}) {
  const moduleId = brainDumpCandidateModule(candidate);
  const originalModule = candidate._bdOriginalRoute?.original_module_id || moduleId;
  const containerChanged = moduleId === 'shopping' ? candidate._bdRoutingListChanged : candidate._bdRoutingProjectChanged;
  const spoken = originalModule === moduleId && Array.isArray(candidate.explicit_route_fields)
    ? candidate.explicit_route_fields.map(routeField).filter(field => !containerChanged || field === 'list') : [];
  const allowed = moduleId === 'shopping' ? ['module', 'list', 'section', 'stores'] : ['module', 'list', 'section'];
  return [...new Set([...spoken, ...(candidate._bdRoutingFields || []), ...(originalModule !== moduleId ? ['module'] : [])])].filter(field => allowed.includes(field));
}

export function brainDumpCandidateMemoryFields(candidate = {}) {
  const explicit = new Set(brainDumpCandidateRoutingFields(candidate));
  const value = candidate._bdMemoryFields ?? candidate.memory_route_fields;
  const remembered = Array.isArray(value) ? value : [];
  const allowed = brainDumpCandidateModule(candidate) === 'shopping' ? ['module', 'list', 'section', 'stores'] : ['module', 'list', 'section'];
  return [...new Set(remembered.map(routeField))].filter(field => allowed.includes(field) && !explicit.has(field));
}

export function brainDumpOriginalRoute(candidate = {}) {
  return {
    original_module_id: brainDumpCandidateModule(candidate),
    original_shopping_list_id: candidate.shopping_list_id ?? null,
    original_shopping_section_id: candidate.shopping_section_id ?? null,
    original_shopping_store_ids: [...(candidate.shopping_store_ids || [])],
    original_project_id: positiveId(candidate.project_id),
    original_section_id: positiveId(candidate.section_id),
    original_project_name: candidate.project_name ?? null,
    original_section_name: candidate.section_name ?? null,
    original_route_present: true,
  };
}

export function resolveBrainDumpShoppingTarget(candidate, lists = [], stores = [], { actorId = null } = {}) {
  const resolve = (rows, identity) => resolveEntityIdentity(rows, identity, { actorId });
  const list = resolve(lists, candidate.shopping_list_id);
  if (!list || list.can_edit !== true) return null;
  const sectionId = candidate.shopping_section_id;
  const section = sectionId == null ? null : resolve(list.sections || [], sectionId);
  if (sectionId != null && !section) return null;
  const ids = candidate.shopping_store_ids || [];
  if (!Array.isArray(ids) || ids.length > 50) return null;
  const selectedStores = ids.map(id => resolveEntityIdentity(stores.filter(value => value.active !== false), id,
    { actorId, parentId: list.id, parentField: 'shopping_list_id' }));
  if (selectedStores.some(value => !value)) return null;
  return { list, section, stores: selectedStores };
}

export function brainDumpCandidateError(candidate, { modules = ['tasks'], lists = [], stores = [], projects, sections = [], actorId = null } = {}) {
  if (!modules.includes(brainDumpCandidateModule(candidate))) return 'capture.target.required';
  const title = String(candidate.title || '').trim();
  if (!title || title.length > 500) return 'capture.validation.title';
  if (brainDumpCandidateModule(candidate) !== 'shopping') {
    if (candidate.project_id != null && positiveId(candidate.project_id) == null || candidate.section_id != null && positiveId(candidate.section_id) == null) return 'capture.target.required';
    if (Array.isArray(projects) && candidate.project_id != null) {
      const project = projects.find(value => sameId(value.id, candidate.project_id) && value.can_edit !== false && value.can_edit !== 0 && value.can_edit_content !== false && value.can_edit_content !== 0 && !value.archived);
      if (!project) return 'capture.target.required';
      if (candidate.section_id != null && !sections.some(value => sameId(value.id, candidate.section_id) && sameId(value.project_id, project.id))) return 'capture.target.required';
    } else if (Array.isArray(projects)) {
      if (candidate.section_id != null) return 'capture.target.required';
      const key = String(candidate.project_name || '').trim().toLowerCase();
      const matches = key ? projects.filter(value => String(value.name || '').trim().toLowerCase() === key) : [];
      if (matches.length > 1) return 'capture.target.required';
    }
    return null;
  }
  if (!resolveBrainDumpShoppingTarget(candidate, lists, stores, { actorId })) return 'capture.target.required';
  const quantity = candidate.quantity_value;
  if (quantity != null && quantity !== '' && (!Number.isFinite(Number(quantity)) || Number(quantity) < 0)) return 'shopping.item.error.invalidQuantity';
  if (String(candidate.quantity_unit || '').trim().length > 40) return 'shopping.item.error.invalidUnit';
  return null;
}

export function changeBrainDumpCandidateModule(candidate, moduleId) {
  const next = moduleId === 'shopping' ? 'shopping' : 'tasks';
  const previous = brainDumpCandidateModule(candidate);
  if (next === previous) return;
  candidate._bdOriginalRoute ||= brainDumpOriginalRoute(candidate);
  candidate._bdMemoryFields = [];
  candidate._bdMemoryInvalidated = true;
  const fields = {
    tasks: ['project_id', 'section_id', 'project_name', 'section_name', 'deadline', 'reminder', 'recurring_rule', 'location_reminder'],
    shopping: ['shopping_list_id', 'shopping_section_id', 'shopping_store_ids', 'quantity_value', 'quantity_unit'],
  };
  candidate._bdModuleRoutingDrafts ||= {};
  candidate._bdModuleRoutingDrafts[previous] = { fields: [...(candidate._bdRoutingFields || [])], listChanged: Boolean(candidate._bdRoutingListChanged), projectChanged: Boolean(candidate._bdRoutingProjectChanged) };
  const routing = candidate._bdModuleRoutingDrafts[next];
  candidate._bdRoutingFields = [...(routing?.fields || [])];
  candidate._bdRoutingListChanged = Boolean(routing?.listChanged);
  candidate._bdRoutingProjectChanged = Boolean(routing?.projectChanged);
  candidate._bdModuleDrafts ||= {};
  candidate._bdModuleDrafts[previous] = Object.fromEntries(fields[previous].map(key => [key, structuredClone(candidate[key] ?? null)]));
  candidate.module_id = next;
  for (const key of fields[previous]) candidate[key] = key === 'shopping_store_ids' ? [] : null;
  for (const key of fields[next]) candidate[key] = structuredClone(candidate._bdModuleDrafts[next]?.[key] ?? (key === 'shopping_store_ids' ? [] : null));
}

export function brainDumpCandidatePayload(candidate, { routingMemory = null } = {}) {
  const clean = Object.fromEntries(Object.entries(candidate).filter(([key]) => !key.startsWith('_bd') && key !== 'memory_route_fields'));
  clean.title = String(clean.title || '').trim();
  clean.braindump_route = candidate._bdOriginalRoute || brainDumpOriginalRoute(candidate);
  const fields = brainDumpCandidateRoutingFields(candidate);
  const routing_feedback = routingMemory?.feedback(fields, { eventId: candidate._bdRoutingEventId || candidate.client_mutation_id });
  if (brainDumpCandidateModule(candidate) === 'shopping') {
    return {
      module_id: 'shopping', title: clean.title,
      shopping_list_id: clean.shopping_list_id ?? null,
      shopping_section_id: clean.shopping_section_id ?? null,
      shopping_store_ids: [...(clean.shopping_store_ids || [])],
      quantity_value: clean.quantity_value == null || clean.quantity_value === '' ? null : Number(clean.quantity_value),
      quantity_unit: normalizeQuantityUnit(clean.quantity_unit),
      client_mutation_id: clean.client_mutation_id,
      braindump_route: clean.braindump_route,
      explicit_route_fields: fields.filter(field => field !== 'module').map(field => field === 'list' ? 'container' : field),
      ...(routing_feedback ? { routing_feedback } : {}),
    };
  }
  for (const key of ['shopping_list_id', 'shopping_section_id', 'shopping_store_ids', 'quantity_value', 'quantity_unit']) delete clean[key];
  clean.braindump_route = {
    ...clean.braindump_route,
    original_project_id: positiveId(clean.braindump_route.original_project_id),
    original_section_id: positiveId(clean.braindump_route.original_section_id),
    original_shopping_list_id: positiveId(clean.braindump_route.original_shopping_list_id),
    original_shopping_section_id: positiveId(clean.braindump_route.original_shopping_section_id),
    original_shopping_store_ids: (clean.braindump_route.original_shopping_store_ids || []).map(positiveId).filter(Boolean),
  };
  if ('project_id' in clean) clean.project_id = positiveId(clean.project_id);
  if ('section_id' in clean) clean.section_id = positiveId(clean.section_id);
  if (routing_feedback) clean.routing_feedback = routing_feedback;
  clean.explicit_route_fields = fields.filter(field => field !== 'module').map(field => field === 'list' ? 'container' : field);
  if (clean.location_reminder) {
    clean.location_reminder = {
      trigger_type: clean.location_reminder.trigger_type === 'departure' ? 'departure' : 'arrival',
      place_id: clean.location_reminder.place_id || null,
      place_name: clean.location_reminder.place_name || null,
    };
  }
  return clean;
}
