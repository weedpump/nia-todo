#!/usr/bin/env node
// Pure matching/cache regressions: no browser, database, service or credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suggestTaskRoutingRoute, suggestRoutingRoute, routingTokens, mergeRoutingFeedback } from '../web/static/js/features/routing-memory-matcher.js';

let cases = 0;
const check = async (name, run) => {
  try { await run(); cases++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
};
const task = (name, projectId = 10, sectionId = 20, changes = {}) => ({
  module_id: 'tasks', name_key: name, key_kind: 'exact', workspace_id: 9,
  project_id: projectId, project_known: true, list_known: true, preferred: true,
  section_id: sectionId, section_known: true, history_fields: ['list', 'section'],
  ...changes,
});
const token = (name, projectId = 10, sectionId = 20, score = 5, changes = {}) => task(name, projectId, sectionId, {
  key_kind: 'token', evidence: {
    list: { target_score: score, target_support: Math.max(1, Math.floor(score)), reliable: true },
    section: { support: 1, reliable: true },
  }, ...changes,
});

await check('exact task identities and explicit empty sections', () => {
  const route = suggestTaskRoutingRoute([task('wäsche waschen')], ' WÄSCHE  WASCHEN ', 9);
  assert.equal(route.project_id, 10);
  assert.equal(route.section_id, 20);
  assert.deepEqual(route.memory_fields, ['list', 'section']);
  assert.equal(route.match_kind, 'exact');
  assert.equal('shopping_list_id' in route, false);
  assert.equal('store_ids' in route, false);
  const empty = suggestTaskRoutingRoute([task('wäsche waschen', 10, null)], 'Wäsche waschen', 9);
  assert.equal(empty.section_known, true);
  assert.equal(empty.section_id, null);
});

await check('workspace boundaries and fixed project', () => {
  const rows = [task('wäsche waschen'), task('wäsche waschen', 11, 21, { workspace_id: 8 })];
  assert.equal(suggestTaskRoutingRoute(rows, 'Wäsche waschen', 8).project_id, 11);
  assert.equal(suggestTaskRoutingRoute(rows, 'Wäsche waschen', 7), null);
  assert.equal(suggestTaskRoutingRoute(rows, 'Wäsche waschen'), null);
  assert.equal(suggestTaskRoutingRoute(rows, 'Wäsche waschen', 9, 11), null);
  const route = suggestTaskRoutingRoute([task('wäsche waschen', 10, 20, { preferred: false, list_known: false, project_known: false, history_fields: ['section'] })], 'Wäsche waschen', 9, 10);
  assert.equal(route.project_id, 10);
  assert.deepEqual(route.memory_fields, ['section'], 'an explicit project is never mislabeled as remembered');
});

await check('all modules preserve wording without aliases, short-word correction or compound splitting', () => {
  assert.equal(suggestTaskRoutingRoute([task('butter')], 'beurre', 9), null);
  assert.equal(suggestTaskRoutingRoute([task('tomaten')], 'tomatoes', 9), null);
  assert.equal(suggestTaskRoutingRoute([task('wäsche waschen')], 'Wäschewaschen', 9), null);
  assert.equal(suggestTaskRoutingRoute([task('wäsche waschen')], 'Wäsche wascen', 9), null);
  assert.equal(suggestRoutingRoute([{name_key:'butter', shopping_list_id:10, list_known:true, preferred:true, section_known:true, section_id:20}], 'beurre'), null);
});

await check('imported tokens share ordinary whole-word inference', () => {
  assert.deepEqual(routingTokens('Bitte Wäsche waschen und Wäsche 123'), ['bitte','wäsche','waschen','und','wäsche','123']);
  const route = suggestTaskRoutingRoute([token('wäsche')], 'Wäsche waschen', 9);
  assert.equal(route.project_id, 10);
  assert.equal(route.section_id, 20);
  assert.equal(route.match_kind, 'phrase');
  assert.equal(suggestTaskRoutingRoute([token('wäsche')], 'Wäschekorb kaufen', 9), null);
});

await check('distinct personal names decide route consistency, never raw legacy hit counts', () => {
  const rows = [token('wäsche', 10, 20, 1000), token('waschen', 11, 21, 1)];
  assert.equal(suggestTaskRoutingRoute(rows, 'Wäsche waschen', 9), null, 'disjoint learned words disagree even with unequal historical hit counts');
  const selected = suggestTaskRoutingRoute(rows, 'Wäsche waschen', 9, 11);
  assert.equal(selected.section_id, 21);
  assert.deepEqual(selected.memory_fields, ['section']);
  const contrast = [task('wäsche waschen'),task('auto waschen',11,21)];
  assert.equal(suggestTaskRoutingRoute(contrast,'Wäsche machen',9).project_id,10);
  assert.equal(suggestTaskRoutingRoute(contrast,'Wäsche machen',9).section_known,false,'child inference uses only the chosen project corpus');
  assert.equal(suggestTaskRoutingRoute([task('wäsche waschen')],'Wäsche machen',9),null,'one name cannot distinguish noun from action');
  assert.equal(suggestTaskRoutingRoute([task('wäsche waschen')],'Auto waschen',9),null,'the symmetric unknown object must also abstain');
});

await check('explicit full-name corrections supersede imported word preferences', () => {
  const imported = [token('wäsche', 10, 20, 100), token('waschen', 10, 20, 100)];
  const corrected = suggestTaskRoutingRoute([...imported, task('wäsche waschen', 11, 21)], 'Wäsche waschen', 9);
  assert.equal(corrected.project_id, 11);
  assert.equal(corrected.section_id, 21);
  assert.equal(corrected.match_kind, 'exact');
  const unresolved = task('wäsche waschen', 10, null, {list_known:false, project_known:false, preferred:false, section_known:false,
    evidence:{list:{reliable:false},section:{reliable:false}}});
  assert.equal(suggestTaskRoutingRoute([...imported, unresolved], 'Wäsche waschen', 9), null,
    'observed but ambiguous exact projects block the old token winner');
  const unresolvedSection = task('wäsche waschen', 10, null, {section_known:false, evidence:{section:{reliable:false}}});
  const route = suggestTaskRoutingRoute([...imported, unresolvedSection], 'Wäsche waschen', 9);
  assert.equal(route.project_id, 10);
  assert.equal(route.section_known, false, 'an ambiguous exact section does not resurrect a token section');
});

await check('task section conflicts remain independent of project confidence', () => {
  const rows = [token('wäsche', 10, 20), token('waschen', 10, 21)];
  const route = suggestTaskRoutingRoute(rows, 'Wäsche waschen', 9);
  assert.equal(route.project_id, 10);
  assert.equal(route.section_known, false);
  assert.deepEqual(route.memory_fields, ['list']);
});

await check('more consistent learned names improve recurring task recognition', () => {
  const rows = [task('wäsche waschen',11,21),task('wäsche trocknen',11,21),task('wäsche falten',11,21)];
  const original = structuredClone(rows);
  const route = suggestTaskRoutingRoute(rows,'Wäsche machen',9);
  assert.equal(route.project_id,11);
  assert.equal(route.section_id,21);
  assert.equal(route.match_kind,'statistical');
  assert.deepEqual(rows,original,'a lookup cannot modify evidence');
});

await check('long-word typo fallback preserves the entered task and never self-trains', () => {
  const rows=[task('wäsche waschen')], untouched=structuredClone(rows);
  const route=suggestTaskRoutingRoute(rows,'Wäsche waschne',9);
  assert.equal(route.project_id,10);
  assert.equal(route.section_id,20);
  assert.equal(route.match_kind,'typo');
  assert.equal(route.name_key,'wäsche waschne','routing never silently replaces the entered title');
  assert.equal(suggestTaskRoutingRoute(rows,'Wäsche wascen',9),null,'both compared words must have at least seven characters');
  assert.deepEqual(rows,untouched,'a typo lookup cannot learn a spelling or reinforce evidence');
});

await check('coalesced pending feedback keeps identity and reset fences', () => {
  const previous = {event_id:'create-before-reset',generation:3,fields:['list']};
  assert.deepEqual(mergeRoutingFeedback(previous,{event_id:'edit',generation:3,fields:['section']}),
    {event_id:'create-before-reset',generation:3,fields:['list','section']});
  assert.deepEqual(mergeRoutingFeedback(previous,{event_id:'metadata-only-edit',generation:3,fields:[]}),
    {event_id:'create-before-reset',generation:3,fields:['list']}, 'a metadata edit preserves the original explicit intent of an unsent create');
  assert.deepEqual(mergeRoutingFeedback({event_id:'predicted-create',generation:3,fields:[]},{event_id:'metadata-only-edit',generation:3,fields:[]}),
    {event_id:'predicted-create',generation:3,fields:[]}, 'coalescing predicted fields still creates no learning intent');
  assert.deepEqual(mergeRoutingFeedback(previous,{event_id:'module-edit',generation:3,fields:['module']}),
    {event_id:'create-before-reset',generation:3,fields:['list','module']}, 'a deliberate module correction survives create coalescing');
  assert.deepEqual(mergeRoutingFeedback(previous,{event_id:'post-reset',generation:4,fields:['section']}),
    {event_id:'post-reset',generation:4,fields:['section']}, 'old intent is not carried across a reset');
  assert.deepEqual(mergeRoutingFeedback(previous,{event_id:'opt-out',generation:4,fields:[]}),
    {event_id:'opt-out',generation:4,fields:[]}, 'disabled/no-learning envelopes do not retain earlier intent');
  assert.deepEqual(previous,{event_id:'create-before-reset',generation:3,fields:['list']},'queued receipts remain immutable');
});

await check('backend and offline matching use identical task/token semantics', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const vectors = [
    {entries:[task('wäsche waschen')],name:' WÄSCHE  WASCHEN ',workspace_id:9},
    {entries:[task('wäsche waschen')],name:'Wäsche waschen',workspace_id:'9'},
    {entries:[task('wäsche waschen')],name:'Wäsche waschen',workspace_id:8},
    {entries:[task('wäsche waschen',10,null)],name:'Wäsche waschen',workspace_id:9},
    {entries:[task('wäsche waschen',10,20,{workspace_id:null})],name:'Wäsche waschen',workspace_id:null},
    {entries:[task('straße kehren')],name:'STRASSE KEHREN',workspace_id:9},
    {entries:[task('wäsche waschen')],name:'Wäsche waschne',workspace_id:9},
    {entries:[task('wäsche waschen')],name:'Wäsche wascen',workspace_id:9},
    {entries:[task('tomaten')],name:'tomatoes',workspace_id:9},
    {entries:[token('wäsche')],name:'Wäsche waschen',workspace_id:9},
    {entries:[token('wäsche')],name:'Wäschekorb kaufen',workspace_id:9},
    {entries:[token('wäsche',10,20,9),token('waschen',11,21,1)],name:'Wäsche waschen',workspace_id:9},
    {entries:[token('wäsche',10,20,4),token('waschen',11,21,4)],name:'Wäsche waschen',workspace_id:9},
    {entries:[token('wäsche',10,20,4),token('waschen',11,21,4)],name:'Wäsche waschen',workspace_id:9,project_id:11},
    {entries:[token('wäsche',10,20,0.49)],name:'Wäsche waschen',workspace_id:9},
    {entries:[token('wäsche',10,20,100),task('wäsche waschen',11,21)],name:'Wäsche waschen',workspace_id:9},
    {entries:[token('wäsche',10,20,100),task('wäsche waschen',10,null,{section_known:false,evidence:{section:{reliable:false}}})],name:'Wäsche waschen',workspace_id:9},
    {entries:[token('wäsche',10,20,100),task('wäsche waschen',10,null,{list_known:false,project_known:false,preferred:false,section_known:false,evidence:{list:{reliable:false},section:{reliable:false}}})],name:'Wäsche waschen',workspace_id:9},
  ];
  const tokenTexts = ['Bitte Wäsche waschen und Wäsche 123', 'Straße KEHREN', 'ＳＡＬＺ kaufen', '牛奶 kaufen', '_wäsche_ waschen',
    'eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn'];
  const python = process.env.NIA_TODO_TEST_PYTHON || (existsSync(join(root,'.venv/bin/python')) ? join(root,'.venv/bin/python') : 'python3');
  const code = `import json,sys
from services.routing_matcher import suggest_task_route,routing_tokens
data=json.load(sys.stdin)
print(json.dumps({'routes':[suggest_task_route(row['entries'],row['name'],row.get('workspace_id'),row.get('project_id')) for row in data['vectors']], 'tokens':[routing_tokens(value) for value in data['tokenTexts']]},ensure_ascii=False))`;
  const actual = JSON.parse(execFileSync(python,['-c',code],{cwd:join(root,'api'),env:{...process.env,PYTHONPATH:join(root,'api')},
    input:JSON.stringify({vectors,tokenTexts}),encoding:'utf8',maxBuffer:1024*1024}));
  for (const [index,vector] of vectors.entries()) assert.deepEqual(actual.routes[index],suggestTaskRoutingRoute(vector.entries,vector.name,vector.workspace_id,vector.project_id),`route parity vector ${index}: ${vector.name}`);
  assert.deepEqual(actual.tokens,tokenTexts.map(routingTokens),'Unicode word normalization and bounds remain identical without lexical stopwords');
});

