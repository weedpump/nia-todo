#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mergeRecipeStepIngredients, projectRecipeCookbook, sanitizeRecipeEntry, validateRecipeChanges } from '../web/static/js/features/recipe-pending.js';
import { getRecipeStepIngredients, renderRecipeStepIngredients, refreshRecipeStepIngredientAmounts } from '../web/static/js/features/recipe-step-ingredients.js';
const recipe = { base_servings: 6, ingredient_groups: [{ ingredients: [
  { client_key: 'milk', name: 'Milk <script>', quantity_value: 250, quantity_unit: 'ml' },
  { client_key: 'salt', name: 'Salt', quantity_text: 'to taste' },
  { client_key: 'lemon', name: 'Lemon', quantity_value: 1, quantity_unit: 'piece' },
  { client_key: 'powder', name: 'Baking powder', quantity_value: .25, quantity_unit: 'pack' },
  { client_key: 'same-name', name: 'Milk <script>', quantity_value: 100, quantity_unit: 'g' },
] }], steps: [
  { client_key: 'mix', text: 'Mix.', ingredients: [{ ingredient_client_key: 'milk', show_quantity: true }, { ingredient_client_key: 'salt', show_quantity: true }, { ingredient_client_key: 'lemon', show_quantity: false }, { ingredient_client_key: 'powder', show_quantity: true }] },
  { client_key: 'finish', text: 'Finish.', ingredients: [{ ingredient_client_key: 'lemon', show_quantity: true }] },
] };
const rows = getRecipeStepIngredients(recipe, recipe.steps[0]);
assert.deepEqual(rows.map(row => row.ingredient.client_key), ['milk', 'salt', 'lemon', 'powder']);
assert.equal(rows[0].showQuantity, true);
assert.equal(rows[2].showQuantity, false);
assert.equal(getRecipeStepIngredients(recipe, recipe.steps[1])[0].partial, false, 'preparation and reuse can both show the full recipe quantity');
const original = structuredClone(recipe);
const html = renderRecipeStepIngredients(recipe, recipe.steps[0], { servings: 2, locale: 'de' });
assert.match(html, /83 ml/);
assert.match(html, /to taste/);
assert.match(html, /Milk &lt;script&gt;/);
assert.doesNotMatch(html, /<script>/);
assert.match(html, /recipe-step-ingredient-partial/);
assert.deepEqual(recipe, original, 'rendering/portion scaling never changes source data');
assert.equal(renderRecipeStepIngredients(recipe, { client_key: 'legacy', text: 'Old step' }), '');
assert.equal(renderRecipeStepIngredients(recipe, { ingredients: [{ ingredient_client_key: 'not-here' }] }), '');
assert.equal(getRecipeStepIngredients(recipe, { ingredients: [{ ingredient_client_key: 'milk' }, { ingredient_client_key: 'milk' }] }).length, 1);
const reduced = structuredClone(recipe); reduced.steps.splice(1); reduced.steps[0].ingredients[2].show_quantity = true;
assert.equal(getRecipeStepIngredients(reduced, reduced.steps[0])[2].showQuantity, true, 'one remaining full-use link can show quantity');
reduced.ingredient_groups[0].ingredients[0].name = 'Renamed';
assert.equal(getRecipeStepIngredients(reduced, reduced.steps[0])[0].ingredient.name, 'Renamed');
const nodes = ['milk', 'salt', 'lemon', 'powder'].map(key => ({ dataset: { recipeStepKey: 'mix', stepIngredientAmount: key }, textContent: '' }));
refreshRecipeStepIngredientAmounts({ querySelectorAll: selector => selector === '[data-step-ingredient-amount]' ? nodes : [] }, recipe, 2, 'de');
assert.deepEqual(nodes.map(node => node.textContent), ['83 ml', 'to taste', '', '0,0833333 Pack.']);
console.log('✅ Optional step references, partial/multiple quantities, portions, stable keys and escaped shared chips passed');

