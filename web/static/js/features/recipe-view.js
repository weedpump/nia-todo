import { t, getActiveLocale } from '../i18n/index.js';
import { escapeHtml, escapeHtmlAttr, parseServerUtcTimestamp } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { closeOpenDropdown, hydrateSelect, refreshSelect } from '../ui/dropdowns.js';
import { sameEntityId } from './entity-metadata.js';
import { formatRecipeIngredient } from '../core/recipe-quantities.js';
import { renderServingsControl, refreshServingsControl, stepServings } from '../ui/servings-control.js';
import { renderRecipeStepIngredients, refreshRecipeStepIngredientAmounts } from './recipe-step-ingredients.js';

export const canEditRecipe = (recipe, cookbook) => Boolean(cookbook && (cookbook.can_edit === true || cookbook.can_edit === 1)
  && (!recipe || recipe.can_edit === true || recipe.can_edit === 1));
const button = (action, label, icon, attributes = '') => `<button type="button" class="btn btn-secondary${icon ? ' btn-icon' : ''}" data-recipe-action="${action}" aria-label="${escapeHtmlAttr(label)}" title="${escapeHtmlAttr(label)}" ${attributes}>${icon ? iconSvg(icon) : escapeHtml(label)}</button>`;
export function ingredientAmount(ingredient, servings, baseServings, locale = getActiveLocale()) {
  return formatRecipeIngredient(ingredient, servings, baseServings, locale);
}
export function renderRecipeConflict(recipe, { editable = true } = {}) {
  if (!recipe?.conflict) return '';
  return `<section class="recipe-conflict ui-section-card" role="status"><h3>${escapeHtml(t('recipe.conflict.title'))}</h3>
    <p>${escapeHtml(t('recipe.conflict.message'))}</p><div class="recipe-actions">
    ${button('keep-local', t(recipe.conflict.operation === 'delete' ? 'recipe.conflict.retryDelete' : 'recipe.conflict.keepLocal'), null, editable ? '' : 'disabled')}
    ${button('use-server', t('recipe.conflict.useServer'), null, editable ? '' : 'disabled')}</div></section>`;
}
export async function resolveRecipeConflict({ recipe, keepLocal, controller, confirmDanger, isCurrent }) {
  if (!recipe?.conflict || !isCurrent()) return null;
  if (keepLocal && !await confirmDanger({ title: t('recipe.conflict.confirmTitle'),
    message: t(recipe.conflict.operation === 'delete' ? 'recipe.delete.message' : 'recipe.conflict.confirmMessage', { title: recipe.title }),
    confirmText: t(recipe.conflict.operation === 'delete' ? 'common.delete' : 'recipe.conflict.keepLocal') })) return null;
  if (!isCurrent()) return null;
  return controller.resolveConflict(recipe.id, { keepLocal, isCurrent });
}
function image(recipe, className) {
  const card = className === 'recipe-thumbnail', tag = card ? 'span' : 'div';
  return `<${tag} class="${className}"><img data-recipe-image="${escapeHtmlAttr(recipe.id)}" alt="${card ? '' : escapeHtmlAttr(recipe.title)}" hidden><span class="recipe-image-placeholder" aria-hidden="true">${iconSvg('image')}</span></${tag}>`;
}
function metadata(recipe, { card = false } = {}) {
  const values = [];
  if (card && recipe.prep_minutes != null && recipe.cook_minutes != null) {
    values.push(`<span>${iconSvg('clock')}${escapeHtml(t('recipe.totalTime', { minutes: recipe.prep_minutes + recipe.cook_minutes }))}</span>`);
  } else {
    if (recipe.prep_minutes != null) values.push(`<span>${iconSvg('clock')}${escapeHtml(t('recipe.prepTime', { minutes: recipe.prep_minutes }))}</span>`);
    if (recipe.cook_minutes != null) values.push(`<span>${iconSvg('flame')}${escapeHtml(t('recipe.cookTime', { minutes: recipe.cook_minutes }))}</span>`);
  }
  const tags = recipe.tags || [], shown = card ? tags.slice(0, 2) : tags;
  const remaining = card && tags.length > 2 ? `<span class="recipe-tag-more" title="${escapeHtmlAttr(tags.slice(2).join(', '))}"><span aria-hidden="true">+${tags.length - 2}</span><span class="visually-hidden">${escapeHtml(tags.slice(2).join(', '))}</span></span>` : '';
  const wrapper = card ? 'span' : 'div';
  return `<${wrapper} class="recipe-metadata">${values.join('')}${shown.map(tag => `<span class="recipe-tag">${escapeHtml(tag)}</span>`).join('')}${remaining}</${wrapper}>`;
}
export function renderRecipeSource(recipe) {
  let href = '';
  try { const url = new URL(recipe.source_url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) href = url.href; } catch {}
  if (!href && !recipe.source_name && !recipe.source_yield) return '';
  return `<div class="recipe-source"><span>${escapeHtml(t('recipe.source.title'))}: ${href ? `<a href="${escapeHtmlAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(recipe.source_name || new URL(href).hostname)}</a>` : escapeHtml(recipe.source_name || '')}</span>${recipe.source_yield ? `<span>${escapeHtml(t('recipe.source.yield'))}: ${escapeHtml(recipe.source_yield)}</span>` : ''}</div>`;
}
function renderStep(step, { ingredientsHtml = '', headingTag = 'h3', headingId = '' } = {}) {
  const heading = step.title || '', body = step.text || '';
  return `<div class="recipe-step-copy">${heading ? `<${headingTag}${headingId ? ` id="${headingId}"` : ''}>${escapeHtml(heading)}</${headingTag}>` : ''}${ingredientsHtml}${body ? `<p>${escapeHtml(body)}</p>` : ''}</div>`;
}
const sortModes = ['name', 'newest', 'time'];
const tagsForBook = book => [...new Set((book?.recipes || []).flatMap(recipe => recipe.tags || []))];
const completeTime = recipe => recipe.prep_minutes != null && recipe.cook_minutes != null ? recipe.prep_minutes + recipe.cook_minutes : Infinity;
export function renderRecipeOverview(cookbook, query = '', { tags = [], sort = 'name' } = {}) {
  const term = query.trim().toLocaleLowerCase(getActiveLocale());
  const collator = new Intl.Collator(getActiveLocale(), { numeric: true, sensitivity: 'base' });
  const availableTags = tagsForBook(cookbook).sort(collator.compare);
  const selected = tags.filter(tag => availableTags.includes(tag));
  const mode = sortModes.includes(sort) ? sort : 'name';
  const byName = (a, b) => collator.compare(a.title, b.title) || String(a.id).localeCompare(String(b.id));
  const recipes = (cookbook.recipes || []).filter(recipe => selected.every(tag => (recipe.tags || []).includes(tag))
    && (!term || `${recipe.title} ${(recipe.tags || []).join(' ')} ${(recipe.ingredient_groups || []).flatMap(group => group.ingredients || []).map(item => item.name).join(' ')}`.toLocaleLowerCase(getActiveLocale()).includes(term)))
    .sort((a, b) => {
      if (mode === 'newest') { const difference = (parseServerUtcTimestamp(b.created_at)?.getTime() || 0) - (parseServerUtcTimestamp(a.created_at)?.getTime() || 0); if (difference) return difference; }
      if (mode === 'time') { const left = completeTime(a), right = completeTime(b); if (left !== right) return left < right ? -1 : 1; }
      return byName(a, b);
    });
  return `<section class="recipe-overview"><div class="recipe-page-heading"><div><h1>${escapeHtml(cookbook.name)}</h1>
    ${cookbook.description ? `<p class="recipe-description">${escapeHtml(cookbook.description)}</p>` : ''}</div>
${canEditRecipe(null, cookbook) ? button('import', t('recipe.import.title'), 'download') : ''}</div>
    <div class="recipe-overview-tools"><p class="recipe-result-count" role="status">${escapeHtml(t('recipe.count', { count: recipes.length }))}</p>
      <div class="recipe-sort-field"><label for="recipe-overview-sort" id="recipe-sort-label">${escapeHtml(t('recipe.sort'))}</label><select id="recipe-overview-sort" class="ui-field" data-recipe-sort>${sortModes.map(value => `<option value="${value}"${value === mode ? ' selected' : ''}>${escapeHtml(t(`recipe.sort.${value}`))}</option>`).join('')}</select></div></div>
    ${availableTags.length ? `<div class="recipe-tag-filters" role="group" aria-label="${escapeHtmlAttr(t('recipe.filter.tags'))}">${availableTags.map(tag => `<button type="button" class="btn btn-secondary recipe-filter-tag" data-recipe-action="filter-tag" data-recipe-tag="${escapeHtmlAttr(tag)}" aria-pressed="${selected.includes(tag)}">${escapeHtml(tag)}</button>`).join('')}${selected.length ? button('clear-filters', t('recipe.filter.clear')) : ''}</div>` : ''}
    <div class="recipe-list">${recipes.map(recipe => `<button type="button" class="recipe-card recipe-list-row" data-recipe-action="open" data-recipe-id="${escapeHtmlAttr(recipe.id)}">
      ${image(recipe, 'recipe-thumbnail')}<span class="recipe-list-copy"><strong>${escapeHtml(recipe.title)}</strong>${recipe.description?.trim() ? `<span class="recipe-card-description">${escapeHtml(recipe.description)}</span>` : ''}${metadata(recipe, { card: true })}${recipe.conflict ? `<span class="recipe-conflict-label">${escapeHtml(t('recipe.conflict.title'))}</span>` : ''}</span></button>`).join('')}</div>
    ${!recipes.length ? `<p class="recipe-empty">${escapeHtml(t(selected.length ? 'recipe.filter.empty' : term ? 'recipe.search.empty' : 'cookbook.recipes.empty'))}</p>` : ''}</section>`;
}
function backButton(action, label) {
  return `<button type="button" class="btn btn-secondary recipe-back" data-recipe-action="${action}" title="${escapeHtmlAttr(label)}" aria-label="${escapeHtmlAttr(label)}">${iconSvg('arrow-left')}<span>${escapeHtml(label)}</span></button>`;
}
function renderRecipeViewHeader(cookbook, recipe, { cooking = false, canTransfer = false } = {}) {
  if (cooking) return `<div class="recipe-breadcrumb">${backButton('exit-cooking', t('recipe.cooking.exit'))}</div>`;
  const modeSwitch = recipe.steps?.length ? `<div class="ui-segmented-control recipe-view-mode" role="group" aria-label="${escapeHtmlAttr(t('recipe.view.mode'))}">
    <button type="button" class="ui-segmented-option" data-recipe-action="exit-cooking" aria-pressed="${!cooking}">${escapeHtml(t('recipe.cooking.exit'))}</button>
    <button type="button" class="ui-segmented-option" data-recipe-action="cook" aria-pressed="${cooking}">${escapeHtml(t('recipe.cooking.start'))}</button></div>` : '';
  return `<div class="recipe-breadcrumb">${backButton('overview', cookbook.name)}
    <div class="recipe-reading-actions">${modeSwitch}${canTransfer ? `<button type="button" class="btn btn-secondary" data-recipe-action="transfer">${iconSvg('shopping-cart')}${escapeHtml(t('recipe.transfer.action'))}</button>` : ''}${canEditRecipe(recipe, cookbook) ? button('edit', t('recipe.edit'), 'pencil') : ''}</div></div>`;
}
export function renderRecipeReading(cookbook, recipe, { servings = recipe.base_servings, checked = new Set(), canTransfer = false } = {}) {
  return `<article class="recipe-reading">${renderRecipeViewHeader(cookbook, recipe, { canTransfer })}
    ${renderRecipeConflict(recipe, { editable: canEditRecipe(recipe, cookbook) })}<div class="recipe-heading"><div><h1>${escapeHtml(recipe.title)}</h1>${recipe.description ? `<p class="recipe-description">${escapeHtml(recipe.description)}</p>` : ''}${metadata(recipe)}${renderRecipeSource(recipe)}</div>${image(recipe, 'recipe-title-image')}</div>
    <div class="recipe-columns"><section aria-labelledby="recipe-ingredients-title"><div class="recipe-section-heading"><h2 id="recipe-ingredients-title">${escapeHtml(t('recipe.ingredients'))}</h2>
      ${renderServingsControl({ id: 'recipe-view-servings', labelId: 'recipe-servings-label', value: servings, recipeActions: true })}</div>
      <div class="recipe-ingredient-groups">${(recipe.ingredient_groups || []).map(group => `<section class="recipe-ingredient-group">${group.name ? `<h3>${escapeHtml(group.name)}</h3>` : ''}
        ${(group.ingredients || []).map(item => `<label class="recipe-ingredient"><span class="ui-checkbox-label ui-checkbox-round"><input type="checkbox" data-recipe-ingredient="${escapeHtmlAttr(item.client_key)}" ${checked.has(item.client_key) ? 'checked' : ''}><span class="ui-checkbox-box" aria-hidden="true">${iconSvg('check')}</span></span>
          <span class="recipe-ingredient-copy"><span class="recipe-ingredient-main"><b data-recipe-amount="${escapeHtmlAttr(item.client_key)}">${escapeHtml(ingredientAmount(item, servings, recipe.base_servings))}</b> ${escapeHtml(item.name)}</span>${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}</span></label>`).join('')}</section>`).join('')}</div></section>
      <section aria-labelledby="recipe-steps-title"><h2 id="recipe-steps-title">${escapeHtml(t('recipe.steps'))}</h2><ol class="recipe-steps">${(recipe.steps || []).map((step, index) => `<li data-recipe-step-key="${escapeHtmlAttr(step.client_key)}"><span class="recipe-step-number" aria-hidden="true">${index + 1}</span>${renderStep(step, { ingredientsHtml: renderRecipeStepIngredients(recipe, step, { servings }) })}</li>`).join('')}</ol></section></div>
    <p id="recipe-view-error" class="form-error" role="alert"></p></article>`;
}

