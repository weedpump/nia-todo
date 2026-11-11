import { resolveEntityIdentity } from '../core/entity-identity.js';
import { t } from '../i18n/index.js';

export function shoppingStoreOptionAction({
  list,
  stores = [],
  actorId = null,
  option,
  onEdit = () => {},
} = {}) {
  if (list?.can_edit !== true || !option?.value) return null;
  const store = resolveEntityIdentity(stores.filter(candidate => candidate?.active !== false), option.value,
    { actorId, parentId: list.id, parentField: 'shopping_list_id' });
  if (!store) return null;
  return {
    icon: 'pencil',
    ariaLabel: t('shopping.store.edit', { name: store.name || '' }),
    onActivate: ({ trigger }) => onEdit(list.id, store.id, trigger),
  };
}
