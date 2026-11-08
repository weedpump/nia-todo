import { t, getActiveLocale } from '../i18n/index.js';
import { escapeHtml, escapeHtmlAttr } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { sameEntityId } from './entity-metadata.js';

export const canEditRecipe = (recipe, cookbook) => Boolean(cookbook && (cookbook.can_edit === true || cookbook.can_edit === 1)
  && (!recipe || recipe.can_edit === true || recipe.can_edit === 1));
const button = (action, label, icon, attributes = '') => `<button type="button" class="btn btn-secondary${icon ? ' btn-icon' : ''}" data-recipe-action="${action}" aria-label="${escapeHtmlAttr(label)}" title="${escapeHtmlAttr(label)}" ${attributes}>${icon ? iconSvg(icon) : escapeHtml(label)}</button>`;
export function ingredientAmount(ingredient, servings, baseServings, locale = getActiveLocale()) {
  if (ingredient.quantity_text) return ingredient.quantity_text;
  if (ingredient.quantity_value == null) return '';
  const amount = Number(ingredient.quantity_value) * Number(servings) / Number(baseServings);
  return `${Number.isFinite(amount) ? new Intl.NumberFormat(locale, { maximumSignificantDigits: 8 }).format(amount) : '—'}${ingredient.quantity_unit ? ` ${ingredient.quantity_unit}` : ''}`;
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
  return `<div class="${className}"><img data-recipe-image="${escapeHtmlAttr(recipe.id)}" alt="${escapeHtmlAttr(recipe.title)}" hidden><span class="recipe-image-placeholder" aria-hidden="true">${iconSvg('image')}</span></div>`;
}
function metadata(recipe) {
  const values = [];
  if (recipe.prep_minutes != null) values.push(`<span>${iconSvg('clock')}${escapeHtml(t('recipe.prepTime', { minutes: recipe.prep_minutes }))}</span>`);
  if (recipe.cook_minutes != null) values.push(`<span>${iconSvg('flame')}${escapeHtml(t('recipe.cookTime', { minutes: recipe.cook_minutes }))}</span>`);
  return `<div class="recipe-metadata">${values.join('')}${(recipe.tags || []).map(tag => `<span class="recipe-tag">${escapeHtml(tag)}</span>`).join('')}</div>`;
}
function renderStep(text) {
  const [heading, ...lines] = text.split(/\r?\n/);
  const body = lines.join('\n');
  return `<div class="recipe-step-copy"><h3>${escapeHtml(heading)}</h3>${body ? `<p>${escapeHtml(body)}</p>` : ''}</div>`;
}
export function renderRecipeOverview(cookbook, query = '') {
  const term = query.trim().toLocaleLowerCase();
  const recipes = (cookbook.recipes || []).filter(recipe => !term || `${recipe.title} ${(recipe.tags || []).join(' ')} ${(recipe.ingredient_groups || []).flatMap(group => group.ingredients || []).map(item => item.name).join(' ')}`.toLocaleLowerCase().includes(term));
  return `<section class="recipe-overview"><div class="recipe-page-heading"><div><p class="module-page-eyebrow">${escapeHtml(t('recipe.cookbook'))}</p><h1>${escapeHtml(cookbook.name)}</h1>
    ${cookbook.description ? `<p class="recipe-description">${escapeHtml(cookbook.description)}</p>` : ''}</div>
</div>
    <div class="recipe-list">${recipes.map(recipe => `<button type="button" class="recipe-list-row" data-recipe-action="open" data-recipe-id="${escapeHtmlAttr(recipe.id)}">
      ${image(recipe, 'recipe-thumbnail')}<span class="recipe-list-copy"><strong>${escapeHtml(recipe.title)}</strong>${metadata(recipe)}${recipe.conflict ? `<span class="recipe-conflict-label">${escapeHtml(t('recipe.conflict.title'))}</span>` : ''}</span>${iconSvg('chevron-right')}</button>`).join('')}</div>
    ${!recipes.length ? `<p class="recipe-empty">${escapeHtml(t(term ? 'recipe.search.empty' : 'cookbook.recipes.empty'))}</p>` : ''}</section>`;
}
export function renderRecipeReading(cookbook, recipe, { servings = recipe.base_servings, checked = new Set() } = {}) {
  return `<article class="recipe-reading"><div class="recipe-breadcrumb"><button type="button" class="recipe-back" data-recipe-action="overview">${iconSvg('arrow-left')}${escapeHtml(cookbook.name)}</button>
      ${canEditRecipe(recipe, cookbook) ? button('edit', t('recipe.edit'), 'pencil') : ''}</div>
    ${renderRecipeConflict(recipe, { editable: canEditRecipe(recipe, cookbook) })}<div class="recipe-heading"><div><h1>${escapeHtml(recipe.title)}</h1>${recipe.description ? `<p class="recipe-description">${escapeHtml(recipe.description)}</p>` : ''}${metadata(recipe)}</div>${image(recipe, 'recipe-title-image')}</div>
    <div class="recipe-columns"><section aria-labelledby="recipe-ingredients-title"><div class="recipe-section-heading"><h2 id="recipe-ingredients-title">${escapeHtml(t('recipe.ingredients'))}</h2>
      <div class="recipe-servings-field"><label id="recipe-servings-label" for="recipe-view-servings">${escapeHtml(t('recipe.servings'))}</label>
        <div class="recipe-servings" role="group" aria-labelledby="recipe-servings-label">${button('less', t('recipe.servings.less'), 'minus', Number(servings) <= 1 ? 'disabled' : '')}
          <input class="ui-field" id="recipe-view-servings" type="number" min="0" max="100000" step="any" value="${escapeHtmlAttr(servings)}" aria-labelledby="recipe-servings-label">
          ${button('more', t('recipe.servings.more'), 'plus', Number(servings) >= 100000 ? 'disabled' : '')}</div></div></div>
      <div class="recipe-ingredient-groups">${(recipe.ingredient_groups || []).map(group => `<section class="recipe-ingredient-group">${group.name ? `<h3>${escapeHtml(group.name)}</h3>` : ''}
        ${(group.ingredients || []).map(item => `<label class="recipe-ingredient"><span class="ui-checkbox-label ui-checkbox-round"><input type="checkbox" data-recipe-ingredient="${escapeHtmlAttr(item.client_key)}" ${checked.has(item.client_key) ? 'checked' : ''}><span class="ui-checkbox-box" aria-hidden="true">${iconSvg('check')}</span></span>
          <span class="recipe-ingredient-copy"><span class="recipe-ingredient-main"><b data-recipe-amount="${escapeHtmlAttr(item.client_key)}">${escapeHtml(ingredientAmount(item, servings, recipe.base_servings))}</b> ${escapeHtml(item.name)}</span>${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}</span></label>`).join('')}</section>`).join('')}</div></section>
      <section aria-labelledby="recipe-steps-title"><h2 id="recipe-steps-title">${escapeHtml(t('recipe.steps'))}</h2><ol class="recipe-steps">${(recipe.steps || []).map((step, index) => `<li><span class="recipe-step-number" aria-hidden="true">${index + 1}</span>${renderStep(step.text)}</li>`).join('')}</ol></section></div>
    <p id="recipe-view-error" class="form-error" role="alert"></p></article>`;
}

