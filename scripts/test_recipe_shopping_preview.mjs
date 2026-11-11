#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildRecipeShoppingPreview } from '../web/static/js/features/recipe-shopping-preview.js';
import { formatQuantity } from '../web/static/js/core/recipe-quantities.js';

const ingredient=(key,quantity,unit='g',note='',name='Mehl')=>({client_key:key,name,quantity_value:quantity,quantity_unit:unit,note});
const recipe=rows=>({base_servings:2,ingredient_groups:rows.map((row,index)=>({client_key:`group-${index}`,ingredients:[row]})),steps:[{ingredients:[{ingredient_client_key:rows[0]?.client_key,quantity_value:9999}]}]});
const selections=rows=>rows.map(row=>({ingredient_client_key:row.client_key,section_id:100,store_ids:[7]}));
const preview=(rows,options={},targets=selections(rows))=>buildRecipeShoppingPreview(recipe(rows),targets,options);
const format=group=>formatQuantity(group.amount,group.unit,'de',{kitchen:true});
let rows=[ingredient('a',250),ingredient('b',100)];
let result=preview(rows);assert.equal(result.families.length,1);assert.equal(result.families[0].groups.length,1);
assert.equal(format(result.families[0].groups[0]),'350 g');assert.deepEqual(result.families[0].groups[0].sourceKeys,['a','b']);
assert.equal(result.mergeGroups.size,0,'identical notes retain existing automatic backend merging');
assert.equal(format(preview(rows,{servings:4}).families[0].groups[0]),'700 g');
rows=[ingredient('a',.25,'kg'),ingredient('b',100,'grams')];result=preview(rows);
assert.equal(result.families[0].groups[0].amount,.35);assert.equal(format(result.families[0].groups[0]),'350 g');
rows=[ingredient('a',.1,'Custom measure'),ingredient('b',.2,'Custom measure')];
assert.equal(preview(rows).families[0].groups[0].amount,.3,'decimal source values are summed before floating-point display');
rows=[ingredient('a',250,'g','für den Teig'),ingredient('b',100,'g','für die Arbeitsfläche')];
result=preview(rows);const id=result.families[0].id;
assert.equal(result.families[0].canCombine,true);assert.equal(result.families[0].groups.length,1,'different notes combine by default');
assert.equal(format(result.families[0].groups[0]),'350 g');
assert.deepEqual(result.families[0].groups[0].notes,['für den Teig','für die Arbeitsfläche']);assert.equal(new Set(result.mergeGroups.values()).size,1);assert.equal(result.mergeGroups.size,2);
const remapped=preview(rows,{},selections(rows).map(row=>({...row,section_id:999,store_ids:[77]})));
assert.equal(remapped.families[0].combined,true,'default combination survives a canonical target identity receipt');
assert.deepEqual(remapped.families[0].groups[0].storeIds,[77]);
result=preview(rows,{separated:new Set([id])});
assert.equal(result.families[0].groups.length,2,'explicit separation restores both source notes');assert.equal(result.mergeGroups.size,0);
assert.equal(preview(rows,{separated:new Set([id])},selections(rows).map(row=>({...row,section_id:999,store_ids:[77]}))).families[0].groups.length,2,'explicit separation follows source identity across canonical target IDs');
const three=[...rows,ingredient('c',50,'g','zum Bestäuben')],threeId=preview(three).families[0].id;
result=preview(three,{separated:new Set([threeId])},selections(three).slice(1));
assert.equal(result.families[0].groups.length,2,'separation also applies to a selected subset of the original family');assert.equal(result.mergeGroups.size,0);
for(const units of [['g','ml'],['pack','piece'],['tsp','tbsp'],['ML','ml'],['My unit','my unit']]){
  result=preview([ingredient('a',1,units[0]),ingredient('b',1,units[1])]);assert.equal(result.families.length,2,JSON.stringify(units));
}
rows=[ingredient('a',250),ingredient('b',100)];
for(const targets of [[{...selections(rows)[0],section_id:101},selections(rows)[1]],[{...selections(rows)[0],store_ids:[8]},selections(rows)[1]]])assert.equal(preview(rows,{},targets).families.length,2,'different target boundaries stay separate');
assert.equal(preview(rows,{},selections(rows).slice(1)).families[0].groups[0].amount,100,'unselected source rows do not contribute');
assert.equal(preview([ingredient('a',null),ingredient('b',null)]).families.length,2,'unmeasured items remain separate');
rows=[{...ingredient('a',null),quantity_text:'nach Bedarf'},{...ingredient('b',null),quantity_text:'nach Bedarf'}];
assert.equal(preview(rows).families.length,2,'free amounts do not become additive');
const original=structuredClone(rows);preview(rows);assert.deepEqual(rows,original,'preview never edits source/provenance');
assert.equal(preview([],{}).families.length,0);
console.log('PASS selected recipe source consolidation, exact compatible sums, explicit notes, routes and units');
