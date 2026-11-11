#!/usr/bin/env node
// Immutable prepared-model regressions. Pure Node/Python only; no DB or service.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createPreparedRoutingMatcher,suggestRoutingRoute,suggestTaskRoutingRoute,matchRoutingField} from '../web/static/js/features/routing-memory-matcher.js';
import {routingMemoryRules as rules} from '../web/static/js/core/routing-memory-rule-data.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const fixtures=['routing_memory_matching.json','routing_memory_base_recognition.json'].map(name=>JSON.parse(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8')));
const vectors=fixtures.flatMap(fixture=>fixture.vectors.map(vector=>({...vector,entries:structuredClone(vector.entries || fixture.catalogs?.[vector.catalog])})));
const fieldRows=vector=>vector.module!=='tasks'?vector.entries:vector.entries.filter(row=>row.project_id!=null&&((row.workspace_id==null&&vector.workspace_id==null)
  ||row.workspace_id!=null&&vector.workspace_id!=null&&String(row.workspace_id)===String(vector.workspace_id))).map(row=>({...row,shopping_list_id:row.project_id,list_known:Boolean(row.list_known??row.project_known??row.preferred)}));
const canonical=(value)=>JSON.parse(JSON.stringify(value));
const python=process.env.NIA_TODO_TEST_PYTHON || (existsSync(join(root,'.venv/bin/python'))?join(root,'.venv/bin/python'):'python3');
const pythonCode=`import copy,json,sys,time
import services.routing_matcher as m
vectors=json.load(sys.stdin)
results=[]
for v in vectors:
 p=m.prepare_route_matcher(v['entries'])
 route=p.suggest_task(v['name'],v.get('workspace_id'),v.get('project_id')) if v.get('module')=='tasks' else p.suggest(v['name'],v.get('list_id'))
 entries=v['entries']
 if v.get('module')=='tasks':
  entries=[dict(e,shopping_list_id=e['project_id'],list_known=bool(e.get('list_known',e.get('project_known',e.get('preferred',False))))) for e in entries if e.get('project_id') is not None and ((e.get('workspace_id') is None and v.get('workspace_id') is None) or(e.get('workspace_id') is not None and v.get('workspace_id') is not None and str(e['workspace_id'])==str(v['workspace_id'])))]
 f=m.prepare_route_matcher(entries)
 results.append(dict(route=route,fields={field:f.match_field(v['name'],field,v.get('project_id') if v.get('module')=='tasks' else v.get('list_id')) for field in ['list','section','stores']}))
seed=[dict(name_key='margerine',key_kind='exact',shopping_list_id=10,list_known=True,preferred=True,section_known=True,section_id=20,stores_known=True,store_ids=[30,31],history_fields=['list','section','stores'])]
p=m.prepare_route_matcher(seed)
expected=p.suggest('Margarine',10)
returned=p.suggest('Margarine',10); returned['store_ids'].append(999); returned['memory_fields'].clear()
p.match_field('Margarine','stores',10)['value'].append(998)
assert p.suggest('Margarine',10)==expected
seed[0]['evidence']={'section':{'reliable':False}}
assert p.suggest('Margarine',10)==expected
assert not m.suggest_route(seed,'Margarine',10)['section_known']
old=m.RULES['min_typo_word_characters']
try:
 m.RULES['min_typo_word_characters']=10
 assert p.suggest('Margarine',10) is None
finally: m.RULES['min_typo_word_characters']=old
assert p.suggest('Margarine',10)==expected
rows=[dict(name_key=f'persönliche aufgabe nummer {i} regelmäßig erledigen',key_kind='exact',shopping_list_id=10,list_known=True,preferred=True,section_known=True,section_id=20,stores_known=True,store_ids=[30],history_fields=['list','section','stores']) for i in range(2000)]
names=['Wasser','Salz','Zucker','Margarine','Weizenmehl','Zimt','Zitrone','Äpfel','Rosinen','Puderzucker','Semmelbrösel','Pflanzenöl','Vanille','Backpulver','Hafermilch','Walnüsse','Sahne','Hefe','Kakao','Mandeln']
source=m._token_spans; calls=[0]
def counted(value):
 calls[0]+=1
 return source(value)
m._token_spans=counted
start=time.perf_counter();p=m.prepare_route_matcher(rows)
for name in names: assert p.suggest(name,10) is None
elapsed=(time.perf_counter()-start)*1000
m._token_spans=source
assert calls[0]<len(rows)*3, 'stable model must not tokenize every source again for every recipe ingredient'
print(json.dumps(dict(results=results,source_tokenizations=calls[0],prepared_ms=round(elapsed)),ensure_ascii=False))`;
const backend=JSON.parse(execFileSync(python,['-c',pythonCode],{cwd:join(root,'api'),env:{...process.env,PYTHONPATH:join(root,'api')},input:JSON.stringify(vectors),encoding:'utf8',maxBuffer:16*1024*1024}));
for(const [index,vector] of vectors.entries()){
 const p=createPreparedRoutingMatcher(vector.entries), f=createPreparedRoutingMatcher(fieldRows(vector));
 const route=vector.module==='tasks'?p.suggestTask(vector.name,vector.workspace_id,vector.project_id):p.suggest(vector.name,vector.list_id);
 const raw=vector.module==='tasks'?suggestTaskRoutingRoute(vector.entries,vector.name,vector.workspace_id,vector.project_id):suggestRoutingRoute(vector.entries,vector.name,vector.list_id);
 assert.deepEqual(canonical(route),canonical(raw),`${vector.id}: preparation must not change route semantics`);
 assert.deepEqual(canonical(route),canonical(backend.results[index].route),`${vector.id}: prepared route JS/Python parity`);
 for(const field of ['list','section','stores']){
  const container=vector.module==='tasks'?vector.project_id:vector.list_id;
  const decision=f.matchField(vector.name,field,container);
  assert.deepEqual(decision,matchRoutingField(fieldRows(vector),vector.name,field,container),`${vector.id}/${field}: field semantics`);
  assert.deepEqual(decision,backend.results[index].fields[field],`${vector.id}/${field}: prepared field/source/score parity`);
 }
}
const seed=[{name_key:'margerine',key_kind:'exact',shopping_list_id:10,list_known:true,preferred:true,section_known:true,section_id:20,stores_known:true,store_ids:[30,31],history_fields:['list','section','stores']}];
const prepared=createPreparedRoutingMatcher(seed), expected=prepared.suggest('Margarine',10);
const returned=prepared.suggest('Margarine',10);returned.store_ids.push(999);returned.memory_fields.length=0;
prepared.matchField('Margarine','stores',10).value.push(998);
assert.deepEqual(prepared.suggest('Margarine',10),expected,'consumers cannot mutate stored results/corpus');
seed[0].evidence={section:{reliable:false}};
assert.deepEqual(prepared.suggest('Margarine',10),expected,'prepared matcher owns its immutable input snapshot');
assert.equal(suggestRoutingRoute(seed,'Margarine',10).section_known,false,'raw API remains sensitive to caller mutations');
const old=rules.min_typo_word_characters;
try{rules.min_typo_word_characters=10;assert.equal(prepared.suggest('Margarine',10),null,'numeric policy changes invalidate analysis');}
finally{rules.min_typo_word_characters=old;}
assert.deepEqual(prepared.suggest('Margarine',10),expected,'restoring numeric policy rebuilds the prepared model');
const rows=Array.from({length:2000},(_,i)=>({name_key:`persönliche aufgabe nummer ${i} regelmäßig erledigen`,key_kind:'exact',shopping_list_id:10,list_known:true,preferred:true,section_known:true,section_id:20,stores_known:true,store_ids:[30],history_fields:['list','section','stores']}));
const names=['Wasser','Salz','Zucker','Margarine','Weizenmehl','Zimt','Zitrone','Äpfel','Rosinen','Puderzucker','Semmelbrösel','Pflanzenöl','Vanille','Backpulver','Hafermilch','Walnüsse','Sahne','Hefe','Kakao','Mandeln'];
const start=performance.now(), large=createPreparedRoutingMatcher(rows);
for(const name of names)assert.equal(large.suggest(name,10),null);
console.log(`PASS ${vectors.length} prepared/raw/JS/Python routes and fields, immutable ownership, policy invalidation and bounded source analysis`);
console.log(`Prepared 2000-name model / 20 distinct ingredients: JS ${Math.round(performance.now()-start)}ms, Python ${backend.prepared_ms}ms (${backend.source_tokenizations} source/query tokenizations); timings are diagnostic, not pass thresholds`);