export function createRecipeViewFeature({ getCookbooks = () => [], getActiveCookbookId = () => null,
  getActorId = () => null, getSessionIdentity = () => 'embedded', root = globalThis.document,
  historyTarget = globalThis.history, eventTarget = globalThis.window,
  onCreate = () => {}, onEdit = () => {}, recipeController, confirmDanger = async () => false,
  loadRecipeImage = async () => false, releaseRecipeImage = () => {}, onError = console.error,
} = {}) {
  let activeId = null, bookIdentity = null, previous = [], session = getSessionIdentity(), epoch = 0, bound = false, visible = true;
  let portions = null, checked = new Set(), latestQuery = '', resolving = false, renderedHtml = null;
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
      cookbookId: cookbook()?.id ?? null, niaRecipeRoute: true, recipeId: activeId }, '', `${eventTarget?.location?.pathname || '/'}${eventTarget?.location?.search || ''}`);
  }
  function release() { main()?.querySelectorAll('img[data-recipe-image]').forEach(releaseRecipeImage); }
  function render({ cookbook: book = cookbook(), searchQuery = latestQuery } = {}) {
    latestQuery = String(searchQuery || '');
    if (session !== getSessionIdentity()) { session = getSessionIdentity(); activeId = null; bookIdentity = null; previous = []; aliases.clear(); checked.clear(); portions = null; }
    if (!book) { release(); activeId = null; previous = []; return false; }
    const identity = `${book.created_by_user_id ?? ''}:${book.client_mutation_id ?? book.id}`;
    if (bookIdentity != null && identity !== bookIdentity) { activeId = null; checked.clear(); portions = null; previous = []; }
    bookIdentity = identity;
    for (const recipe of book.recipes || []) {
      if (!own(recipe) || recipe.client_mutation_id == null) continue;
      const old = previous.find(candidate => own(candidate) && String(candidate.id).startsWith('temp-') && sameEntityId(candidate.client_mutation_id, recipe.client_mutation_id));
      if (old && !sameEntityId(old.id, recipe.id)) { aliases.set(String(old.id), recipe.id); if (sameEntityId(activeId, old.id)) { activeId = recipe.id; route(true); } }
    }
    if (activeId == null && previous.length === 0 && historyTarget?.state?.niaRecipeRoute && sameEntityId(historyTarget.state.cookbookId, book.id)) {
      activeId = find(historyTarget.state.recipeId)?.id ?? null;
    }
    previous = (book.recipes || []).map(recipe => ({ id: recipe.id, client_mutation_id: recipe.client_mutation_id, created_by_user_id: recipe.created_by_user_id }));
    let recipe = activeId == null ? null : find(activeId);
    if (activeId != null && !recipe) { activeId = null; route(true); checked.clear(); portions = null; }
    if (recipe && portions == null) portions = recipe.base_servings;
    const container = main();
    if (!container) return false;
    container.classList.remove('module-empty-page', 'module-collection-page'); container.classList.add('recipe-page');
    const html = recipe ? renderRecipeReading(book, recipe, { servings: portions, checked }) : renderRecipeOverview(book, latestQuery);
    if (renderedHtml !== html) {
      renderedHtml = html;
      const focused = root.activeElement?.closest?.('[data-recipe-action]')?.dataset.recipeAction;
      release(); epoch++; container.innerHTML = html;
      if (focused) Array.from(container.querySelectorAll('[data-recipe-action]')).find(button => button.dataset.recipeAction === focused)?.focus();
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
    if (fab) { fab.hidden = !canEditRecipe(null, book); fab.disabled = !canEditRecipe(null, book); }
    return true;
  }
  function selectRecipe(id, { replaceHistory = false, updateNavigation = true } = {}) {
    const recipe = find(id);
    if (!recipe) return false;
    activeId = recipe.id; portions = recipe.base_servings; checked = new Set();
    if (updateNavigation) route(replaceHistory);
    render(); main()?.closest('.main')?.scrollTo?.({ top: 0 });
    return true;
  }
  function showOverview({ replaceHistory = false, updateNavigation = true } = {}) {
    activeId = null; portions = null; checked.clear();
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
    const less = main()?.querySelector('[data-recipe-action="less"]'), more = main()?.querySelector('[data-recipe-action="more"]');
    if (less) less.disabled = amount <= 1; if (more) more.disabled = amount >= 100000;
  }
  async function click(event) {
    const target = event.target.closest?.('[data-recipe-action]');
    if (!target || (!main()?.contains(target) && !target.closest('[data-module-panel="recipes"][data-module-slot="floating"]'))) return;
    const action = target.dataset.recipeAction, book = cookbook(), recipe = find(activeId);
    event.preventDefault();
    if (action === 'open') selectRecipe(target.dataset.recipeId);
    else if (action === 'overview') showOverview({ replaceHistory: true });
    else if (action === 'create' && canEditRecipe(null, book)) onCreate(book);
    else if (action === 'edit' && canEditRecipe(recipe, book)) onEdit(recipe);
    else if (action === 'more') updatePortions(Number(portions) + 1);
    else if (action === 'less') updatePortions(Number(portions) - 1);
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
    root.addEventListener('change', event => {
      if (event.target.id === 'recipe-view-servings') updatePortions(event.target.value);
      if (event.target.matches?.('[data-recipe-ingredient]') && main()?.contains(event.target)) {
        const key = event.target.dataset.recipeIngredient; if (event.target.checked) checked.add(key); else checked.delete(key);
      }
    });
  }
  function deactivate() { visible = false; epoch++; renderedHtml = null; release(); resolving = false; }
  function clear() { const wasVisible = visible; deactivate(); visible = wasVisible; activeId = null; portions = null; checked.clear(); previous = []; aliases.clear(); bookIdentity = null; const fab = root.querySelector('[data-module-panel="recipes"][data-module-slot="floating"] [data-recipe-action="create"]'); if (fab) fab.hidden = true; }
  function remapRecipeId(from, to) {
    const target = recipes().find(recipe => sameEntityId(recipe.id, to));
    if (!target || !own(target) || recipes().some(recipe => sameEntityId(recipe.id, from))) return false;
    if (!sameEntityId(target.client_mutation_id, from) && !sameEntityId(aliases.get(String(from)), to)) return false;
    aliases.set(String(from), to);
    if (sameEntityId(activeId, from)) { activeId = to; route(true); render(); }
    return true;
  }
  return { bind, render, activate: () => { visible = true; }, selectRecipe, showOverview, deactivate, clear, remapRecipeId,
    getActiveRecipeId: () => activeId,
    applyHistory: state => { const recipe = state?.niaRecipeRoute ? find(state.recipeId) : null; if (recipe && sameEntityId(recipe.id, activeId)) render(); else if (recipe) selectRecipe(recipe.id, { updateNavigation: false }); else showOverview({ updateNavigation: false }); },
  };
}
