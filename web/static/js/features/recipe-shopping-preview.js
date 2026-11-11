import { getQuantityUnitDefinition, normalizeQuantityUnit } from '../core/quantity-units.js';

// Decimal source values are added before converting to Number/display rounding.
// This is a preview only; the original source keys remain the server payload.
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; };
function rational(n, d = 1n) { const divisor = gcd(n, d) || 1n; return { n: n / divisor, d: d / divisor }; }
function decimal(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const [digits, exponent = '0'] = String(number).toLowerCase().split('e');
  const [whole, fraction = ''] = digits.split('.');
  const power = Number(exponent) - fraction.length, n = BigInt(whole + fraction);
  return power >= 0 ? rational(n * 10n ** BigInt(power)) : rational(n, 10n ** BigInt(-power));
}
const multiply = (a, b) => rational(a.n * b.n, a.d * b.d);
const divide = (a, b) => rational(a.n * b.d, a.d * b.n);
const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
function numeric(value) {
  const n = Number(value.n), d = Number(value.d);
  if (Number.isFinite(n) && Number.isFinite(d)) return n / d;
  const numerator = value.n.toString(), denominator = value.d.toString();
  const left = numerator.slice(0, 16), right = denominator.slice(0, 16);
  return Number(`${Number(left) / Number(right)}e${numerator.length - left.length - denominator.length + right.length}`);
}
const normalizedName = value => String(value || '').normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ').trim().replace(/\s+/gu, ' ');
function unitIdentity(unit) {
  const definition = getQuantityUnitDefinition(unit);
  return ['mass', 'volume'].includes(definition?.kind) ? `${definition.kind}:${definition.base_unit}` : `literal:${JSON.stringify(unit)}`;
}
const factor = unit => decimal(getQuantityUnitDefinition(unit)?.factor || 1);

/** Groups only selected recipe source lines, never step references/amounts. */
export function buildRecipeShoppingPreview(recipe, selections, { servings = recipe.base_servings, separated = new Set() } = {}) {
  const separatedSources = [...separated].map(id => new Set(JSON.parse(id)));
  const selected = new Map(selections.map(row => [row.ingredient_client_key, row]));
  const families = new Map();
  let index = 0;
  for (const ingredient of (recipe.ingredient_groups || []).flatMap(group => group.ingredients || [])) {
    const position = index++, selection = selected.get(ingredient.client_key);
    if (!selection) continue;
    const unit = normalizeQuantityUnit(ingredient.quantity_unit);
    const measured = ingredient.quantity_value != null && Number.isFinite(Number(ingredient.quantity_value))
      && Number(ingredient.quantity_value) >= 0 && !ingredient.quantity_text;
    const sectionId = selection.section_id ?? null, storeIds = [...(selection.store_ids || [])].map(String).sort();
    const key = measured ? JSON.stringify([normalizedName(ingredient.name), unitIdentity(unit), sectionId == null ? null : String(sectionId), storeIds]) : `unmeasured:${position}`;
    if (!families.has(key)) families.set(key, { key, rows: [], token: `recipe-transfer-${position}` });
    families.get(key).rows.push({ ingredient, unit, measured, selection });
  }
  const result = [], mergeGroups = new Map();
  for (const family of families.values()) {
    const notes = [...new Set(family.rows.map(row => row.ingredient.note || ''))];
    // Separation follows original sources across canonical target ID receipts.
    const id = JSON.stringify(family.rows.map(row => row.ingredient.client_key));
    const canCombine = family.rows.length > 1 && notes.length > 1 && family.rows.every(row => row.measured);
    const combine = canCombine && !separatedSources.some(keys => family.rows.every(row => keys.has(row.ingredient.client_key))), buckets = new Map();
    for (const row of family.rows) {
      const key = combine ? '' : row.ingredient.note || '';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
      if (combine) mergeGroups.set(row.ingredient.client_key, family.token);
    }
    const groups = [...buckets.values()].map(rows => {
      const first = rows[0], sourceKeys = rows.map(row => row.ingredient.client_key);
      let amount = null;
      if (first.measured && Number.isFinite(Number(servings)) && Number(servings) > 0
        && Number.isFinite(Number(recipe.base_servings)) && Number(recipe.base_servings) > 0) {
        let sum = rational(0n);
        for (const row of rows) sum = add(sum, divide(multiply(decimal(row.ingredient.quantity_value), factor(row.unit)), factor(first.unit)));
        amount = numeric(divide(multiply(sum, decimal(servings)), decimal(recipe.base_servings)));
      }
      return { name: first.ingredient.name, amount, unit: first.unit, quantityText: first.ingredient.quantity_text || '',
        notes: [...new Set(rows.map(row => row.ingredient.note || '').filter(Boolean))], sourceKeys,
        sectionId: first.selection.section_id ?? null, storeIds: [...(first.selection.store_ids || [])] };
    });
    result.push({ id, groups, canCombine, combined: combine });
  }
  return { families: result, mergeGroups };
}