const values = new Map();
const storage = {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),
  key:index=>[...values.keys()][index],get length(){return values.size;}};
globalThis.location = {origin:'http://task-memory.test',search:''};
globalThis.window = {};
globalThis.localStorage = storage;
const {createRoutingMemoryFeature} = await import('../web/static/js/features/routing-memory.js');
let actor = 1, session = 'actor-1-session', server = 'first-server', enabled = true, gate = null;
let projects = [{id:10,workspace_id:9,can_edit:true},{id:11,workspace_id:8,can_edit:true}];
let sections = [{id:20,project_id:10},{id:21,project_id:11}];
let remote = {enabled:true,generation:3,revision:1,learned_routes:2,entries:[],task_entries:[task('wäsche waschen'),task('wäsche waschen',11,21,{workspace_id:8})]};
const api = {
  read:async()=>{const captured=structuredClone(remote);if(gate)await gate;return captured;},
  reset:async()=>{remote={...remote,generation:remote.generation+1,revision:0,learned_routes:0,task_entries:[]};return remote;},
  update:async value=>{remote={...remote,enabled:value,generation:remote.generation+1,revision:0,learned_routes:0,task_entries:[]};return remote;},
};
const events = new EventTarget();
const options = {getActorId:()=>actor,getSessionIdentity:()=>session,getServerIdentity:()=>server,getEnabled:()=>enabled,
  onEnabledChange:value=>{enabled=value;},getProjects:()=>projects,getSections:()=>sections,storage,api,eventTarget:events};
