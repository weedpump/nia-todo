// Candidate routing is independent of the recorder, modal and active navigation.
const sameId = (left, right) => left != null && right != null && String(left) === String(right);

export function brainDumpCandidateModule(candidate = {}) {
  return candidate.module_id === 'shopping' ? 'shopping' : 'tasks';
}

export function brainDumpOriginalRoute(candidate = {}) {
  return {
    original_module_id: brainDumpCandidateModule(candidate),
    original_shopping_list_id: candidate.shopping_list_id ?? null,
    original_shopping_section_id: candidate.shopping_section_id ?? null,
    original_shopping_store_ids: [...(candidate.shopping_store_ids || [])],
    original_project_name: candidate.project_name ?? null,
    original_section_name: candidate.section_name ?? null,
    original_route_present: true,
  };
}

export function resolveBrainDumpShoppingTarget(candidate, lists = [], stores = []) {
  const list = lists.find(value => sameId(value.id, candidate.shopping_list_id)
    || sameId(value.client_mutation_id, candidate.shopping_list_id));
  if (!list || list.can_edit !== true) return null;
  const sectionId = candidate.shopping_section_id;
  const section = sectionId == null ? null : (list.sections || []).find(value => (
    sameId(value.id, sectionId) || sameId(value.client_mutation_id, sectionId)
  ));
  if (sectionId != null && !section) return null;
  const ids = candidate.shopping_store_ids || [];
  if (!Array.isArray(ids) || ids.length > 1) return null;
  const selectedStores = ids.map(id => stores.find(value => (
    (sameId(value.id, id) || sameId(value.client_mutation_id, id))
    && (sameId(value.shopping_list_id, list.id) || sameId(value.shopping_list_id, list.client_mutation_id))
    && value.active !== false
  )));
  if (selectedStores.some(value => !value)) return null;
  return { list, section, stores: selectedStores };
}

export function brainDumpCandidateError(candidate, { modules = ['tasks'], lists = [], stores = [] } = {}) {
  if (!modules.includes(brainDumpCandidateModule(candidate))) return 'capture.target.required';
  const title = String(candidate.title || '').trim();
  if (!title || title.length > 500) return 'capture.validation.title';
  if (brainDumpCandidateModule(candidate) !== 'shopping') return null;
  if (!resolveBrainDumpShoppingTarget(candidate, lists, stores)) return 'capture.target.required';
  const quantity = candidate.quantity_value;
  if (quantity != null && quantity !== '' && (!Number.isFinite(Number(quantity)) || Number(quantity) < 0)) return 'shopping.item.error.invalidQuantity';
  if (String(candidate.quantity_unit || '').trim().length > 40) return 'shopping.item.error.invalidUnit';
  return null;
}

export function changeBrainDumpCandidateModule(candidate, moduleId) {
  const next = moduleId === 'shopping' ? 'shopping' : 'tasks';
  const previous = brainDumpCandidateModule(candidate);
  if (next === previous) return;
  const fields = {
    tasks: ['project_name', 'section_name', 'deadline', 'reminder', 'recurring_rule', 'location_reminder'],
    shopping: ['shopping_list_id', 'shopping_section_id', 'shopping_store_ids', 'quantity_value', 'quantity_unit'],
  };
  candidate._bdModuleDrafts ||= {};
  candidate._bdModuleDrafts[previous] = Object.fromEntries(fields[previous].map(key => [key, structuredClone(candidate[key] ?? null)]));
  candidate.module_id = next;
  for (const key of fields[previous]) candidate[key] = key === 'shopping_store_ids' ? [] : null;
  for (const key of fields[next]) candidate[key] = structuredClone(candidate._bdModuleDrafts[next]?.[key] ?? (key === 'shopping_store_ids' ? [] : null));
}

export function brainDumpCandidatePayload(candidate) {
  const clean = Object.fromEntries(Object.entries(candidate).filter(([key]) => !key.startsWith('_bd')));
  clean.title = String(clean.title || '').trim();
  clean.braindump_route = candidate._bdOriginalRoute || brainDumpOriginalRoute(candidate);
  if (brainDumpCandidateModule(candidate) === 'shopping') {
    return {
      module_id: 'shopping', title: clean.title,
      shopping_list_id: clean.shopping_list_id ?? null,
      shopping_section_id: clean.shopping_section_id ?? null,
      shopping_store_ids: [...(clean.shopping_store_ids || [])],
      quantity_value: clean.quantity_value == null || clean.quantity_value === '' ? null : Number(clean.quantity_value),
      quantity_unit: String(clean.quantity_unit || '').trim() || null,
      client_mutation_id: clean.client_mutation_id,
      braindump_route: clean.braindump_route,
    };
  }
  for (const key of ['shopping_list_id', 'shopping_section_id', 'shopping_store_ids', 'quantity_value', 'quantity_unit']) delete clean[key];
  const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  clean.braindump_route = {
    ...clean.braindump_route,
    original_shopping_list_id: positiveId(clean.braindump_route.original_shopping_list_id),
    original_shopping_section_id: positiveId(clean.braindump_route.original_shopping_section_id),
    original_shopping_store_ids: (clean.braindump_route.original_shopping_store_ids || []).map(positiveId).filter(Boolean),
  };
  if (clean.location_reminder) {
    clean.location_reminder = {
      trigger_type: clean.location_reminder.trigger_type === 'departure' ? 'departure' : 'arrival',
      place_id: clean.location_reminder.place_id || null,
      place_name: clean.location_reminder.place_name || null,
    };
  }
  return clean;
}
