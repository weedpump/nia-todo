#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

// Private browser origin, real disposable IndexedDB and mocked API functions.
// No application service, external network or SQLite database is used.
const browser = await chromium.launch({ headless:true });
try {
  const page = await browser.newPage();
  await page.route('http://creation-tombstone.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({contentType:'text/html',body:`<script type="module">
      import * as storage from '/static/js/storage/indexed-db.js';
      import {createSyncFeature} from '/static/js/features/sync.js';
      import {creationTombstoneFor,planCreationTombstone} from '/static/js/features/creation-tombstone.js';
      Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});
      await storage.openDatabase();window.test={storage,createSyncFeature,creationTombstoneFor,planCreationTombstone};
    </script>`});
    try { return route.fulfill({contentType:'text/javascript',body:readFileSync(new URL(`../web${path}`,import.meta.url),'utf8')}); }
    catch { return route.fulfill({status:404}); }
  });
  await page.goto('http://creation-tombstone.test/');await page.waitForFunction(()=>Boolean(window.test));
  const groups = await page.evaluate(async () => {
    const {storage:s,createSyncFeature,creationTombstoneFor,planCreationTombstone}=window.test;
    const check=(condition,message)=>{if(!condition)throw new Error(message);};
    const eq=(actual,expected,message)=>check(JSON.stringify(actual)===JSON.stringify(expected),message);
    const transient=()=>Object.assign(new Error('controlled offline fixture'),{status:503});
    const kinds={todo:'CREATE_TODO',shopping_list:'CREATE_SHOPPING_LIST',shopping_section:'CREATE_SHOPPING_SECTION',shopping_store:'CREATE_SHOPPING_STORE',shopping_item:'CREATE_SHOPPING_ITEM'};
    const cacheNames=['todos','shoppingLists','shoppingStores'];
    let todos,lists,stores,actor,ref,calls,recordedQueue,held,release,started,commitOverride,freshen;
    const snapshot=async()=>Object.fromEntries(await Promise.all([...cacheNames,'syncQueue'].map(async name=>[name,await s.getAll(name)])));
    const entryFor=(kind)=>({id:1,action:kinds[kind],data:kind==='todo'
      ? {_tempId:'temp-created',title:'Create draft',project_id:null,section_id:null,client_mutation_id:'create-receipt'}
      : kind==='shopping_list' ? {temp_id:'temp-created',name:'Create draft',client_mutation_id:'create-receipt'}
        : kind==='shopping_item' ? {temp_id:'temp-created',shopping_list_id:10,client_mutation_id:'create-receipt',item:{name:'Create draft',section_id:null,store_ids:[]}}
          : kind==='shopping_section' ? {temp_id:'temp-created',shopping_list_id:10,client_mutation_id:'create-receipt',section:{name:'Create draft'}}
            : {temp_id:'temp-created',shopping_list_id:10,client_mutation_id:'create-receipt',name:'Create draft'}});
    const detailFor=kind=>({code:'sync.creationDeleted',entity_type:kind,id:50,...(!['todo','shopping_list'].includes(kind)?{shopping_list_id:10}:{})});
    async function reset(kind) {
      for(const name of [...cacheNames,'syncQueue'])await s.clear(name);
      actor=1;ref={value:false,privacyGeneration:0};calls=[];recordedQueue=null;held=false;release=null;started=null;commitOverride=null;freshen=false;
      todos=[{id:999,title:'Unrelated task',project_id:null}];
      lists=[{id:10,name:'Parent',can_edit:true,sections:[{id:'temp-created',name:'Pending'},{id:50,name:'Deleted structure'},{id:70,name:'Keep structure'}],items:[
        {id:'temp-created',name:'Pending item',section_id:'temp-created',store_ids:['temp-created',70],stores:[{id:'temp-created'},{id:70}]},
        {id:50,name:'Canonical item',section_id:50,store_ids:[50,70],stores:[{id:50},{id:70}]},
        {id:60,name:'Keep item',section_id:70,store_ids:[70]},
      ]},{id:20,name:'Other list',can_edit:true,sections:[{id:50,name:'Other scope'}],items:[{id:50,name:'Other content',section_id:50,store_ids:[50]}]}];
      stores=[{id:'temp-created',shopping_list_id:10,name:'Pending store'},{id:50,shopping_list_id:10,name:'Canonical store'},{id:70,shopping_list_id:10,name:'Keep store'},{id:80,shopping_list_id:20,name:'Other store'}];
      const target=entryFor(kind);
      if(kind==='todo')todos.push({id:'temp-created',title:'Pending task',project_id:null},{id:50,title:'Canonical deleted task',project_id:null});
      if(kind==='shopping_list') {
        lists.push({id:'temp-created',name:'Pending list',can_edit:true,sections:[],items:[]},{id:50,name:'Deleted canonical list',can_edit:true,sections:[],items:[]});
        stores.push({id:90,shopping_list_id:'temp-created'},{id:91,shopping_list_id:50});
      }
      for(const [name,rows] of [['todos',todos],['shoppingLists',lists],['shoppingStores',stores]])for(const row of rows)await s.put(name,row);
      await s.put('syncQueue',target);
      const related=kind==='todo'?{id:2,action:'CREATE_COMMENT',data:{todo_id:'temp-created',body:'No ghost'}}
        : kind==='shopping_list'?{id:2,action:'CREATE_SHOPPING_ITEM',data:{shopping_list_id:'temp-created',temp_id:'temp-child',item:{name:'Child'}}}
          : {id:2,action:kind==='shopping_item'?'UPDATE_SHOPPING_ITEM':kind==='shopping_section'?'UPDATE_SHOPPING_SECTION':'UPDATE_SHOPPING_STORE',data:{shopping_list_id:10,[kind==='shopping_item'?'item_id':kind==='shopping_section'?'section_id':'store_id']:'temp-created',changes:{name:'No ghost'}}};
      await s.put('syncQueue',related);
      await s.put('syncQueue',{id:9,action:'UPDATE_TODO',data:{id:999,changes:{title:'Unrelated queued task'}}});
      const foreignListId=kind==='shopping_list'?'temp-created':10;
      await s.put('syncQueue',{id:10,actor_id:2,action:'CREATE_SHOPPING_ITEM',data:{shopping_list_id:foreignListId,temp_id:'temp-foreign',item:{name:'Foreign should not dispatch',section_id:'temp-created',store_ids:['temp-created']}}});
      await s.put('syncQueue',{id:11,actor_id:2,action:'UPDATE_SHOPPING_ITEM',data:{shopping_list_id:foreignListId,item_id:50,changes:{name:'Foreign should not dispatch',section_id:50,store_ids:[50]}}});
      await s.put('syncQueue',{id:12,actor_id:2,action:'TRANSFER_RECIPE_TO_SHOPPING',data:{shopping_list_id:foreignListId,recipe_id:100,cookbook_id:101,client_mutation_id:'foreign-transfer',ingredients:[{ingredient_client_key:'flour',section_id:'temp-created',store_ids:['temp-created']}]}});
      if(['shopping_section','shopping_store'].includes(kind)) {
        const association=kind==='shopping_section'?{section_id:'temp-created',store_ids:[70]}:{section_id:70,store_ids:['temp-created',70]};
        const frozen=kind==='shopping_section'?{section_id:50,store_ids:[70]}:{section_id:70,store_ids:[50,70]};
        await s.put('syncQueue',{id:3,action:'CREATE_SHOPPING_ITEM',data:{shopping_list_id:10,temp_id:'temp-unsent-child',client_mutation_id:'child-receipt',item:{name:'Preserved child',...association,braindump_route:{original_module_id:'shopping'}}}});
        await s.put('syncQueue',{id:4,action:'CREATE_SHOPPING_ITEM',attempted:true,data:{shopping_list_id:10,temp_id:'temp-frozen-child',client_mutation_id:'frozen-receipt',item:{name:'Frozen child',...frozen,routing_feedback:{event_id:'frozen-feedback',generation:3,fields:['section','stores']}}}});
        await s.put('syncQueue',{id:5,action:'TRANSFER_RECIPE_TO_SHOPPING',actor_id:1,blocked:{status:409},data:{shopping_list_id:10,recipe_id:100,cookbook_id:101,servings:2,expected_revision:1,client_mutation_id:'transfer',ingredients:[{ingredient_client_key:'flour',...association,routing_feedback:{event_id:'transfer-feedback',generation:3,fields:['section','stores']}}]}});
        await s.put('syncQueue',{id:6,action:'UPDATE_SHOPPING_ITEM',data:{shopping_list_id:10,item_id:60,changes:{...association,note:'Ordinary legacy update'}}});
      }
      return target;
    }
    const makeSync=kind=>{
      const create=async (...args)=>{
        calls.push({kind,args:structuredClone(args)});
        recordedQueue=await s.get('syncQueue',1);check(recordedQueue.attempted===true,'dispatch has a durable attempt marker');
        if(held){started();await new Promise(resolve=>{release=resolve;});}
        throw Object.assign(new Error('deleted after prior successful create'),{status:410,data:{detail:detailFor(kind)}});
      };
      const reject=async(...args)=>{calls.push({kind:'other',args:structuredClone(args)});throw transient();};
      return createSyncFeature({getDb:s.getDb,dbGetAll:async name=>{
          if(freshen&&name==='syncQueue'&&ref.commitLocked){freshen=false;const row=await s.get(name,1);await s.put(name,{...row,data:{...row.data,name:'Changed before reservation'}});}
          return s.getAll(name);
        },
        dbPut:s.put,dbClear:s.clear,deleteFromDB:s.remove,getFromDB:s.get,
        getActorId:()=>actor,getTodos:()=>todos,setTodos:rows=>todos=rows,getProjects:()=>[],setProjects(){},getSections:()=>[],setSections(){},getWorkspaces:()=>[],setWorkspaces(){},
        getShoppingLists:()=>lists,setShoppingLists:rows=>lists=rows,getShoppingStores:()=>stores,setShoppingStores:rows=>stores=rows,
        todosApi:{create:kind==='todo'?create:reject,update:reject,createComment:reject},projectsApi:{},sectionsApi:{},workspacesApi:{},
        shoppingApi:{createList:kind==='shopping_list'?create:reject,createSection:kind==='shopping_section'?create:reject,createStore:kind==='shopping_store'?create:reject,
          createItem:kind==='shopping_item'?create:async(...args)=>{calls.push({kind:'child',args:structuredClone(args)});throw transient();},updateItem:reject,updateSection:reject,updateStore:reject,getList:reject,listStores:reject},
        commitCreationTombstoneReplay:plan=>commitOverride?commitOverride(plan):s.commitCreationTombstoneReplay(plan),commitShoppingReplay:s.commitShoppingReplay,
        renderStats(){},renderTodos(){},renderShopping(){}});
    };
    const run=kind=>makeSync(kind).syncWithServer({wsState:'connected',syncInProgressRef:ref});
    for(const kind of Object.keys(kinds)) {
      await reset(kind);const before=await snapshot();
      await run(kind);
      const after=await snapshot(),queue=after.syncQueue;
      check(!queue.some(row=>[1,2].includes(row.id)),`${kind} retires the deleted creation and its typed dependent intents`);
      eq(queue.find(row=>row.id===9).data,before.syncQueue.find(row=>row.id===9).data,'unrelated task intent survives');
      eq(queue.filter(row=>row.actor_id===2),before.syncQueue.filter(row=>row.actor_id===2),'foreign actor CREATE/UPDATE/transfer intents survive unchanged in the same target list');
      check(!calls.some(call=>JSON.stringify(call.args).includes('Foreign should not dispatch')),'foreign actor writes are never dispatched');
      if(kind==='todo')check(after.todos.length===1&&todos.length===1,'deleted temporary and canonical task ghosts are removed');
      else {
        eq(after.shoppingLists.find(list=>list.id===20),before.shoppingLists.find(list=>list.id===20),'other list content is unchanged');
        if(kind==='shopping_list')check(!after.shoppingLists.some(list=>['temp-created',50].includes(list.id))&&!after.shoppingStores.some(store=>['temp-created',50].includes(store.shopping_list_id)),'deleted list and scoped stores are removed');
        if(kind==='shopping_item')eq(after.shoppingLists.find(list=>list.id===10).items.map(row=>row.id),[60],'only deleted item ghosts are removed');
        if(['shopping_section','shopping_store'].includes(kind)) {
          const parent=after.shoppingLists.find(list=>list.id===10),field=kind==='shopping_section'?'section':'stores';
          check(kind==='shopping_section'?parent.items.slice(0,2).every(row=>row.section_id===null):parent.items.slice(0,2).every(row=>JSON.stringify(row.store_ids)==='[70]'),'cached items fall back like server-side structural deletion');
          const child=queue.find(row=>row.id===3),frozen=queue.find(row=>row.id===4),transfer=queue.find(row=>row.id===5);
          check(child.data.item.name==='Preserved child','an unsent new item keeps its content');
          check(kind==='shopping_section'?child.data.item.section_id===null:JSON.stringify(child.data.item.store_ids)==='[70]','unsent item associations fall back safely');
          eq(child.data.item.routing_feedback.fields,[],'automatic legacy fallback does not learn a manual correction');
          eq(queue.find(row=>row.id===6).data.changes.routing_feedback.fields,[],'ordinary legacy updates without provenance do not learn technical fallback routing');
          eq(frozen.data,before.syncQueue.find(row=>row.id===4).data,'previously dispatched child bodies stay byte-for-byte unchanged');
          check(!transfer.data.ingredients[0].routing_feedback.fields.includes(field),'automatic transfer fallback removes only the affected feedback field');
        }
      }
      await run(kind);check(calls.filter(call=>call.kind===kind).length===1,'a settled creation tombstone is never retried');
    }
    for(const boundary of ['privacy','actor','queue-removed','queue-replaced','queue-foreign-actor']) {
      await reset('shopping_item');held=true;
      const ready=new Promise(resolve=>{started=resolve;});const operation=run('shopping_item');await ready;
      if(boundary==='privacy')ref.privacyGeneration++;
      if(boundary==='actor')actor=2;
      if(boundary==='queue-removed')await s.remove('syncQueue',1);
      if(boundary==='queue-replaced'){const row=await s.get('syncQueue',1);await s.put('syncQueue',{...row,data:{...row.data,client_mutation_id:'other-request'}});}
      if(boundary==='queue-foreign-actor'){const row=await s.get('syncQueue',1);await s.put('syncQueue',{...row,actor_id:2});}
      const before=await snapshot();release();await operation;const after=await snapshot();
      eq(after.shoppingLists,before.shoppingLists,`${boundary} prevents a stale deletion receipt from changing cached entities`);
      eq(after.syncQueue.find(row=>row.id===1)?.data,before.syncQueue.find(row=>row.id===1)?.data,`${boundary} preserves replacement/current intent`);
    }
    await reset('shopping_item');let beforeRollback;
    commitOverride=async plan=>{beforeRollback=await snapshot();return s.commitCreationTombstoneReplay({...plan,writes:{...plan.writes,shoppingLists:[...plan.writes.shoppingLists,{name:'Invalid missing primary key'}]}});};
    await run('shopping_item');
    const afterRollback=await snapshot();eq(afterRollback.shoppingLists,beforeRollback.shoppingLists,'transaction failure rolls back every cache edit');
    eq(afterRollback.syncQueue,beforeRollback.syncQueue,'transaction failure rolls back queue deletions and rewrites');
    await reset('shopping_list');freshen=true;await run('shopping_list');
    check(calls[0].args[0].name==='Changed before reservation','reservation sends the freshly sanitized body after earlier coalescing');
    const item=entryFor('shopping_item');
    check(creationTombstoneFor({action:'UNKNOWN',data:{shopping_list_id:10}},{status:410,data:{detail:{code:'sync.creationDeleted',id:50,shopping_list_id:10}}})===null,'unknown actions and missing entity types fail closed');
    for(const detail of [{...detailFor('shopping_item'),id:0},{...detailFor('shopping_item'),entity_type:'todo'},{...detailFor('shopping_item'),shopping_list_id:20}])
      check(creationTombstoneFor(item,{status:410,data:{detail}})===null,'wrong identities cannot be treated as deletion receipts');
    const untouched={id:30,action:'UPDATE_TODO',data:{id:50,changes:{title:'Typed namespace'}}};
    const purePlan=planCreationTombstone(item,detailFor('shopping_item'),{queue:[item,untouched],shoppingLists:[],shoppingStores:[]});
    check(!purePlan.queueDeleteIds.includes(30),'identical IDs in another namespace are not dependent intents');
    await s.closeAndDeleteDatabase();
    return 9;
  });
  assert.equal(groups,9);
  console.log('PASS creation tombstones: five entity types, structural fallback, frozen requests, typed cleanup, reservation, privacy/account/presence fences and atomic rollback');
} finally { await browser.close(); }
