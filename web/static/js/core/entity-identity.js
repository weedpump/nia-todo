/** Public IDs and actor-local mutation aliases are different namespaces.
 * Resolve real IDs first, and never reinterpret a numeric (possibly revoked)
 * server ID as a mutation alias. Child collections must be parent-scoped before
 * resolution, or supply parentId/parentField here.
 */
export function resolveEntityIdentity(records = [], identity, {
  actorId = null, parentId, parentField,
} = {}) {
  if (identity == null || identity === '') return null;
  const equal = (left, right) => left != null && right != null && String(left) === String(right);
  if (parentId !== undefined && !parentField) return null;
  const scoped = parentId === undefined ? records : records.filter(record => equal(record?.[parentField], parentId));
  const exact = scoped.find(record => equal(record?.id, identity));
  if (exact) return exact;
  if (actorId == null || /^\d+$/.test(String(identity))) return null;
  return resolveEntityMutationReceipt(scoped, identity, { actorId });
}

/** Match an explicitly captured creation receipt, never an untyped server ID.
 * Numeric mutation IDs remain valid in this separate, actor-bound namespace.
 */
export function resolveEntityMutationReceipt(records = [], mutationId, { actorId = null } = {}) {
  if (actorId == null || typeof mutationId !== 'string' || !mutationId) return null;
  const matches = records.filter(record => record?.created_by_user_id != null
    && String(record.created_by_user_id) === String(actorId)
    && record.client_mutation_id === mutationId);
  return matches.length === 1 ? matches[0] : null;
}

/** Foreign entities keep their real ID. Own nonnumeric mutation aliases keep
 * one queue identity while a locally created entity receives its server ID.
 */
export function entityIdentity(entity, actorId = null) {
  const alias = entity?.client_mutation_id;
  if (actorId != null && entity?.created_by_user_id != null
    && String(entity.created_by_user_id) === String(actorId)
    && typeof alias === 'string' && alias && !/^\d+$/.test(alias)) return alias;
  return entity?.id ?? null;
}

export function sameEntityIdentity(left, right, actorId = null) {
  if (!left || !right) return false;
  if (String(left.id) === String(right.id)) return left.id != null && right.id != null;
  return String(left.id || '').startsWith('temp-') && resolveEntityIdentity([right], left.id, { actorId }) === right
    || String(right.id || '').startsWith('temp-') && resolveEntityIdentity([left], right.id, { actorId }) === left;
}
