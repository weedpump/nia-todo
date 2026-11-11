#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Real IndexedDB, private browser origin; no application service or SQLite.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://recipe-storage.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<script type="module">
      import * as storage from '/static/js/storage/indexed-db.js';
      import { DB_NAME,DB_VERSION } from '/static/js/core/config.js';
      import { createRecipeController } from '/static/js/features/recipe-mutations.js';
      import { mergeRecipeStepIngredients } from '/static/js/features/recipe-pending.js';
      import { createRecipeSyncAdapter } from '/static/js/features/recipe-sync.js';
      import { createMetadataSyncAdapter } from '/static/js/features/entity-metadata-sync.js';
      import { cookbookMetadata } from '/static/js/features/cookbooks.js';
      import { createSyncFeature } from '/static/js/features/sync.js';
      Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});
      window.test={storage,DB_NAME,DB_VERSION,createRecipeController,mergeRecipeStepIngredients,createRecipeSyncAdapter,createMetadataSyncAdapter,cookbookMetadata,createSyncFeature};
    </script>` });
    try { return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL(`../web${path}`, import.meta.url), 'utf8') }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto('http://recipe-storage.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const groups = await page.evaluate(async () => {
    const { storage:s, DB_NAME, DB_VERSION, createRecipeController, mergeRecipeStepIngredients, createRecipeSyncAdapter, createMetadataSyncAdapter, cookbookMetadata, createSyncFeature } = window.test;
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const eq = (a,b,message) => check(JSON.stringify(a) === JSON.stringify(b), message);
    const groups = [];
    const old = await new Promise((resolve,reject) => { const r=indexedDB.open(DB_NAME,9);r.onupgradeneeded=()=>{
      for(const name of ['todos','projects','sections','workspaces','avatars','shoppingLists','shoppingStores','cookbooks'])r.result.createObjectStore(name,{keyPath:'id'});
      r.result.createObjectStore('syncQueue',{keyPath:'id',autoIncrement:true});
    };r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
    await new Promise((resolve,reject)=>{const tx=old.transaction(['todos','cookbooks','syncQueue'],'readwrite');tx.objectStore('todos').put({id:1,title:'Keep'});tx.objectStore('cookbooks').put({id:2,name:'Keep'});tx.objectStore('syncQueue').put({id:1,action:'UPDATE_TODO',data:{id:1}});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});old.close();
    await s.openDatabase();
    check(DB_VERSION===10&&s.getDb().objectStoreNames.contains('entityImages'),'v9 upgrade adds only image cache');
    check((await s.getAll('todos'))[0].title==='Keep'&&(await s.getAll('cookbooks'))[0].name==='Keep'&&(await s.getAll('syncQueue')).length===1,'upgrade preserves data and queues');
    groups.push('v9 upgrade preserves existing stores');
    let books=[];let actor='1:0';const ref={value:false,privacyGeneration:0};let number=0;const remaps=[];
    const book=(id=10)=>({id,name:'Book',can_manage:true,can_edit:true,created_by_user_id:1,recipes:[],recipe_count:0});
    const recipe=(id=20,revision=1,title='Initial')=>({id,cookbook_id:10,title,description:'',base_servings:2,prep_minutes:null,cook_minutes:null,tags:[],ingredient_groups:[],steps:[],revision,can_edit:true,created_by_user_id:1,client_mutation_id:`recipe-${id}`});
    async function reset(next=[book()]) {books=next;await s.clear('cookbooks');await s.clear('syncQueue');await s.clear('entityImages');for(const row of books)await s.put('cookbooks',row);}
    async function commit(build) {const mutation=build();if(mutation)await s.commitRecipeMutation(mutation);return mutation;}
    const controller=createRecipeController({getCookbooks:()=>books,setCookbooks:value=>{books=value;},commitMutation:commit,getSessionIdentity:()=>actor,getCurrentUser:()=>({id:1}),createTempId:()=>`temp-recipe-${++number}`,recipesApi:{getRecipe:async()=>recipe(20,8,'Remote latest')}});
    const adapter=api=>createRecipeSyncAdapter({api,getCookbooks:()=>books,setCookbooks:value=>{books=value;},readQueue:()=>s.getAll('syncQueue'),markAttempt:s.markRecipeMutationAttempt,commitReplay:s.commitRecipeReplay,onIdRemap:(from,to)=>{check(!ref.commitLocked,'callback outside commit lock');remaps.push([from,to]);}});
    await reset();let created=await controller.create(10,{title:'Draft',source_url:'https://example.com/recipe',source_name:'Kitchen',source_author:'Cook',source_yield:'12 cookies'});await controller.update(created.id,{title:'Edited',steps:[{client_key:'s1',text:'One\nmultiline step'}]});
    let queue=await s.getAll('syncQueue');check(queue.length===1&&queue[0].action==='CREATE_RECIPE'&&queue[0].data.title==='Edited','unsent create/update collapses');
    check((await s.get('cookbooks',10)).recipes[0].steps[0].text==='One\nmultiline step','aggregate durable');
    check(queue[0].data.source_url==='https://example.com/recipe' && queue[0].data.source_author==='Cook','source attribution survives offline collapse');
    check((await s.get('cookbooks',10)).recipes[0].source_yield==='12 cookies','original yield remains durable across ordinary editor changes');
    await controller.remove(created.id);check(!(await s.getAll('syncQueue')).length&&books[0].recipes.length===0,'unsent create/delete collapses');
    groups.push('durable aggregate and safe unsent collapse');
    for (const creating of [false, true]) for (const clearing of [false, true]) {
      const initial = {...recipe(), ingredient_groups:[{client_key:'g',name:'Dough',ingredients:[
        {client_key:'flour',name:'Flour',quantity_value:200,quantity_unit:'g'},
        {client_key:'salt',name:'Salt',quantity_value:2,quantity_unit:'g'},
      ]}],steps:[{client_key:'s',title:'Original title',text:'Original body',excluded_ingredients:['salt'],ingredients:[
        {ingredient_client_key:'flour',origin:'braindump',show_quantity:true,quantity_value:50,quantity_text:null},
      ]}]};
      await reset(creating ? [book()] : [{...book(),recipes:[initial]}]);
      const target = creating ? await controller.create(10,initial) : initial;
      await controller.update(target.id,{steps:[{client_key:'s',title:'New title',text:'First edit',excluded_ingredients:['salt'],ingredients:[
        {ingredient_client_key:'flour',origin:'manual',show_quantity:true,quantity_value:100,quantity_text:null},
      ]}]});
      await controller.update(target.id,{steps:[{client_key:'s',text:'Legacy reference edit',ingredients:[{ingredient_client_key:'flour',origin:'manual',show_quantity:true}]}]});
      if (clearing) await controller.update(target.id,{steps:[{client_key:'s',title:'',text:'Clear choices',ingredients:[],excluded_ingredients:[]}]});
      await controller.update(target.id,{steps:[{client_key:'s',text:'Last body-only edit'}]});
      queue=await s.getAll('syncQueue');
      check(queue.length===1,'unsent edits still coalesce to one request');
      const fields=creating ? queue[0].data : queue[0].data.changes;
      const expected={client_key:'s',text:'Last body-only edit',title:clearing?'':'New title',excluded_ingredients:clearing?[]:['salt'],ingredients:clearing?[]:[
        {ingredient_client_key:'flour',origin:'manual',show_quantity:true,quantity_value:100,quantity_text:null},
      ]};
      eq(fields.steps,[expected],`${creating?'create':'update'} coalescing retains inherited step title, partial amount, origin and exclusions or explicit clears`);
      if (!creating) check(!Object.hasOwn(fields,'title')&&!Object.hasOwn(fields,'ingredient_groups')&&!Object.hasOwn(fields,'description'),'step coalescing never materializes unrelated recipe fields');
      await adapter({
        createRecipe:async(_id,payload)=>({...initial,...payload,id:20,cookbook_id:10,revision:1,applied_revision:1}),
        updateRecipe:async(_id,payload)=>({...mergeRecipeStepIngredients(initial,payload),revision:2,applied_revision:2}),
      }).replay(queue[0],ref,0);
      eq(books[0].recipes[0].steps,[expected],'acknowledgement cannot revert the effective offline step edits');
      eq((await s.get('cookbooks',10)).recipes[0].steps,[expected],'acknowledged step choices remain durable');
    }
    groups.push('unsent recipe step PATCH coalescing preserves quantities, origins, exclusions and explicit clearing');
    await reset();created=await controller.create(10,{title:'Before'});queue=await s.getAll('syncQueue');let release,started;
    const start=new Promise(resolve=>{started=resolve;});const wait=new Promise(resolve=>{release=resolve;});
    const replay=adapter({createRecipe:async(_id,payload)=>{started(payload);await wait;return {...recipe(20),...payload,applied_revision:1};}}).replay(queue[0],ref,0);
    const sent=await start;await controller.update(created.id,{title:'During'});queue=await s.getAll('syncQueue');check(queue[0].attempted&&queue[0].data.title==='Before'&&queue.length===2,'attempted create frozen');
    release();await replay;queue=await s.getAll('syncQueue');check(sent.title==='Before'&&queue[0].data.id===20&&queue[0].data.expected_revision===1,'create receipt remaps and rebases');check(books[0].recipes[0].title==='During'&&books[0].recipes[0].revision===1,'local overlay preserved without optimistic revision');
    groups.push('attempted create freezes, remaps, rebases and preserves later draft');
    await reset();const custom=await controller.create(10,{title:'Custom',client_mutation_id:'custom-cmi'});queue=await s.getAll('syncQueue');
    await adapter({createRecipe:async()=>({...recipe(22),client_mutation_id:'custom-cmi',applied_revision:1})}).replay(queue[0],ref,0);
    check(controller.resolveId(custom.id)===22,'custom CMI temp alias resolves after acknowledgement');
    await controller.update(custom.id,{title:'Custom edited'},{expectedRevision:0});check((await s.getAll('syncQueue'))[0].data.expected_revision===1,'pre-create editor baseline rebases only to initial applied revision');check(books[0].recipes[0].title==='Custom edited','old temporary identity updates correct canonical recipe');
    actor='2:1';check(controller.resolveId(custom.id)===null,'temporary alias never crosses session/actor');actor='1:0';

    await reset([{...book(),recipes:[recipe()]}]);await controller.update(20,{title:'Own first'},{expectedRevision:1});queue=await s.getAll('syncQueue');
    let releaseUpdate,startedUpdate;const updateStart=new Promise(resolve=>{startedUpdate=resolve;});const updateWait=new Promise(resolve=>{releaseUpdate=resolve;});
    const ack=adapter({updateRecipe:async()=>{startedUpdate();await updateWait;return {...recipe(20,7,'Foreign later'),applied_revision:2};}}).replay(queue[0],ref,0);
    await updateStart;await controller.update(20,{description:'Own later'});releaseUpdate();await ack;queue=await s.getAll('syncQueue');check(queue[0].data.expected_revision===2,'rebase uses applied revision not returned latest');check(books[0].recipes[0].revision===7&&books[0].recipes[0].description==='Own later','newer returned server and local changes both preserved');
    await adapter({updateRecipe:async()=>{throw Object.assign(new Error('conflict'),{status:409,data:{detail:{code:'recipe.revisionConflict',current:recipe(20,7,'Foreign later')}}});}}).replay(queue[0],ref,0);
    queue=await s.getAll('syncQueue');check(queue[0].conflict.local.description==='Own later'&&books[0].recipes[0].conflict.server.revision===7,'conflict persists server and local intent');
    books=await s.getAll('cookbooks');check(controller.getRecipe(20).conflict,'conflict survives cache reload');
    await controller.resolveConflict(20,{keepLocal:true});queue=await s.getAll('syncQueue');check(queue.length===1&&!queue[0].attempted&&queue[0].data.expected_revision===8&&queue[0].data.changes.description==='Own later','explicit overwrite rereads latest and new request');
    check(!books[0].recipes[0].conflict,'resolved conflict cleared');
    groups.push('applied revision, durable conflict and explicit latest-revision overwrite');
    await reset([{...book(),recipes:[recipe()]}]);await controller.update(20,{title:'Stale editor'},{expectedRevision:1});queue=await s.getAll('syncQueue');
    await adapter({updateRecipe:async()=>{throw Object.assign(new Error(),{status:409,data:{detail:{current:recipe(20,7,'Remote')}}});}}).replay(queue[0],ref,0);
    await controller.resolveConflict(20,{keepLocal:false});check(!(await s.getAll('syncQueue')).length&&books[0].recipes[0].title==='Remote latest'&&books[0].recipes[0].revision===8,'discard explicit loads latest server');
    await controller.remove(20,{expectedRevision:3});queue=await s.getAll('syncQueue');check(queue[0].data.expected_revision===3,'delete uses captured editor revision');
    await adapter({deleteRecipe:async()=>{throw Object.assign(new Error(),{status:409,data:{detail:{current:recipe(20,9,'New remote')}}});}}).replay(queue[0],ref,0);
    check(books[0].recipes[0].conflict.operation==='delete','delete conflict visible and recoverable');
    groups.push('discard conflict and revision-aware delete conflict');
    await reset();created=await controller.create(10,{title:'Pending'});queue=await s.getAll('syncQueue');
    let snapshot=cookbookMetadata.reconcileSnapshot([{...book(),recipes:[{...recipe(90),created_by_user_id:2,client_mutation_id:created.client_mutation_id}]}],books,queue,{actorId:1});
    check(snapshot.entities[0].recipes.length===2&&!snapshot.queueDeleteIds.length,'foreign actor CMI never acknowledges own create');
    snapshot=cookbookMetadata.reconcileSnapshot([{...book(),recipes:[{...recipe(90),client_mutation_id:created.client_mutation_id}]}],books,queue,{actorId:1});
    check(snapshot.entities[0].recipes.length===1&&snapshot.queueDeleteIds.includes(queue[0].id)&&snapshot.recipeRemaps[0][1]===90,'own snapshot receipt remaps create');
    snapshot=cookbookMetadata.reconcileSnapshot([{...book(),can_edit:false}],books,queue,{actorId:1});check(snapshot.entities[0].recipes.length===0&&snapshot.queueDeleteIds.includes(queue[0].id),'readonly snapshot removes unauthorized pending edits');
    const acknowledged={...recipe(20,2,'Acknowledged'),description:'Saved'};
    const lateSnapshot=cookbookMetadata.reconcileSnapshot([{...book(),recipes:[recipe(20,1,'Old')]}],[{...book(),recipes:[acknowledged]}],[],{actorId:1});
    await s.commitCookbookReplay(lateSnapshot);check((await s.get('cookbooks',10)).recipes[0].title==='Acknowledged','late snapshot cannot roll acknowledged recipe revision backward');
    const revokedEdit=cookbookMetadata.reconcileSnapshot([{...book(),can_edit:false,recipes:[recipe(20,1,'Old')]}],lateSnapshot.entities,[],{actorId:1});
    check(revokedEdit.entities[0].recipes[0].title==='Acknowledged'&&!revokedEdit.entities[0].recipes[0].can_edit,'new authorization applies even to monotonic aggregate');
    const absent=cookbookMetadata.reconcileSnapshot([{...book(),recipes:[]}],lateSnapshot.entities,[],{actorId:1});check(absent.entities[0].recipes.length===0,'authoritative absence still removes cached newer recipe');
    await reset([{...book(),recipes:[recipe()]}]);let finishRest,startedRest;const restStarted=new Promise(resolve=>{startedRest=resolve;});const heldRest=new Promise(resolve=>{finishRest=resolve;});
    const restSync=createSyncFeature({getDb:s.getDb,dbGetAll:s.getAll,dbPut:s.put,dbClear:s.clear,getFromDB:s.get,deleteFromDB:s.remove,getTodos:()=>[],setTodos(){},getProjects:()=>[],setProjects(){},getSections:()=>[],setSections(){},getWorkspaces:()=>[],setWorkspaces(){},getCookbooks:()=>books,setCookbooks:value=>{books=value;},renderStats(){},renderTodos(){},todosApi:{list:async()=>({todos:[]})},projectsApi:{list:async()=>({projects:[]})},sectionsApi:{listAll:async()=>({sections:[]})},workspacesApi:{list:async()=>({workspaces:[]})},recipesApi:{snapshot:async()=>{startedRest();await heldRest;return{cookbooks:[{...book(),recipes:[recipe(20,1,'Old REST')]}]};}},commitCookbookReplay:s.commitCookbookReplay});
    const restRefresh=restSync.refreshFromServer({wsState:'connected',syncInProgressRef:ref});await restStarted;
    books=[{...book(),recipes:[acknowledged]}];await s.commitCookbookReplay({entities:books});finishRest();await restRefresh;
    check(books[0].recipes[0].title==='Acknowledged'&&(await s.get('cookbooks',10)).recipes[0].revision===2,'late REST refresh uses same monotonic merge under commit lock');

    groups.push('snapshot pending preservation, actor receipts and revoked editing');
    await reset([{...book(),recipes:[recipe()]}]);await controller.update(20,{title:'Obsolete'});queue=await s.getAll('syncQueue');let releaseOld,startedOld;const oldStart=new Promise(resolve=>{startedOld=resolve;});const oldWait=new Promise(resolve=>{releaseOld=resolve;});
    const oldReply=adapter({updateRecipe:async()=>{startedOld();await oldWait;return {...recipe(20,2,'Obsolete'),applied_revision:2};}}).replay(queue[0],ref,0);await oldStart;
    ref.privacyGeneration++;await s.evictPendingCookbookEntities([10]);books=[{...book(11),name:'New account'}];await s.put('cookbooks',books[0]);releaseOld();check(await oldReply===false,'stale response fenced');check((await s.getAll('cookbooks'))[0].id===11,'new state survives stale receipt');ref.privacyGeneration=0;
    groups.push('privacy generation and removed-queue receipt fence');
    await reset([{...book(),recipes:[recipe()]}]);await s.putEntityImageWhenReady({id:'private',cookbook_id:10,recipe_id:20,user_id:1,version:'a',blob:new Blob(['image'])});await s.put('syncQueue',{action:'UPDATE_SHOPPING_ITEM',data:{id:20,shopping_list_id:10}});await controller.remove(20);check(!(await s.getAll('entityImages')).length,'recipe removal purges private image');await s.evictPendingCookbookEntities([10]);queue=await s.getAll('syncQueue');check(queue.length===1&&queue[0].action==='UPDATE_SHOPPING_ITEM','typed privacy eviction preserves colliding other domain');
    await s.putEntityImageWhenReady({id:'orphan',cookbook_id:999,recipe_id:998,blob:new Blob(['private'])});
    await s.commitCookbookReplay({entities:[]});check((await s.getAll('entityImages')).length===1,'partial replay does not infer orphan image revocation');
    await s.commitCookbookReplay(cookbookMetadata.reconcileSnapshot([],[],[],{actorId:1}));check(!(await s.getAll('entityImages')).length,'empty full snapshot purges cold orphan private image');
    groups.push('image cleanup and typed cookbook/recipe queue eviction');
    await reset([{...book('temp-cookbook-empty'),client_mutation_id:'temp-cookbook-empty'}]);
    await s.put('syncQueue',{action:'CREATE_COOKBOOK',data:{temp_id:'temp-cookbook-empty',client_mutation_id:'temp-cookbook-empty',name:'Offline parent'}});
    await controller.create('temp-cookbook-empty',{title:'Offline child'});
    const emptySnapshot=cookbookMetadata.reconcileSnapshot([],books,await s.getAll('syncQueue'),{actorId:1});
    await s.commitCookbookReplay(emptySnapshot);books=emptySnapshot.entities;
    eq((await s.getAll('syncQueue')).map(row=>row.action),['CREATE_COOKBOOK','CREATE_RECIPE'],'empty full snapshot preserves pending parent and recipe queue');
    check(books[0].recipes[0].title==='Offline child'&&books[0].recipes[0].revision===0,'empty snapshot preserves offline recipe cache');
    const emptyParentAdapter=createMetadataSyncAdapter({contract:cookbookMetadata,api:{create:async()=>({...book(101),client_mutation_id:'temp-cookbook-empty'})},getEntities:()=>books,setEntities:value=>{books=value;},readQueue:()=>s.getAll('syncQueue'),markAttempt:s.markCookbookMutationAttempt,commitReplay:s.commitCookbookReplay});
    await emptyParentAdapter.replay((await s.getAll('syncQueue'))[0],ref,0);
    await adapter({createRecipe:async(bookId,data)=>({...recipe(201),...data,cookbook_id:bookId,applied_revision:1})}).replay((await s.getAll('syncQueue'))[0],ref,0);
    check(!(await s.getAll('syncQueue')).length&&books[0].id===101&&books[0].recipes[0].id===201,'parent and child still replay successfully after empty snapshot');

    await reset([{...book('temp-cookbook-p'),client_mutation_id:'temp-cookbook-p'},book(11)]);
    await s.put('syncQueue',{action:'CREATE_COOKBOOK',data:{temp_id:'temp-cookbook-p',client_mutation_id:'temp-cookbook-p',name:'Parent'}});
    await controller.create('temp-cookbook-p',{title:'Child'});await controller.create(11,{title:'Unrelated'});
    const beforeSnapshot=await s.getAll('syncQueue');
    const pendingParentSnapshot=cookbookMetadata.reconcileSnapshot([{...book(11)}],books,beforeSnapshot,{actorId:1});
    await s.commitCookbookReplay(pendingParentSnapshot);books=pendingParentSnapshot.entities;
    check((await s.getAll('syncQueue')).filter(row=>row.action==='CREATE_RECIPE').length===2,'full snapshot never acknowledges a local recipe in a pending parent');
    check((await s.getAll('syncQueue')).some(row=>row.action==='CREATE_COOKBOOK'),'full snapshot keeps offline parent create');
    check(books.find(row=>row.id==='temp-cookbook-p').recipes[0].revision===0,'pending recipe keeps unsent revision');
    let failParent=true;const calls=[];
    const sync=createSyncFeature({getDb:s.getDb,dbGetAll:s.getAll,dbPut:s.put,dbClear:s.clear,getFromDB:s.get,deleteFromDB:s.remove,getTodos:()=>[],setTodos(){},getProjects:()=>[],setProjects(){},getSections:()=>[],setSections(){},getWorkspaces:()=>[],setWorkspaces(){},renderStats(){},renderTodos(){},getCookbooks:()=>books,setCookbooks:value=>{books=value;},commitCookbookReplay:s.commitCookbookReplay,markCookbookMutationAttempt:s.markCookbookMutationAttempt,commitRecipeReplay:s.commitRecipeReplay,markRecipeMutationAttempt:s.markRecipeMutationAttempt,recipesApi:{createCookbook:async()=>{if(failParent)throw Object.assign(new Error('temporary'),{status:503});return {...book(100),client_mutation_id:'temp-cookbook-p'};},createRecipe:async(id,data)=>{calls.push(id);return {...recipe(calls.length+200),...data,cookbook_id:id,applied_revision:1};}}});
    await sync.syncWithServer({wsState:'connected',syncInProgressRef:ref});eq(calls,[11],'unrelated book proceeds, pending parent child deferred');failParent=false;await sync.syncWithServer({wsState:'connected',syncInProgressRef:ref});eq(calls,[11,100],'retry remaps parent before child replay');check(!(await s.getAll('syncQueue')).length,'parent retry settled all queues');
    groups.push('failed parent defers child while unrelated book proceeds; retry remaps');
    await s.closeAndDeleteDatabase();const pending=s.getEntityImageWhenReady('private');await s.putEntityImageWhenReady({id:'obsolete',blob:new Blob(['old'])});await s.closeAndDeleteDatabase();check(await pending===null,'close cancels pending image waiter');await s.openDatabase();check(!(await s.getAll('entityImages')).length,'old generation image write cannot leak into new account');
    groups.push('shared cache readiness cancellation and generation fencing');
    return groups;
  });
  assert.equal(groups.length,11);
  for (const group of groups) console.log(`PASS ${group}`);
} finally { await browser.close(); }
