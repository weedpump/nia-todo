import { createEmptyModule } from './module-factory.js';

export const recipesModule = createEmptyModule({
  id: 'recipes',
  labelKey: 'module.recipes.label',
  descriptionKey: 'module.recipes.description',
  icon: 'recipes',
});