const cake = { base_servings: 2, ingredient_groups: [{ ingredients: [
  {client_key:'flour-dough',name:'Mehl',quantity_value:250,quantity_unit:'g'},
  {client_key:'flour-fill',name:'Mehl',quantity_value:100,quantity_unit:'g'},
  {client_key:'fat',name:'Margarine',quantity_value:70,quantity_unit:'g'},
  {client_key:'apple',name:'Äpfel',quantity_value:1000,quantity_unit:'g'},
  {client_key:'lemon',name:'Zitrone',quantity_value:1,quantity_unit:'piece'},
] }], steps: [
  {client_key:'dough',ingredients:[{ingredient_client_key:'flour-dough',show_quantity:true},{ingredient_client_key:'fat',show_quantity:true,quantity_value:20}]},
  {client_key:'fill',ingredients:[{ingredient_client_key:'flour-fill',show_quantity:true},{ingredient_client_key:'fat',show_quantity:true,quantity_value:40},{ingredient_client_key:'apple',show_quantity:true}]},
  {client_key:'finish',ingredients:[{ingredient_client_key:'fat',show_quantity:true,quantity_value:10},{ingredient_client_key:'apple',show_quantity:true},{ingredient_client_key:'lemon',show_quantity:true,quantity_text:'Abrieb und ½ Saft'}]},
] };
const amounts = [];
for (const step of cake.steps) {
  const output = step.ingredients.map(link => ({dataset:{recipeStepKey:step.client_key,stepIngredientAmount:link.ingredient_client_key},textContent:''}));
  refreshRecipeStepIngredientAmounts({querySelectorAll:selector=>selector==='[data-step-ingredient-amount]'?output:[]},cake,4,'de');
  amounts.push(output.map(node=>node.textContent));
}
assert.deepEqual(amounts,[['500 g','40 g'],['200 g','80 g','2.000 g'],['20 g','2.000 g','Abrieb und ½ Saft']]);
assert.equal(cake.ingredient_groups[0].ingredients[2].quantity_value,70,'step uses never change the recipe total');
assert.equal(getRecipeStepIngredients(cake,cake.steps[1])[2].showQuantity,true);
const malicious = structuredClone(cake); malicious.steps[0].ingredients[0].quantity_text='<img src=x onerror=alert(1)>';
assert.match(renderRecipeStepIngredients(malicious,malicious.steps[0]),/&lt;img src=x/);
assert.doesNotMatch(renderRecipeStepIngredients(malicious,malicious.steps[0]),/<img/);

const canonical = { ...cake, title:'Cake', steps:[cake.steps[0]] };
const key = canonical.steps[0].client_key;
const legacyFields = { steps:[{client_key:key,text:'Older edit',ingredients:[{ingredient_client_key:'fat',show_quantity:true}]}] };
const merged = mergeRecipeStepIngredients(canonical,legacyFields);
assert.equal(merged.steps[0].ingredients[0].quantity_value,20,'old reference fields inherit an existing per-step override');
const hidden = mergeRecipeStepIngredients(canonical,{steps:[{client_key:key,text:'Legacy hide',ingredients:[{ingredient_client_key:'fat',show_quantity:false}]}]});
assert.equal(hidden.steps[0].ingredients[0].quantity_value,null,'explicit legacy hiding clears the inherited override');
assert.equal(hidden.steps[0].ingredients[0].show_quantity,false);
const cleared = mergeRecipeStepIngredients(canonical,{steps:[{client_key:key,text:'Reset',ingredients:[{ingredient_client_key:'fat',show_quantity:true,quantity_value:null,quantity_text:null}]}]});
assert.equal(cleared.steps[0].ingredients[0].quantity_value,null);
const free = mergeRecipeStepIngredients(canonical,{steps:[{client_key:key,text:'Free',ingredients:[{ingredient_client_key:'fat',show_quantity:true,quantity_text:'zum Einfetten'}]}]});
assert.equal(free.steps[0].ingredients[0].quantity_value,null,'free override clears the previous numeric override');
const attempted = {id:1,actor_id:1,action:'UPDATE_RECIPE',attempted:true,data:{id:10,cookbook_id:1,expected_revision:1,client_mutation_id:'old-request',changes:legacyFields}};
const beforeAttempt = JSON.stringify(attempted);
const projected = projectRecipeCookbook({id:1,can_edit:true,recipes:[{...canonical,id:10}]},[attempted]);
assert.equal(projected.recipes[0].steps[0].ingredients[0].quantity_value,20);
assert.equal(Object.hasOwn(sanitizeRecipeEntry(attempted).data.changes.steps[0].ingredients[0],'quantity_value'),false);
assert.equal(JSON.stringify(attempted),beforeAttempt,'effective defaults never rewrite an attempted body');
const validSource = { title:'Cake', ingredient_groups:canonical.ingredient_groups.map((group,index)=>({...group,client_key:`group-${index}`,name:''})), steps:[{client_key:'s',text:'Use fat',ingredients:[]}] };
for (const link of [
 {quantity_value:0},{quantity_value:-1},{quantity_value:Infinity},{quantity_value:'20'},{quantity_value:71},
 {quantity_value:20,quantity_text:'some'},{quantity_value:20,show_quantity:false},
 {quantity_text:'x'.repeat(501)},{quantity_unit:'g'},
]) {
 assert.equal(validateRecipeChanges({...validSource,steps:[{client_key:'s',text:'Use',ingredients:[{ingredient_client_key:'fat',...link}]}]},true),null,JSON.stringify(link));
}
assert.ok(validateRecipeChanges({...validSource,steps:[{client_key:'s',text:'Use',ingredients:[{ingredient_client_key:'fat',quantity_value:70}]}]},true),'full source quantity is a valid override');
