import { t } from '../i18n/index.js';

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

export function shoppingStoreOptionAction({
  list,
  stores = [],
  option,
  onEdit = () => {},
} = {}) {
  if (list?.can_manage !== true || !option?.value) return null;
  const store = stores.find(candidate => (
    candidate?.active !== false
    && (sameId(candidate.id, option.value) || sameId(candidate.client_mutation_id, option.value))
    && (sameId(candidate.shopping_list_id, list.id) || sameId(candidate.shopping_list_id, list.client_mutation_id))
  ));
  if (!store) return null;
  return {
    icon: 'pencil',
    ariaLabel: t('shopping.store.edit', { name: store.name || '' }),
    onActivate: ({ trigger }) => onEdit(list.id, store.id, trigger),
  };
}