const memory = createRoutingMemoryFeature(options);

await check('task cache is actor/server/workspace scoped', async () => {
  await memory.refresh();
  assert.equal(memory.suggestTask('Wäsche waschen',9).project_id,10);
  assert.equal(memory.suggestTask('Wäsche waschen',8).project_id,11);
  assert.equal(memory.suggestTask('Wäsche waschen',7),null);
  server='second-server';
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
  server='first-server';
  assert.equal(memory.suggestTask('Wäsche waschen',9).project_id,10);
  actor=2;session='actor-2-session';
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
  actor=1;session='actor-1-new-session';
  assert.equal(memory.suggestTask('Wäsche waschen',9).project_id,10);
  assert.equal(memory.suggest('Wäsche waschen',10),null,'Task entries are never Shopping entries');
});

await check('cached task routes continuously recheck project and child access', () => {
  sections=[];
  const route=memory.suggestTask('Wäsche waschen',9);
  assert.equal(route.project_id,10);
  assert.equal(route.section_known,false);
  assert.deepEqual(route.memory_fields,['list']);
  assert.equal(memory.suggestTask('Wäsche waschen',9,null,[{id:20,project_id:10}]).section_id,20,
    'a complete authorized child catalog works independently of a Dashboard/current-project section projection');
  sections=[{id:20,project_id:11}];
  assert.equal(memory.suggestTask('Wäsche waschen',9).section_known,false,'cross-project section IDs cannot be used');
  sections=[{id:20,project_id:10},{id:21,project_id:11}];
  projects[0].can_edit=false;
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
  assert.equal(memory.suggestTask('Wäsche waschen',9,null,[{id:20,project_id:10}]),null,
    'a supplied child catalog never bypasses parent revocation');
  projects[0].can_edit=0;
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
  projects[0].can_edit=true;projects[0].workspace_id=8;
  assert.equal(memory.suggestTask('Wäsche waschen',9),null,'a stale workspace context cannot reuse a moved project');
  projects[0].workspace_id=9;
});

