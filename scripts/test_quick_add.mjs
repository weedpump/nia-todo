import assert from 'node:assert/strict';
const api = await import('../web/static/js/features/quick-add.js').catch(() => ({}));
assert.equal(typeof api.getQuickAddAliases, 'function', 'shared aliases API exists');
assert.deepEqual(api.getQuickAddAliases(k => k === 'a' ? ' Foo | BAR ||' : k, 'a'), ['foo','bar']);
assert.deepEqual(api.getQuickAddAliases(k => k, 'missing'), []);
assert.equal(typeof api.resolveQuickAddNamedEntity, 'function');
assert.equal(api.normalizeQuickAddName(' COLD_goods--Shelf '), 'cold goods shelf');
assert.equal(new RegExp(`^${api.escapeQuickAddRegExp('A+[B](x).*$')} $`).test('A+[B](x).*$ '), true);
const entity = {id:'opaque',name:'Cold Goods'};
assert.deepEqual(api.resolveQuickAddNamedEntity('cold_goods', [entity]), {entity,ambiguous:false});
assert.deepEqual(api.resolveQuickAddNamedEntity('coldgoods', [entity]), {entity,ambiguous:false});
assert.deepEqual(api.resolveQuickAddNamedEntity('coldgoods', [entity,{id:2,name:'Cold-Goods'}]), {entity:null,ambiguous:true});
assert.deepEqual(api.resolveQuickAddNamedEntity('missing', [entity]), {entity:null,ambiguous:false});
// Minimal DOM preserves text-only rendering and owner-document use.
class Element {
  constructor(ownerDocument, tagName = 'div') { this.ownerDocument=ownerDocument; this.tagName=tagName; this.children=[]; this.hidden=true; this.className=''; this._text=''; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text=String(value); this.children=[]; }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this._text=''; this.children=children; }
}
const doc={createElement: tag => new Element(doc, tag)};
const target=new Element(doc);
assert.equal(typeof api.renderQuickAddPreview, 'function');
api.renderQuickAddPreview(target,{matches:[{type:'store',label:'Store',value:'<img onerror=x>',token:'@x'}],errors:['err'],warnings:['warn']},k=>`translated:${k}`);
assert.equal(target.hidden,false);
assert.equal(target.children[0].children[0]?.className, 'quick-add-chip-label', 'shared preview preserves the canonical label element');
assert.equal(target.children[0].children[1]?.tagName, 'strong', 'shared preview preserves canonical emphasized values');
assert.ok(target.children.some(n=>n.className.split(' ').includes('store')));
assert.ok(target.children.every(n=>n.className.split(' ').includes('quick-add-chip')));
assert.ok(target.children.some(n=>n.textContent.includes('<img onerror=x>')));
assert.ok(target.children.some(n=>n.textContent.includes('translated:err')));
assert.ok(target.children.some(n=>n.textContent.includes('translated:warn')));
api.renderQuickAddPreview(target,{matches:[]});
assert.equal(target.hidden,true);
assert.equal(target.children.length,0);
class Input extends EventTarget { value='one'; }
const input=new Input();
const rendered=[]; let context='a'; let active=true;
assert.equal(typeof api.createQuickAddPreviewController,'function');
const controller=api.createQuickAddPreviewController({input,getContext:()=>context,parse:(value,ctx)=>({title:value+ctx}),render:r=>rendered.push(r),isActive:()=>active});
assert.deepEqual(await controller.refresh(),{title:'onea'});
input.value='two'; input.dispatchEvent(new Event('input')); await Promise.resolve(); await Promise.resolve();
assert.equal(rendered.at(-1).title,'twoa');
active=false; assert.equal(await controller.refresh(),null);
controller.destroy(); active=true;
input.dispatchEvent(new Event('input')); await Promise.resolve();
assert.equal(rendered.length,2);
assert.equal(await controller.refresh(),null);
const pending=[]; const safeRendered=[]; const failures=[];
const safe=api.createQuickAddPreviewController({input,getContext:()=>context,isActive:()=>active,parse:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),render:r=>safeRendered.push(r),onError:e=>failures.push(e.message)});
let first=safe.refresh(); let second=safe.refresh();
pending[1].resolve('new'); assert.equal(await second,'new');
pending[0].resolve('old'); assert.equal(await first,null);
first=safe.refresh(); safe.invalidate(); pending[2].resolve('invalid'); assert.equal(await first,null);
first=safe.refresh(); context='other'; pending[3].resolve('context'); assert.equal(await first,null);
first=safe.refresh(); input.value='changed'; pending[4].resolve('input'); assert.equal(await first,null);
first=safe.refresh(); active=false; pending[5].resolve('closed'); assert.equal(await first,null); active=true;
first=safe.refresh(); pending[6].reject(new Error('parse failure')); assert.equal(await first,null); assert.deepEqual(failures,['parse failure']);
assert.deepEqual(safeRendered,['new']);
safe.destroy();
const { parseShoppingQuickAdd } = await import('../web/static/js/features/shopping-quick-add.js');
const compositionInput = new Input();
compositionInput.value = '500g ';
let compositionPreview;
const ime = api.createQuickAddPreviewController({
  input: compositionInput,
  parse: raw => parseShoppingQuickAdd(raw, {
    list: { id: 'shopping-list', sections: [] },
    locale: 'de',
    t: key => key === 'shopping.quickAdd.syntax.unitAliases' ? 'g' : key,
  }),
  render: result => { compositionPreview = result; },
});
await ime.refresh();
assert.deepEqual(compositionPreview.errors, ['shopping.quickAdd.error.missingName']);
compositionInput.dispatchEvent(new Event('compositionstart'));
compositionInput.value = '500g emmenta';
compositionInput.selectionStart = compositionInput.selectionEnd = compositionInput.value.length;
const composingInput = new Event('input');
Object.defineProperty(composingInput, 'isComposing', { value: true });
compositionInput.dispatchEvent(composingInput);
await Promise.resolve(); await Promise.resolve();
assert.equal(compositionPreview.title, 'emmenta', 'mobile word composition must update the preview without a trailing space');
assert.deepEqual(compositionPreview.errors, [], 'a composing article name must replace the obsolete missing-name error');
assert.deepEqual(compositionPreview.changes, { quantity_value: 500, quantity_unit: 'g' });
assert.equal(compositionInput.value, '500g emmenta', 'preview must not rewrite or confirm the composing input');
assert.equal(compositionInput.selectionStart, compositionInput.value.length);
assert.equal(compositionInput.selectionEnd, compositionInput.value.length);
assert.equal((await ime.refresh()).title, 'emmenta', 'context refreshes remain valid during composition');
compositionInput.value += ' ';
compositionInput.dispatchEvent(new Event('compositionend'));
await Promise.resolve(); await Promise.resolve();
assert.deepEqual(compositionPreview.changes, { quantity_value: 500, quantity_unit: 'g' }, 'confirming a word preserves the same parse');
ime.destroy();
compositionInput.value = 'other';
compositionInput.dispatchEvent(new Event('compositionend'));
assert.equal(compositionPreview.title, 'emmenta', 'destroyed previews ignore later composition events');
const thrown=api.createQuickAddPreviewController({input,parse:()=>{throw Error('sync');},render:()=>{},onError:()=>{throw Error('handler');}});
assert.equal(await thrown.refresh(),null); thrown.destroy();
const objectContext={listId:'local',language:'de'};
let settleContext;
const objectController=api.createQuickAddPreviewController({input,getContext:()=>({...objectContext}),parse:(_value,ctx)=>new Promise(resolve=>{assert.equal(ctx.listId,objectContext.listId);settleContext=resolve;}),render:()=>{}});
first=objectController.refresh(); settleContext('stable'); assert.equal(await first,'stable');
first=objectController.refresh(); objectContext.listId='server'; settleContext('stale'); assert.equal(await first,null);
objectController.destroy();
const callbackErrors=[];
const brokenContext=api.createQuickAddPreviewController({input,getContext:()=>{throw Error('context');},parse:()=>({}),render:()=>{},onError:async error=>{callbackErrors.push(error.message);throw Error('ignored callback');}});
assert.equal(await brokenContext.refresh(),null); assert.deepEqual(callbackErrors,['context']); brokenContext.destroy();
const brokenRender=api.createQuickAddPreviewController({input,parse:()=>({}),render:async()=>{throw Error('render');}});
assert.equal(await brokenRender.refresh(),null); brokenRender.destroy();
console.log('quick-add tests passed');