export function renderRecipeCooking(cookbook, recipe, { servings = recipe.base_servings, stepIndex = 0, canTransfer = false } = {}) {
  const steps = recipe.steps || [], index = Math.max(0, Math.min(stepIndex, steps.length - 1)), step = steps[index];
  if (!step) return renderRecipeReading(cookbook, recipe, { servings, canTransfer });
  return `<article class="recipe-cooking">${renderRecipeViewHeader(cookbook, recipe, { cooking: true, canTransfer })}
    <div class="recipe-cooking-heading"><h1>${escapeHtml(recipe.title)}</h1>${renderServingsControl({ id: 'recipe-view-servings', labelId: 'recipe-servings-label', value: servings, recipeActions: true })}</div>
    <p class="recipe-cooking-progress" role="status" aria-live="polite">${escapeHtml(t('recipe.cooking.progress', { current: index + 1, total: steps.length }))}</p>
    <section class="recipe-cooking-step" data-recipe-step-key="${escapeHtmlAttr(step.client_key)}" ${step.title ? 'aria-labelledby="recipe-cooking-step-title"' : `aria-label="${escapeHtmlAttr(t('recipe.step.number', { number: index + 1 }))}"`} tabindex="0"><span class="recipe-step-number" aria-hidden="true">${index + 1}</span>${renderStep(step, { headingTag: 'h2', headingId: 'recipe-cooking-step-title', ingredientsHtml: renderRecipeStepIngredients(recipe, step, { servings }) })}</section>
    <nav class="recipe-cooking-navigation" aria-label="${escapeHtmlAttr(t('recipe.steps'))}">${button('previous-step', t('recipe.cooking.previous'), null, index === 0 ? 'disabled' : '')}${button('next-step', t('recipe.cooking.next'), null, index === steps.length - 1 ? 'disabled' : '')}</nav>
    <p id="recipe-view-error" class="form-error" role="alert"></p></article>`;
}

