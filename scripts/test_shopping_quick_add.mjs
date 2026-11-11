import { normalizeQuantityUnit, getQuantityUnitAliases } from '../web/static/js/core/quantity-units.js';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const {parseShoppingQuickAdd:parse} = await import('../web/static/js/features/shopping-quick-add.js').catch(()=>({}));
assert.equal(typeof parse,'function','shopping parser API exists');
const dictionary={
 'shopping.quickAdd.syntax.quantityPrefixes':'quantity|qty|menge',
 'shopping.quickAdd.syntax.unitPrefixes':'unit|einheit',
 'shopping.quickAdd.syntax.storePrefixes':'store|supermarkt',
 'quickAdd.syntax.sectionPrefixes':'section|abschnitt',
};
const t=k=>dictionary[k] || k;
const list={id:'list-a',sections:[{id:'section-local',name:'Kühlung'}]};
const stores=[{id:'store-local',name:'REWE',shopping_list_id:'list-a'}];
const options={list,stores,t,locale:'de'};
for (const title of ['Milch','7 Up','morgen !hoch #Projekt','Käse mengeprodukt:2']) {
 assert.deepEqual(parse(title,options),{title,changes:{},matches:[],errors:[],warnings:[]});
}
assert.equal(parse('"2 l Milch @REWE"',options).title,'2 l Milch @REWE');
assert.deepEqual(parse('"2 l Milch @REWE"',options).changes,{});
for (const [raw,title,changes] of [
 ['2 l Milch','Milch',{quantity_value:2,quantity_unit:'l'}],
 ['500g Nudeln','Nudeln',{quantity_value:500,quantity_unit:'g'}],
 ['3x Äpfel','Äpfel',{quantity_value:3}],
 ['0 kg Salz','Salz',{quantity_value:0,quantity_unit:'kg'}],
 ['1,5 l Milch','Milch',{quantity_value:1.5,quantity_unit:'l'}],
 ['1.5 l Milch','Milch',{quantity_value:1.5,quantity_unit:'l'}],
]) { const result=parse(raw,options); assert.equal(result.title,title); assert.deepEqual(result.changes,changes); }
for (const raw of ['2 Tomaten','500gb Nudeln','2 l','2x','1,000.5 l Milch','-2 l Milch']) assert.deepEqual(parse(raw,options).changes,{});
assert.deepEqual(parse('1,5 l Milch',{...options,locale:'en'}).changes,{});
let combined=parse('2 l Milch @REWE /Kühlung',options);
assert.equal(combined.title,'Milch');
assert.deepEqual(combined.changes,{quantity_value:2,quantity_unit:'l',store_ids:['store-local'],section_id:'section-local'});
assert.deepEqual(combined.matches.map(m=>m.type),['quantity','unit','store','section']);
const multi={...options,list:{...list,sections:[{id:'cold',name:'Cold'},{id:'long',name:'Cold Goods'},{id:'regex',name:'A+[B](x).*$'}]},stores:[...stores,{id:'multi',name:'Whole Foods',shopping_list_id:'list-a'}]};
for (const token of ['/Cold Goods','§Cold Goods','section:Cold Goods','section:"Cold Goods"','/coldgoods','/cold_goods']) {
 const result=parse(`Milk ${token}`,multi); assert.equal(result.title,'Milk',token); assert.equal(result.changes.section_id,'long',token);
}
assert.equal(parse('Milk /A+[B](x).*$',multi).changes.section_id,'regex');
assert.equal(parse('Milk @"Whole Foods"',multi).changes.store_ids[0],'multi');
assert.equal(parse('Milk @Whole Foods',multi).title,'Milk');
for (const token of ['@REWExtra','/Unknown','/ColdGoodsExtra']) {
 const result=parse(`Milk ${token}`,multi); assert.equal(result.title,`Milk ${token}`); assert.deepEqual(result.warnings,['shopping.quickAdd.warning.unrecognized']);
}
const scoped={...options,stores:[...stores,{id:'off',name:'Off',shopping_list_id:'list-a',active:false},{id:'foreign',name:'Foreign',shopping_list_id:'list-b'}]};
for(const token of ['@Off','@Foreign']) assert.deepEqual(parse(`Milk ${token}`,scoped).changes,{});
combined=parse('Milch menge:2 einheit:Packungen supermarkt:REWE abschnitt:Kühlung',options);
assert.equal(combined.title,'Milch'); assert.deepEqual(combined.changes,{quantity_value:2,quantity_unit:'pack',store_ids:['store-local'],section_id:'section-local'});
assert.equal(parse('Milk qty: 0 unit: "free unit"',options).changes.quantity_value,0);
assert.equal(parse('Milk qty: 0 unit: "free unit"',options).changes.quantity_unit,'free unit');
for (const value of ['-2','Infinity','NaN','1e309','2,000.5','1,5,4','oops']) {
 const result=parse(`Milk quantity:${value}`,options); assert.deepEqual(result.errors,['shopping.quickAdd.error.invalidQuantity'],value); assert.equal(result.title,`Milk quantity:${value}`); assert.deepEqual(result.changes,{});
}
assert.equal(parse('Milk quantity:1,5',options).changes.quantity_value,1.5);
assert.deepEqual(parse('Milk quantity:1,5',{...options,locale:'en'}).errors,['shopping.quickAdd.error.invalidQuantity']);
for (const raw of ['Milk quantity:2 qty:3','2 l Milk qty:3','Milk unit:g unit:kg','Milk /Cold /Cold Goods','Milk @REWE @Whole Foods']) {
 const result=parse(raw,multi); assert.ok(result.errors.includes('shopping.quickAdd.error.conflict'),raw);
}
for (const raw of ['Milk qty:2 qty:2','Milk @REWE @REWE']) assert.deepEqual(parse(raw,options).errors,[]);
const ambiguous={...options,list:{...list,sections:[{id:1,name:'Cold Goods'},{id:2,name:'Cold-Goods'}]},stores:[...stores,{id:'duplicate',name:'rewe',shopping_list_id:'list-a'}]};
for(const token of ['/coldgoods','@REWE']) {
 const result=parse(`Milk ${token}`,ambiguous); assert.deepEqual(result.errors,['shopping.quickAdd.error.ambiguous']); assert.equal(result.title,`Milk ${token}`); assert.deepEqual(result.changes,{});
}
for(const raw of ['qty:2','@REWE','2 l @REWE','unit:g']) assert.ok(parse(raw,options).errors.includes('shopping.quickAdd.error.missingName'),raw);
for (const raw of ['Milk "literal @REWE inside" bread', 'Milk unit:"@REWE package"']) {
 const result=parse(raw,options); assert.equal(result.changes.store_ids,undefined,raw);
}
assert.equal(parse('"Milk" @REWE "bread"',options).title,'"Milk" "bread"');
assert.equal(parse('Milk  fresh   @REWE',options).title,'Milk  fresh');
assert.equal(parse('Milk  fresh   untouched',options).title,'Milk  fresh   untouched');
const apostropheOptions = {
  ...options,
  list: { ...list, sections: [{ id: 'favorites', name: "Tobi's Favoriten" }] },
  stores: [...stores, { id: 'trader', shopping_list_id: list.id, name: "Trader Joe's" }],
};
for (const [raw, title, changes] of [
  [`Ben & Jerry's Eis @"Trader Joe's"`, "Ben & Jerry's Eis", { store_ids: ['trader'] }],
  [`Ben & Jerry's Eis @REWE /Tobi's Favoriten`, "Ben & Jerry's Eis", { store_ids: ['store-local'], section_id: 'favorites' }],
  [`Ben & Jerry's Eis @Trader Joe's`, "Ben & Jerry's Eis", { store_ids: ['trader'] }],
  [`Ben & Jerry's Eis @'Trader Joe\'s'`, "Ben & Jerry's Eis", { store_ids: ['trader'] }],
  [`Eis 'don't parse @REWE inside' /Tobi's Favoriten`, "Eis 'don't parse @REWE inside'", { section_id: 'favorites' }],
  [`Eis "literal @REWE inside" /Tobi's Favoriten`, 'Eis "literal @REWE inside"', { section_id: 'favorites' }],
]) {
  const actual = parse(raw, apostropheOptions);
  assert.equal(actual.title, title, raw);
  assert.deepEqual(actual.changes, changes, raw);
  assert.deepEqual(actual.errors, [], raw);
  assert.deepEqual(actual.warnings, [], raw);
}
const oversized='Milk '.repeat(110)+'@REWE'; assert.deepEqual(parse(oversized,options).changes,{});
for (const raw of ['2 l','2x','3 x']) {
 const result=parse(raw,options); assert.deepEqual(result.errors,['shopping.quickAdd.error.missingName'],raw); assert.equal(result.title,raw);
}
const missingUnit=parse('Milk unit: @REWE',options);
assert.equal(missingUnit.changes.quantity_unit,undefined);
assert.deepEqual(missingUnit.changes.store_ids,['store-local']);
assert.equal(missingUnit.title,'Milk unit:');
assert.deepEqual(missingUnit.warnings,['shopping.quickAdd.warning.unrecognized']);
const missingQuantity=parse('Milk qty: @REWE',options);
assert.deepEqual(missingQuantity.errors,['shopping.quickAdd.error.invalidQuantity']);
assert.deepEqual(missingQuantity.changes.store_ids,['store-local']);
const localeFiles=(await readdir(new URL('../web/static/i18n/',import.meta.url))).filter(name=>name.endsWith('.json'));
for(const filename of localeFiles) {
 const locale=filename.slice(0,-5);
 const real=JSON.parse(await readFile(new URL(`../web/static/i18n/${filename}`,import.meta.url),'utf8'));
 const translate=k=>real[k] || k;
 const first=key=>real[key].split('|')[0];
 const localOptions={...options,locale,t:translate};
 const unit='Liter';
 const quantityPrefix=first('shopping.quickAdd.syntax.quantityPrefixes');
 const unitPrefix=first('shopping.quickAdd.syntax.unitPrefixes');
 const storePrefix=first('shopping.quickAdd.syntax.storePrefixes');
 const sectionPrefix=first('quickAdd.syntax.sectionPrefixes');
 const result=parse(`Product ${quantityPrefix}:1.5 ${unitPrefix}:${unit} ${storePrefix}:REWE ${sectionPrefix}:Kühlung`,localOptions);
 assert.equal(result.title,'Product',locale); assert.deepEqual(result.errors,[],locale);
 assert.deepEqual(result.changes,{quantity_value:1.5,quantity_unit:'l',store_ids:['store-local'],section_id:'section-local'},locale);
 assert.deepEqual(result.matches.map(match=>match.label),[real['common.quantity'],real['common.unit'],real['shopping.item.store'],real['common.section']],locale);
 const comma=new Intl.NumberFormat(locale).formatToParts(1.1).some(part=>part.type==='decimal'&&part.value===',');
 assert.equal(parse(`1,5 ${unit} Product`,localOptions).changes.quantity_value,comma?1.5:undefined,locale);
 assert.equal(parse(`1.5 ${unit} Product`,localOptions).changes.quantity_value,1.5,locale);
}
const remapped={...options,list:{...list,id:'server-list',client_mutation_id:'list-a'},stores:options.stores.map(store=>({...store,shopping_list_id:'server-list'}))};
assert.deepEqual(parse('Milk @REWE',remapped).changes.store_ids,['store-local']);
assert.equal(parse('Milk /Kühlung',{...options,list:{id:'different',sections:[]}}).changes.section_id,undefined);
for(const hostile of ['[a]+(x).*','a|b','a'.repeat(400)]) {
 const hostileOptions={...options,list:{...list,sections:[{id:'safe',name:hostile}]}};
 assert.equal(parse(`Milk /${hostile}`,hostileOptions).changes.section_id,'safe');
}
console.log(`shopping quick-add tests passed (${localeFiles.length} real locales)`);

// Every supported spelling is recognized independently of the active UI locale.
for (const alias of getQuantityUnitAliases()) {
 if (alias.toLowerCase() === 'x') continue; // Existing multiplier syntax has no unit.
 const parsed = parse(`2 ${alias} Product`, { ...options, locale: 'en' });
 assert.equal(parsed.title, 'Product', alias);
 assert.deepEqual(parsed.changes, { quantity_value: 2, quantity_unit: normalizeQuantityUnit(alias) }, alias);
}
for (const unit of ['ML', 'Mg', 'Lita', 'Hansdampf']) {
 const title = `2 ${unit} Product`;
 assert.equal(parse(title, options).title, title, unit);
 assert.deepEqual(parse(title, options).changes, {}, unit);
 assert.equal(parse(`Product unit:${unit}`, options).changes.quantity_unit, unit, unit);
}
assert.deepEqual(parse('2 kg. Mehl', options).changes, { quantity_value: 2, quantity_unit: 'kg' });
assert.deepEqual(parse('2 LITER. Milch', options).changes, { quantity_value: 2, quantity_unit: 'l' });
assert.deepEqual(parse('Milk unit:Liter unit:l', options).errors, [], 'equivalent aliases do not conflict');
