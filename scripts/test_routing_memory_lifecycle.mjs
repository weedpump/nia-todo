#!/usr/bin/env node
// Pure client lifecycle, preparation and capture regressions. No DB or service.
import assert from 'node:assert/strict';
globalThis.location = {origin:'http://memory-lifecycle.test',search:''};
globalThis.window = {};
const {createRoutingMemoryFeature} = await import('../web/static/js/features/routing-memory.js');
let actor=7,session='7:first',enabled=true,server='one',reads=0,events=0,gate=null;
const lists=[{id:10,can_edit:true,sections:[{id:11},{id:12}]}];
const stores=[{id:31,shopping_list_id:10,active:true}];
const projects=[{id:20,workspace_id:2,can_edit:true}];
const sections=[{id:21,project_id:20},{id:22,project_id:20}];
let remote={enabled:true,generation:0,revision:1,learned_routes:2,
 entries:[{name_key:'margerine',shopping_list_id:10,list_known:true,preferred:true,section_id:11,section_known:true,store_ids:[31],stores_known:true,history_fields:['list','section','stores']}],
 task_entries:[{name_key:'wäsche waschen',workspace_id:2,project_id:20,project_known:true,list_known:true,preferred:true,section_id:21,section_known:true,history_fields:['list','section'],evidence:{section:{reliable:true}}}]};
const api={read:async()=>{reads++;const value=structuredClone(remote);const pending=gate;if(pending){pending.started();await pending.promise;}return value;},
 reset:async()=>{remote={...remote,generation:remote.generation+1,entries:[],task_entries:[]};return structuredClone(remote);},
 update:async value=>({...remote,enabled:value})};
const eventTarget=new EventTarget();
const memory=createRoutingMemoryFeature({api,storage:null,eventTarget,getActorId:()=>actor,getSessionIdentity:()=>session,
 getEnabled:()=>enabled,onEnabledChange:value=>{enabled=value;},getServerIdentity:()=>server,
 getLists:()=>lists,getStores:()=>stores,getProjects:()=>projects,getSections:()=>sections,createEventId:()=>`capture-event-${++events}`});
await memory.refresh();
let release,started;
const reading=new Promise(resolve=>{started=resolve;});
gate={started,promise:new Promise(resolve=>{release=resolve;})};
const oldRead=memory.refresh();await reading;
remote.revision=2;remote.task_entries[0].section_id=22;
const afterMutationRead=memory.refresh();
gate=null;release();await Promise.all([oldRead,afterMutationRead]);
assert.equal(reads,3,'a refresh requested during an older GET performs one trailing read');
assert.equal(memory.suggestTask('Wäsche waschen',2).section_id,22,'the confirmed newer destination is not lost behind an older response');
const frozen=memory.capture();assert.equal(events,0,'capturing a model does not create feedback events');
remote.revision=3;remote.task_entries[0].section_id=21;await memory.refresh();
assert.equal(frozen.suggestTask('Wäsche waschen',2).section_id,22,'an in-flight parse keeps its captured model revision');
assert.equal(memory.suggestTask('Wäsche waschen',2).section_id,21,'new interactions use the latest model revision');
remote.revision=4;
const crossTab=new Event('storage');
Object.assign(crossTab,{key:'nia-routing-memory-v1:one:7',newValue:JSON.stringify(remote)});
eventTarget.dispatchEvent(crossTab);
assert.equal(frozen.isCurrent(),true,'a same-generation cross-tab revision does not invalidate a captured save');
assert.equal(frozen.suggestTask('Wäsche waschen',2).section_id,22);
assert.deepEqual(frozen.feedback(['section'],{eventId:'cross-tab-save'}),{event_id:'cross-tab-save',generation:0,fields:['section']});
const exposed=memory.snapshot();exposed.task_entries[0].evidence.section.reliable=false;
assert.equal(memory.suggestTask('Wäsche waschen',2).section_known,true,'snapshot consumers cannot mutate the private prepared model');
let suggestion=memory.suggest('Pflanzliche Margarine',10);suggestion.store_ids.push(999);
assert.deepEqual(memory.suggest('Pflanzliche Margarine',10).store_ids,[31],'cached result values are owned by the caller');
const {routingMemoryRules:rules}=await import('../web/static/js/core/routing-memory-rule-data.js');
const priorEdits=rules.max_typo_edits;
try {
  rules.max_typo_edits=0;
  assert.equal(memory.suggest('Pflanzliche Margarine',10),null,'memoized results do not mask a changed matching policy');
} finally {rules.max_typo_edits=priorEdits;}
assert.equal(memory.suggest('Pflanzliche Margarine',10).section_id,11);
stores[0].active=false;
assert.equal(memory.suggest('Pflanzliche Margarine',10).stores_known,false,'in-place store deactivation invalidates prepared results');
stores[0].active=true;lists[0].sections=lists[0].sections.filter(row=>row.id!==11);
assert.equal(memory.suggest('Pflanzliche Margarine',10).section_known,false,'in-place section revocation invalidates prepared results');
lists[0].can_edit=false;assert.equal(memory.suggest('Pflanzliche Margarine',10),null,'a prepared model never keeps revoked list access');
projects[0].can_edit=false;assert.equal(frozen.suggestTask('Wäsche waschen',2),null,'captured models recheck current project access');
projects[0].can_edit=true;sections.splice(sections.findIndex(row=>row.id===22),1);
assert.equal(frozen.suggestTask('Wäsche waschen',2).section_known,false,'captured revision does not revive a removed child target');
await memory.reset();
assert.equal(frozen.isCurrent(),false);assert.equal(frozen.suggestTask('Wäsche waschen',2),null);
assert.deepEqual(frozen.feedback(['list'],{eventId:'old-save'}),{event_id:'old-save',generation:0,fields:[]},'reset cannot turn an old save into new-generation learning');
assert.equal(memory.feedback([]).generation,1);
actor=8;session='8:first';server='two';
assert.equal(frozen.suggestTask('Wäsche waschen',2),null,'captured memory never crosses identity or server boundaries');
memory.clear();
console.log('PASS trailing refresh, immutable prepared results, mutable access invalidation and captured save/reset/identity fences');