export function createRecipeViewFeature({ getCookbooks = () => [], getActiveCookbookId = () => null,
  getActorId = () => null, getSessionIdentity = () => 'embedded', root = globalThis.document,
  historyTarget = globalThis.history, eventTarget = globalThis.window,
  onCreate = () => {}, onImport = () => {}, onEdit = () => {}, onTransfer = null, canTransfer = () => true, recipeController, confirmDanger = async () => false,
  loadRecipeImage = async () => false, releaseRecipeImage = () => {}, onError = console.error,
} = {}) {
  let activeId = null, bookIdentity = null, previous = [], session = getSessionIdentity(), epoch = 0, bound = false, visible = true;
  let portions = null, checked = new Set(), latestQuery = '', resolving = false, renderedHtml = null;
  let selectedTags = new Set(), sortMode = 'name', sortSelect = null;
  let cooking = false, cookingStepKey = null, cookingStepIndex = 0, cookingHistoryRecipeId = null;
  let historyHydrated = false;
  let hadAuthenticatedSession = session != null && getActorId() != null;
  const imageKeys = new WeakMap();
  const aliases = new Map();
  const main = () => root.getElementById('cookbook-navigation-main');
  const cookbook = () => getCookbooks().find(book => sameEntityId(book.id, getActiveCookbookId()));
  const recipes = () => cookbook()?.recipes || [];
  const own = recipe => getActorId() != null && sameEntityId(recipe?.created_by_user_id, getActorId());
  function find(id) {
    const exact = recipes().find(recipe => sameEntityId(recipe.id, id));
    if (exact) return exact;
    const mapped = aliases.get(String(id));
    return recipes().find(recipe => own(recipe) && (sameEntityId(recipe.id, mapped) || (!/^\d+$/.test(String(id)) && sameEntityId(recipe.client_mutation_id, id))));
  }
  function route(replace = false) {
    historyTarget?.[replace ? 'replaceState' : 'pushState']?.({ ...(historyTarget.state || {}), niaModuleRoute: true, moduleId: 'recipes', niaCookbookRoute: true,
      cookbookId: cookbook()?.id ?? null, niaRecipeRoute: true, recipeId: activeId,
      recipeCooking: cooking, recipeCookingStepKey: cooking ? cookingStepKey : null,
      recipeCookingActorId: cooking ? getActorId() : null, recipeCookingServings: cooking ? portions : null }, '', `${eventTarget?.location?.pathname || '/'}${eventTarget?.location?.search || ''}`);
  }
  function resetCooking() { main()?.classList.remove('recipe-page-cooking'); cooking = false; cookingStepKey = null; cookingStepIndex = 0; cookingHistoryRecipeId = null; }
  function release() { main()?.querySelectorAll('img[data-recipe-image]').forEach(releaseRecipeImage); }
  function closeSort() { if (sortSelect?.wrapper.classList.contains('is-open')) closeOpenDropdown('recipe-view-change'); }
  function resetOverview() { selectedTags.clear(); sortMode = 'name'; closeSort(); }
  function replaceContent(container, html) {
    const staging = root.createElement('div'); staging.innerHTML = html;
    const oldSort = container.querySelector('.recipe-sort-field'), nextSort = staging.querySelector('.recipe-sort-field');
    const signature = field => {
      const select = field?.querySelector('select');
      return select ? JSON.stringify([field.querySelector('label')?.textContent, select.value,
        Array.from(select.options, option => [option.value, option.textContent])]) : null;
    };
    const preserveSort = oldSort && nextSort && signature(oldSort) === signature(nextSort);
    if (preserveSort) nextSort.replaceWith(oldSort); else { closeSort(); sortSelect = null; }
    container.replaceChildren(...staging.childNodes);
  }
  function render({ cookbook: book = cookbook(), searchQuery = latestQuery } = {}) {
    latestQuery = String(searchQuery || '');
    if (session !== getSessionIdentity()) { historyHydrated ||= hadAuthenticatedSession; resetCooking(); resetOverview(); session = getSessionIdentity(); activeId = null; bookIdentity = null; previous = []; aliases.clear(); checked.clear(); portions = null; }
    hadAuthenticatedSession ||= session != null && getActorId() != null;
    if (!book) { resetCooking(); resetOverview(); release(); activeId = null; previous = []; return false; }
    const identity = `${book.created_by_user_id ?? ''}:${book.client_mutation_id ?? book.id}`;
    if (bookIdentity != null && identity !== bookIdentity) { resetCooking(); resetOverview(); activeId = null; checked.clear(); portions = null; previous = []; }
    bookIdentity = identity;
    const availableTags = tagsForBook(book);
    selectedTags = new Set([...selectedTags].filter(tag => availableTags.includes(tag)));
    for (const recipe of book.recipes || []) {
      if (!own(recipe) || recipe.client_mutation_id == null) continue;
      const old = previous.find(candidate => own(candidate) && String(candidate.id).startsWith('temp-') && sameEntityId(candidate.client_mutation_id, recipe.client_mutation_id));
      if (old && !sameEntityId(old.id, recipe.id)) { aliases.set(String(old.id), recipe.id); if (sameEntityId(cookingHistoryRecipeId, old.id)) cookingHistoryRecipeId = recipe.id; if (sameEntityId(activeId, old.id)) { activeId = recipe.id; route(true); } }
    }
    if (activeId == null && previous.length === 0 && historyTarget?.state?.niaRecipeRoute && sameEntityId(historyTarget.state.cookbookId, book.id)) {
      activeId = find(historyTarget.state.recipeId)?.id ?? null;
    }
    previous = (book.recipes || []).map(recipe => ({ id: recipe.id, client_mutation_id: recipe.client_mutation_id, created_by_user_id: recipe.created_by_user_id }));
    let recipe = activeId == null ? null : find(activeId);
    if (activeId != null && !recipe) { resetCooking(); activeId = null; route(true); checked.clear(); portions = null; }
    if (recipe && portions == null) portions = recipe.base_servings;
    if (recipe && !historyHydrated) {
      historyHydrated = true;
      const state = historyTarget?.state;
      if (visible && state?.recipeCooking && getActorId() != null && sameEntityId(state.recipeCookingActorId, getActorId())
        && sameEntityId(state.recipeId, recipe.id) && recipe.steps?.length) {
        cooking = true; cookingHistoryRecipeId = recipe.id; cookingStepKey = state.recipeCookingStepKey;
        if (Number.isFinite(Number(state.recipeCookingServings)) && Number(state.recipeCookingServings) > 0 && Number(state.recipeCookingServings) <= 100000) portions = Number(state.recipeCookingServings);
      }
    }
    if (cooking && recipe) {
      const steps = recipe.steps || [], index = steps.findIndex(step => step.client_key === cookingStepKey);
      if (!steps.length) { resetCooking(); route(true); }
      else {
        const previousKey = cookingStepKey;
        cookingStepIndex = index < 0 ? Math.min(cookingStepIndex, steps.length - 1) : index; cookingStepKey = steps[cookingStepIndex].client_key;
        if (previousKey !== cookingStepKey && visible && historyTarget?.state?.recipeCooking) route(true);
      }
    }
    const container = main();
    if (!container) return false;
    container.classList.remove('module-empty-page', 'module-collection-page'); container.classList.add('recipe-page');
    container.classList.toggle('recipe-page-cooking', Boolean(visible && cooking && recipe));
    const options = { servings: portions, checked, stepIndex: cookingStepIndex, canTransfer: Boolean(onTransfer) && canTransfer() };
    const html = recipe ? (cooking ? renderRecipeCooking(book, recipe, options) : renderRecipeReading(book, recipe, options)) : renderRecipeOverview(book, latestQuery, { tags: [...selectedTags], sort: sortMode });
    if (renderedHtml !== html) {
      renderedHtml = html;
      const focused = container.contains(root.activeElement) ? root.activeElement?.closest?.('[data-recipe-action]')?.dataset : null;
      const sortFocused = sortSelect?.trigger === root.activeElement;
      release(); epoch++; replaceContent(container, html);
      if (focused) Array.from(container.querySelectorAll('[data-recipe-action]')).find(button =>
        button.dataset.recipeAction === focused.recipeAction && button.dataset.recipeTag === focused.recipeTag
        && button.dataset.recipeId === focused.recipeId)?.focus({ preventScroll: true });
      const select = container.querySelector('[data-recipe-sort]');
      if (select) { sortSelect = hydrateSelect(select, { className: 'recipe-sort-select' }); refreshSelect(select); if (sortFocused) sortSelect.trigger.focus(); }
    }
    const requestedEpoch = epoch, capturedSession = session;
    for (const img of visible ? container.querySelectorAll('img[data-recipe-image]') : []) {
      const item = (book.recipes || []).find(candidate => sameEntityId(candidate.id, img.dataset.recipeImage));
      if (!item) continue;
      const key = JSON.stringify([item.id, item.image_version, item.image_url, item.image_data]);
      if (imageKeys.get(img) === key) continue;
      imageKeys.set(img, key);
      const isCurrent = () => imageKeys.get(img) === key && requestedEpoch === epoch && capturedSession === getSessionIdentity() && img.isConnected && recipes().some(candidate => sameEntityId(candidate.id, item.id));
      Promise.resolve(loadRecipeImage(img, item, { isCurrent })).then(ok => { if (isCurrent()) { img.hidden = !ok; const placeholder = img.parentElement.querySelector('.recipe-image-placeholder'); if (placeholder) placeholder.hidden = Boolean(ok); } }).catch(error => { if (isCurrent()) onError(error); });
    }
    const fab = root.querySelector('[data-module-panel="recipes"][data-module-slot="floating"] [data-recipe-action="create"]');
    if (fab) { fab.hidden = cooking || !canEditRecipe(null, book); fab.disabled = cooking || !canEditRecipe(null, book); }
    return true;
  }
  function selectRecipe(id, { replaceHistory = false, updateNavigation = true } = {}) {
    const recipe = find(id);
    if (!recipe) return false;
    historyHydrated = true; resetCooking(); activeId = recipe.id; portions = recipe.base_servings; checked = new Set();
    if (updateNavigation) route(replaceHistory);
    render(); main()?.closest('.main')?.scrollTo?.({ top: 0 });
    return true;
  }
  function showOverview({ replaceHistory = false, updateNavigation = true } = {}) {
    historyHydrated = true; resetCooking(); activeId = null; portions = null; checked.clear();
    if (updateNavigation) route(replaceHistory);
    // Explicit overview wins over an older recipe entry during this render.
    previous = [{ id: null }]; render();
  }
  function updatePortions(value) {
    const recipe = find(activeId), amount = Number(value);
    if (!recipe || !Number.isFinite(amount) || amount <= 0 || amount > 100000) return;
    portions = amount;
    const input = root.getElementById('recipe-view-servings'); if (input) input.value = String(amount);
    main()?.querySelectorAll('[data-recipe-amount]').forEach(node => {
      const ingredient = recipe.ingredient_groups.flatMap(group => group.ingredients || []).find(item => item.client_key === node.dataset.recipeAmount);
      if (ingredient) node.textContent = ingredientAmount(ingredient, amount, recipe.base_servings);
    });
    if (input) refreshServingsControl(input);
    refreshRecipeStepIngredientAmounts(main(), recipe, amount);
    if (cooking) route(true);
  }
  function enterCooking() {
    const recipe = find(activeId);
    if (!visible || !recipe?.steps?.length || cooking) return false;
    // A previous module activation may have left a cooking flag in this entry.
    // Always establish the reading entry that Back will return to first.
    route(true);
    cooking = true; cookingStepIndex = 0; cookingStepKey = recipe.steps[0].client_key; cookingHistoryRecipeId = recipe.id;
    route(); render(); main()?.closest('.main')?.scrollTo?.({ top: 0 }); main()?.querySelector('.recipe-cooking-step')?.focus({ preventScroll: true }); return true;
  }
  function exitCooking() {
    if (!cooking) return;
    cooking = false; cookingStepKey = null; cookingStepIndex = 0; render();
    if (historyTarget?.state?.recipeCooking && sameEntityId(historyTarget.state.recipeId, activeId) && typeof historyTarget.back === 'function') historyTarget.back();
    else route(true);
    main()?.querySelector('[data-recipe-action="exit-cooking"]')?.focus({ preventScroll: true });
  }
  function moveCookingStep(direction) {
    const recipe = find(activeId);
    if (!visible || !cooking || !recipe?.steps?.length) return;
    cookingStepIndex = Math.max(0, Math.min(recipe.steps.length - 1, cookingStepIndex + direction));
    cookingStepKey = recipe.steps[cookingStepIndex].client_key; route(true); render();
    main()?.querySelector('.recipe-cooking-step')?.scrollTo?.({ top: 0 });
    if (!main()?.contains(root.activeElement)) main()?.querySelector('.recipe-cooking-step')?.focus({ preventScroll: true });
  }
  async function click(event) {
    const target = event.target.closest?.('[data-recipe-action]');
    if (!target || (!main()?.contains(target) && !target.closest('[data-module-panel="recipes"][data-module-slot="floating"]'))) return;
    const action = target.dataset.recipeAction, book = cookbook(), recipe = find(activeId);
    event.preventDefault();
    if (action === 'open') selectRecipe(target.dataset.recipeId);
    else if (action === 'overview') showOverview({ replaceHistory: true });
    else if (action === 'cook') enterCooking();
    else if (action === 'exit-cooking') exitCooking();
    else if (action === 'previous-step') moveCookingStep(-1);
    else if (action === 'next-step') moveCookingStep(1);
    else if (action === 'create' && canEditRecipe(null, book)) onCreate(book);
    else if (action === 'import' && canEditRecipe(null, book)) onImport(book);
    else if (action === 'edit' && canEditRecipe(recipe, book)) onEdit(recipe);
    else if (action === 'transfer' && visible && recipe && onTransfer && canTransfer()) onTransfer(recipe, { servings: portions });
    else if (action === 'more' || action === 'less') updatePortions(stepServings(portions, action === 'more' ? 1 : -1));
    else if (action === 'filter-tag' && visible && !recipe && tagsForBook(book).includes(target.dataset.recipeTag)) {
      const tag = target.dataset.recipeTag;
      if (selectedTags.has(tag)) selectedTags.delete(tag); else selectedTags.add(tag);
      render();
    }
    else if (action === 'clear-filters' && visible && !recipe) { selectedTags.clear(); render(); main()?.querySelector('.recipe-filter-tag')?.focus({ preventScroll: true }); }
    else if (['keep-local', 'use-server'].includes(action) && recipe?.conflict && canEditRecipe(recipe, book) && !resolving) {
      const token = {}; resolving = token;
      const captured = getSessionIdentity(), requestedId = recipe.id, capturedEpoch = epoch;
      const isCurrent = () => visible && capturedEpoch === epoch && captured === getSessionIdentity() && sameEntityId(activeId, requestedId) && Boolean(find(requestedId));
      try { await resolveRecipeConflict({ recipe, keepLocal: action === 'keep-local', controller: recipeController, confirmDanger, isCurrent }); if (isCurrent()) render(); }
      catch (error) { if (isCurrent()) { const node = root.getElementById('recipe-view-error'); if (node) node.textContent = t('recipe.error.saveFailed'); onError(error); } }
      finally { if (resolving === token) resolving = false; }
    }
  }
  function bind() {
    if (bound) return; bound = true; root.addEventListener('click', click);
    root.addEventListener('input', event => {
      if (event.target.id === 'recipe-view-servings') updatePortions(event.target.value);
    });
    root.addEventListener('change', event => {
      if (event.target.matches?.('[data-recipe-sort]') && visible && main()?.contains(event.target) && sortModes.includes(event.target.value)) { sortMode = event.target.value; render(); }
      if (event.target.id === 'recipe-view-servings') updatePortions(event.target.value);
      if (event.target.matches?.('[data-recipe-ingredient]') && main()?.contains(event.target)) {
        const key = event.target.dataset.recipeIngredient; if (event.target.checked) checked.add(key); else checked.delete(key);
      }
    });
  }
  function deactivate() { historyHydrated ||= bookIdentity != null || activeId != null || cooking; resetCooking(); resetOverview(); visible = false; epoch++; renderedHtml = null; release(); resolving = false; }
  function clear() { const wasVisible = visible; deactivate(); visible = wasVisible; activeId = null; portions = null; checked.clear(); previous = []; aliases.clear(); bookIdentity = null; const fab = root.querySelector('[data-module-panel="recipes"][data-module-slot="floating"] [data-recipe-action="create"]'); if (fab) fab.hidden = true; }
  function remapRecipeId(from, to) {
    const target = recipes().find(recipe => sameEntityId(recipe.id, to));
    if (!target || !own(target) || recipes().some(recipe => sameEntityId(recipe.id, from))) return false;
    if (!sameEntityId(target.client_mutation_id, from) && !sameEntityId(aliases.get(String(from)), to)) return false;
    aliases.set(String(from), to);
    if (sameEntityId(cookingHistoryRecipeId, from)) cookingHistoryRecipeId = to;
    if (sameEntityId(activeId, from)) { activeId = to; route(true); render(); }
    return true;
  }
  return { bind, render, activate: () => { visible = true; }, selectRecipe, showOverview, deactivate, clear, remapRecipeId,
    getActiveRecipeId: () => activeId,
    applyHistory: state => {
      const recipe = state?.niaRecipeRoute ? find(state.recipeId) : null;
      if (!recipe) { showOverview({ updateNavigation: false }); return; }
      if (!sameEntityId(recipe.id, activeId)) selectRecipe(recipe.id, { updateNavigation: false });
      cooking = Boolean(visible && state.recipeCooking && sameEntityId(state.recipeCookingActorId, getActorId())
        && sameEntityId(cookingHistoryRecipeId, recipe.id) && recipe.steps?.length);
      cookingStepKey = cooking ? state.recipeCookingStepKey : null; if (!cooking) cookingStepIndex = 0;
      render();
    },
  };
}
