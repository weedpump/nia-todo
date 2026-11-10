#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

// Private browser origin and real IndexedDB. All API transports are controlled
// in-memory fixtures; no Nia service, SQLite or development data is touched.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://recipe-shopping-queue.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<script type="module">
      import * as storage from '/static/js/storage/indexed-db.js';
      import * as transfer from '/static/js/features/recipe-shopping-pending.js';
      import { createSyncFeature } from '/static/js/features/sync.js';
      import { cookbookMetadata } from '/static/js/features/cookbooks.js';
      import { rewriteRecipeQueue } from '/static/js/features/recipe-pending.js';
      import { rewriteShoppingQueueReferences } from '/static/js/features/shopping-pending.js';
      Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});
      await storage.openDatabase();window.test={storage,transfer,createSyncFeature,cookbookMetadata,rewriteRecipeQueue,rewriteShoppingQueueReferences};
    </script>` });
    try { return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL(`../web${path}`, import.meta.url), 'utf8') }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto('http://recipe-shopping-queue.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const groups = await page.evaluate(async () => {
    const { storage:s, transfer:t, createSyncFeature, cookbookMetadata, rewriteRecipeQueue, rewriteShoppingQueueReferences } = window.test;
    const check=(condition,message)=>{if(!condition)throw new Error(message);};
    const eq=(a,b,message)=>check(JSON.stringify(a)===JSON.stringify(b),message);
    const groups=[];let books,lists,stores,actor=1,session='1:0',number=0,api,calls,events;
    const ref={value:false,privacyGeneration:0};
    const ingredient={client_key:'milk',name:'Milch',quantity_value:2,quantity_unit:'l',quantity_text:null,note:'Kalt'};
    const recipe={id:20,cookbook_id:10,title:'Recipe',revision:1,base_servings:2,can_edit:true,created_by_user_id:1,client_mutation_id:'recipe-20',ingredient_groups:[{client_key:'group',name:'',ingredients:[ingredient]}],steps:[],tags:[]};
    const book=()=>({id:10,name:'Recipes',can_edit:true,can_manage:true,created_by_user_id:1,recipes:[structuredClone(recipe)]});
    const list=()=>({id:70,name:'Shopping',can_edit:true,can_manage:true,created_by_user_id:1,sections:[{id:80,shopping_list_id:70,name:'Cold'}],items:[{id:51,shopping_list_id:70,name:'Milch',quantity_value:1,quantity_unit:'l',completed:false}]});
    const selection=()=>({recipeId:20,shoppingListId:70,servings:4,ingredients:[{ingredient_client_key:'milk',section_id:80,store_ids:[90]}]});
    const response=(entry,listSnapshot=lists[0])=>({shopping_list:structuredClone(listSnapshot),client_mutation_id:entry.client_mutation_id,created_count:0,merged_count:1,source_revision:1});
    const controller=t.createRecipeShoppingTransferController({getCookbooks:()=>books,getLists:()=>lists,getStores:()=>stores,getCurrentUser:()=>({id:actor}),getSessionIdentity:()=>session,readQueue:()=>s.getAll('syncQueue'),
      commit:async build=>{const mutation=await build();return mutation?s.commitRecipeShoppingTransfer(mutation):null;},createMutationId:()=>`transfer-${++number}`});
    const sync=()=>createSyncFeature({getDb:s.getDb,dbGetAll:s.getAll,dbPut:s.put,dbClear:s.clear,getFromDB:s.get,deleteFromDB:s.remove,
      getTodos:()=>[],setTodos(){},getProjects:()=>[],setProjects(){},getSections:()=>[],setSections(){},getWorkspaces:()=>[],setWorkspaces(){},
      getCookbooks:()=>books,setCookbooks:rows=>{books=rows;},getShoppingLists:()=>lists,setShoppingLists:rows=>{lists=rows;},getShoppingStores:()=>stores,setShoppingStores:rows=>{stores=rows;},getActorId:()=>actor,
      todosApi:{},projectsApi:{},sectionsApi:{},workspacesApi:{},recipesApi:api,
      shoppingApi:{getList:async()=>structuredClone(lists[0]),updateItem:async(id,changes)=>{lists[0].items=lists[0].items.map(item=>item.id===id?{...item,...changes}:item);calls.push(['update',changes]);}},
      commitShoppingReplay:s.commitShoppingReplay,commitCookbookReplay:s.commitCookbookReplay,markCookbookMutationAttempt:s.markCookbookMutationAttempt,
      commitRecipeReplay:s.commitRecipeReplay,markRecipeMutationAttempt:s.markRecipeMutationAttempt,markRecipeShoppingTransferAttempt:s.markRecipeShoppingTransferAttempt,
      onRecipeShoppingTransferState:event=>events.push(event),renderStats(){},renderTodos(){},renderShopping(){},renderCookbooks(){}});
    const run=()=>sync().syncWithServer({wsState:'connected',syncInProgressRef:ref});
    async function reset(){actor=1;session='1:0';ref.privacyGeneration=0;books=[book()];lists=[list()];stores=[{id:90,shopping_list_id:70,name:'Store'}];calls=[];events=[];
      for(const name of ['syncQueue','cookbooks','shoppingLists','shoppingStores'])await s.clear(name);
      await s.put('cookbooks',books[0]);await s.put('shoppingLists',lists[0]);await s.put('shoppingStores',stores[0]);
      api={transferToShopping:async(id,payload)=>{calls.push(['transfer',id,structuredClone(payload)]);return response(payload);}};
    }
    await reset();const queued=await controller.transfer({...selection(),clientMutationId:'one-intent'});check(queued.status==='queued','queued status');
    await controller.transfer({...selection(),clientMutationId:'one-intent'});await controller.transfer({...selection(),clientMutationId:'double-click'});
    let queue=await s.getAll('syncQueue');check(queue.length===1,'same pending source has only one durable operation');eq((await s.get('shoppingLists',70)).items,list().items,'no optimistic merge guessed in Shopping cache');
    let pending=await controller.listPending();check(pending[0].can_cancel&&pending[0].recipe_id===20&&pending[0].status==='queued','UI pending contract');
    check(await controller.cancel('one-intent')===true&&!(await s.getAll('syncQueue')).length,'unsent intent is cancelable');
    groups.push('queue-only atomic enqueue, duplicate intent and cancel');

    check(await controller.transfer({...selection(),ingredients:[{ingredient_client_key:'milk',section_id:999,store_ids:[]}]})===null,'unknown section rejected');
    stores.push({id:91,shopping_list_id:71,name:'Foreign list'});check(await controller.transfer({...selection(),ingredients:[{ingredient_client_key:'milk',section_id:null,store_ids:[91]}]})===null,'cross-list stores rejected');
    check(await controller.transfer({...selection(),ingredients:[...selection().ingredients,...selection().ingredients]})===null,'duplicate ingredient keys rejected');
    books[0].can_edit=false;books[0].recipes[0].can_edit=false;await controller.transfer(selection());
    queue=await s.getAll('syncQueue');check(queue.length===1,'recipe read access is sufficient; target requires edit');
    const readSnapshot=cookbookMetadata.reconcileSnapshot(books,books,queue,{actorId:1});check(!readSnapshot.queueDeleteIds.includes(queue[0].id),'read-only recipe snapshot retains copy intent');
    await controller.cancel(queue[0].data.client_mutation_id);groups.push('known typed targets and source read permission');

    await reset();await controller.transfer(selection());let applied=0,attempts=[];
    const receipt={...lists[0],items:[{...lists[0].items[0],quantity_value:5}]};
    api.transferToShopping=async(id,payload)=>{attempts.push(structuredClone(payload));if(!applied++){throw Object.assign(new Error('lost reply after atomic merge'),{status:503});}return response(payload,receipt);};
    await run();queue=await s.getAll('syncQueue');check(queue[0].attempted===true,'attempt marker durable before retry');check(await controller.cancel(queue[0].data.client_mutation_id)===false,'ambiguous attempted request cannot be canceled as Undo');
    eq(rewriteRecipeQueue(queue,{from:20,to:200})[0].data,queue[0].data,'attempted body cannot be rewritten');
    await run();eq(attempts[0],attempts[1],'retry body remains exact');check(!(await s.getAll('syncQueue')).length&&lists[0].items[0].quantity_value===5,'idempotent receipt replaces one authoritative merge');
    check(events.at(-1).status==='complete','completion receipt surfaced');groups.push('immutable attempts and lost-response idempotent receipt');

    await reset();await controller.transfer(selection());let conflicts=0;api.transferToShopping=async()=>{conflicts++;throw Object.assign(new Error('revision'),{status:409,code:'recipe.revisionConflict'});};
    await run();await run();check(conflicts===1,'durably blocked revision conflict never auto-retries');pending=await controller.listPending();check(pending[0].status==='blocked'&&pending[0].can_cancel,'blocked conflict can be explicitly canceled');
    await s.put('syncQueue',{action:'UPDATE_SHOPPING_ITEM',data:{shopping_list_id:70,item_id:51,changes:{name:'Other local edit',quantity_text:'nach Bedarf',note:'new note'}}});
    await run();check(calls.some(call=>call[0]==='update'&&call[1].quantity_text==='nach Bedarf'&&call[1].note==='new note'),'blocked transfer does not freeze later Shopping writes or strip shared fields');
    check(await controller.cancel(pending[0].client_mutation_id)===true,'cancel blocked conflict');groups.push('persistent conflict, explicit cancellation and unrelated Shopping progress');

    await reset();await controller.transfer(selection());const invalidTargetData=structuredClone((await s.getAll('syncQueue'))[0].data);let invalidAttempts=0;
    api.transferToShopping=async()=>{invalidAttempts++;throw Object.assign(new Error('Store is no longer active'),{status:400});};
    await run();await run();queue=await s.getAll('syncQueue');
    check(invalidAttempts===1&&queue.length===1&&queue[0].blocked?.status===400,'invalid target remains durably blocked and is not retried');
    eq(queue[0].data,invalidTargetData,'invalid target preserves immutable intent instead of generic recovery deletion');
    await s.put('syncQueue',{action:'UPDATE_SHOPPING_ITEM',data:{shopping_list_id:70,item_id:51,changes:{name:'Independent change'}}});await run();
    check(calls.some(call=>call[0]==='update')&&(await s.getAll('syncQueue')).length===1,'invalid transfer permits subsequent Shopping edits');
    pending=await controller.listPending();check(pending[0].can_cancel&&await controller.cancel(pending[0].client_mutation_id),'invalid target is explicitly cancelable');
    groups.push('400 target invalidation stays blocked without losing intent');

    await reset();
    for(const merge_group of ['', ' ', 123, 'x'.repeat(201)]) check(await controller.transfer({...selection(),ingredients:[{...selection().ingredients[0],merge_group}]})===null,'invalid merge group rejected before enqueue');
    await controller.transfer({...selection(),ingredients:[{...selection().ingredients[0],merge_group:'chosen-same-product'}]});
    const groupedIntent=(await s.getAll('syncQueue'))[0];
    check(groupedIntent.data.ingredients[0].merge_group==='chosen-same-product','explicit combination retained in durable intent');
    const groupedReload=t.sanitizeRecipeShoppingTransfer(JSON.parse(JSON.stringify(groupedIntent)));
    check(t.recipeShoppingTransferPayload(groupedReload).ingredients[0].merge_group==='chosen-same-product','combination survives serialization and API sanitization');
    const groupedRemap=t.rewriteRecipeShoppingTransfer(groupedReload,{listIdFrom:70,listIdTo:71,sectionIdFrom:80,sectionIdTo:81,storeIdFrom:90,storeIdTo:91});
    check(groupedRemap.data.ingredients[0].merge_group==='chosen-same-product'&&groupedRemap.data.ingredients[0].section_id===81,'combination survives temporary target remapping');
    const groupedAttempts=[];let groupLost=false;
    api.transferToShopping=async(_id,payload)=>{groupedAttempts.push(structuredClone(payload));if(!groupLost){groupLost=true;throw Object.assign(new Error('lost grouped reply'),{status:503});}return response(payload);};
    await run();await run();eq(groupedAttempts[0],groupedAttempts[1],'grouped lost-response replay keeps identical request body');
    check(groupedAttempts[0].ingredients[0].merge_group==='chosen-same-product'&&!(await s.getAll('syncQueue')).length,'confirmed grouped replay clears its intent');
    groups.push('explicit combination persists through reload, remapping and uncertain replay');

    await reset();await s.put('syncQueue',{id:100,action:'CREATE_RECIPE',actor_id:1,data:{temp_id:'temp-recipe',cookbook_id:'temp-book',client_mutation_id:'source-write'}});
    books=[{...book(),id:'temp-book',client_mutation_id:'temp-book',recipes:[{...recipe,id:'temp-recipe',cookbook_id:'temp-book',revision:0}]}];
    lists=[{...list(),id:'temp-list',sections:[{id:'temp-section',shopping_list_id:'temp-list'}]}];stores=[{id:'temp-store',shopping_list_id:'temp-list'}];
    await controller.transfer({recipeId:'temp-recipe',shoppingListId:'temp-list',servings:4,ingredients:[{ingredient_client_key:'milk',section_id:'temp-section',store_ids:['temp-store']}]});
    queue=await s.getAll('syncQueue');let intent=queue.find(t.isRecipeShoppingTransfer);check(intent.data.source_mutation_id==='source-write'&&intent.data.expected_revision===0,'pending source receipt identity captured');
    let rewritten=rewriteRecipeQueue(queue,{from:'temp-book',to:10,cookbook:true});rewritten=rewriteRecipeQueue(rewritten,{from:'temp-recipe',to:20});
    rewritten=rewriteShoppingQueueReferences(rewritten,{listIdFrom:'temp-list',listIdTo:70,sectionIdFrom:'temp-section',sectionIdTo:80,storeIdFrom:'temp-store',storeIdTo:90});
    intent=rewritten.find(t.isRecipeShoppingTransfer);check(intent.data.recipe_id===20&&intent.data.cookbook_id===10&&intent.data.shopping_list_id===70,'source/target parent IDs remap');eq(intent.data.ingredients,[{ingredient_client_key:'milk',section_id:80,store_ids:[90]}],'typed nested section/store IDs remap');
    check(t.transferHasPendingDependencies(intent,rewritten),'earlier source write remains a dependency');
    books=[book()];lists=[list()];stores=[{id:90,shopping_list_id:70}];await s.commitShoppingReplay({queueRecords:[intent],queueDeleteIds:[100]});await run();check(!(await s.getAll('syncQueue')).length,'canonical remapped operation can replay after dependencies settle');
    groups.push('source receipt and all typed temporary target remaps');

    await reset();await controller.transfer(selection());queue=await s.getAll('syncQueue');await s.evictPendingCookbookEntities([10]);check(!(await s.getAll('syncQueue')).length,'source access eviction purges queued private intent');check((await s.get('shoppingLists',70)).items.length===1,'source revocation preserves independent target list');
    await reset();await controller.transfer(selection());await s.evictPendingShoppingEntities([70]);check(!(await s.getAll('syncQueue')).length&&(await s.get('cookbooks',10)).recipes.length===1,'target revocation purges transfer without recipe loss');
    await reset();await controller.transfer(selection());queue=await s.getAll('syncQueue');const revoked=cookbookMetadata.reconcileSnapshot([],books,queue,{actorId:1});await s.commitCookbookReplay(revoked);check(!(await s.getAll('syncQueue')).length,'full source snapshot revokes queue atomically');
    groups.push('source and target revocation are independently scoped');

    await reset();await controller.transfer(selection());let release,started;const entered=new Promise(done=>{started=done;});const held=new Promise(done=>{release=done;});
    api.transferToShopping=async(_id,payload)=>{started();await held;return response(payload,{...list(),name:'Old response'});};const old=run();await entered;
    await s.evictPendingCookbookEntities([10]);ref.privacyGeneration++;actor=2;session='2:next';lists=[{...list(),name:'New account state'}];await s.put('shoppingLists',lists[0]);release();await old;
    check((await s.get('shoppingLists',70)).name==='New account state'&&events.length===0,'late receipt cannot publish to a new actor/generation');
    const before=await s.get('shoppingLists',70);check(await s.commitShoppingReplay({list:{...before,name:'Forbidden'},requireQueueId:999999})===false,'missing queue receipt is a durable no-op');eq(await s.get('shoppingLists',70),before,'missing receipt cannot resurrect state');
    groups.push('privacy/actor and transactional queue-presence receipt fences');

    await reset();await controller.transfer(selection());await s.put('syncQueue',{action:'DELETE_RECIPE',actor_id:1,data:{id:20,cookbook_id:10,expected_revision:1,client_mutation_id:'later-delete'}});books[0].recipes=[];
    api.transferToShopping=async(_id,payload)=>{calls.push(['transfer']);return response(payload);};api.deleteRecipe=async()=>{calls.push(['source-delete']);return{id:20,cookbook_id:10,deleted:true,applied_revision:1};};
    await run();eq(calls.map(call=>call[0]),['transfer','source-delete'],'later optimistic source deletion does not erase an already intended copy');
    groups.push('source mutation ordering preserves earlier confirmed copy intent');

    await reset();books[0].id='temp-source-book';books[0].client_mutation_id='temp-source-book';books[0].recipes[0].cookbook_id=books[0].id;books[0].recipes[0].id='temp-source-recipe';books[0].recipes[0].revision=0;
    await s.put('cookbooks',books[0]);await s.put('syncQueue',{action:'CREATE_COOKBOOK',data:{temp_id:books[0].id,name:'Pending source',client_mutation_id:books[0].id}});
    await s.put('syncQueue',{action:'CREATE_RECIPE',actor_id:1,data:{temp_id:'temp-source-recipe',cookbook_id:books[0].id,client_mutation_id:'pending-source-recipe'}});
    await controller.transfer({...selection(),recipeId:'temp-source-recipe'});queue=await s.getAll('syncQueue');let deletionError;
    try{await s.commitCookbookMutation({deleteCookbookId:books[0].id,action:'DELETE_COOKBOOK',data:{id:books[0].id}});}catch(error){deletionError=error;}
    check(deletionError?.code==='recipe.transfer.pendingSource','whole cookbook deletion has explicit pending-transfer guard');
    eq(await s.getAll('syncQueue'),queue,'guard atomically preserves parent and transfer queue');check((await s.get('cookbooks',books[0].id)).recipes.length===1,'guard preserves source cache');
    await controller.cancel(queue.find(t.isRecipeShoppingTransfer).data.client_mutation_id);
    await s.commitCookbookMutation({deleteCookbookId:books[0].id,action:'DELETE_COOKBOOK',data:{id:books[0].id}});
    check(!(await s.get('cookbooks',books[0].id))&&!(await s.getAll('syncQueue')).length,'explicit cancellation permits normal unsent parent deletion');
    groups.push('atomic pending whole-cookbook deletion guard');

    await reset();books[0].recipes[0].title='Snapshot to copy';
    await s.commitRecipeMutation({cookbook:books[0],recipe:books[0].recipes[0],action:'UPDATE_RECIPE',actor_id:1,
      data:{id:20,cookbook_id:10,changes:{title:'Snapshot to copy'},expected_revision:1,client_mutation_id:'sealed-source'}});
    await controller.transfer(selection());books[0].recipes[0].title='Later edit';
    await s.commitRecipeMutation({cookbook:books[0],recipe:books[0].recipes[0],action:'UPDATE_RECIPE',actor_id:1,
      data:{id:20,cookbook_id:10,changes:{title:'Later edit'},expected_revision:1,client_mutation_id:'later-source'}});
    queue=await s.getAll('syncQueue');check(queue.length===3&&queue[0].data.changes.title==='Snapshot to copy','transfer source mutation sealed before HTTP');
    let transferAttempts=0;api.updateRecipe=async(_id,payload)=>{calls.push(['source-update',payload.changes?.title??payload.title]);return{...recipe,title:payload.title,revision:payload.expected_revision+1,applied_revision:payload.expected_revision+1};};
    api.transferToShopping=async(_id,payload)=>{calls.push(['transfer']);if(!transferAttempts++)throw Object.assign(new Error('temporary'),{status:503});return response(payload);};
    await run();eq(calls.map(call=>call[0]),['source-update','transfer'],'later source write cannot overtake temporarily failed copy');
    await run();eq(calls.map(call=>call[0]),['source-update','transfer','transfer','source-update'],'later source write continues after durable copy receipt');
    check(!(await s.getAll('syncQueue')).length,'source-write/copy sequence fully settles');
    groups.push('sealed pending source snapshot and transient predecessor ordering');

    await reset();await controller.transfer(selection());api.transferToShopping=async()=>{throw Object.assign(new Error('lost receipt'),{status:503});};await run();
    books[0].recipes=[];queue=await s.getAll('syncQueue');const deletedSource=cookbookMetadata.reconcileSnapshot(books,books,queue,{actorId:1});
    check(!deletedSource.queueDeleteIds.includes(queue[0].id),'ambiguous copy survives source recipe deletion while book remains readable');
    api.transferToShopping=async(_id,payload)=>response(payload);await run();check(!(await s.getAll('syncQueue')).length,'attempted receipt can replay after source deletion');
    groups.push('attempted copy receipt remains replayable after recipe deletion');

    await reset();await s.put('syncQueue',{id:200,action:t.TRANSFER_RECIPE_TO_SHOPPING,actor_id:2,data:{recipe_id:20,cookbook_id:10,shopping_list_id:70,servings:2,expected_revision:1,client_mutation_id:'foreign',ingredients:selection().ingredients}});
    await controller.transfer(selection());await run();queue=await s.getAll('syncQueue');check(queue.length===1&&queue[0].actor_id===2,'foreign actor row neither dispatches nor gets dropped');check(calls.filter(call=>call[0]==='transfer').length===1,'foreign row cannot block current actor transfer');
    groups.push('foreign actor isolation and current actor progress');
    return groups;
  });
  assert.equal(groups.length,14);for(const group of groups)console.log(`PASS ${group}`);
} finally { await browser.close(); }