await check('read-only and archived task projects never receive cached proposals', () => {
  projects[0].can_edit_content=false;
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
  projects[0].can_edit_content=0;
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
  projects[0].can_edit_content=true;projects[0].archived=true;
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
  projects[0].archived=false;
});

await check('reset fences in-flight task reads and cross-tab old caches', async () => {
  const old=structuredClone(remote);
  let release;
  gate=new Promise(resolve=>{release=resolve;});
  const pending=memory.refresh();await Promise.resolve();
  await memory.reset();
  assert.equal(memory.snapshot().generation,4);
  release();gate=null;await pending;
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
  const key=[...values.keys()].find(value=>value.includes('first-server'));
  events.dispatchEvent(Object.assign(new Event('storage'),{key,newValue:JSON.stringify(old)}));
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
  assert.equal(memory.feedback(['section']).generation,4);
});

await check('same-session opt-out fences task proposals and pending reads', async () => {
  remote={...remote,revision:1,task_entries:[task('wäsche waschen')]};await memory.refresh();
  let release;
  gate=new Promise(resolve=>{release=resolve;});
  const pending=memory.refresh();await Promise.resolve();
  enabled=false;
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
  assert.deepEqual(memory.feedback(['list','section']).fields,[]);
  release();gate=null;await pending;
  assert.deepEqual(memory.snapshot().task_entries,[]);
  await memory.refresh();
  assert.equal(enabled,true,'a later authoritative response can acknowledge reenable');
  assert.equal(memory.suggestTask('Wäsche waschen',9).project_id,10);
  memory.clear();
  assert.equal(values.size,0);
  assert.equal(memory.suggestTask('Wäsche waschen',9),null);
});

console.log(`PASS ${cases} pure Task routing, imported evidence, cache authorization and reset/isolation cases`);
