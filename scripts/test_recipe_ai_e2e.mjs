#!/usr/bin/env node
// Disposable full app; only external LLM transport is replaced with a fixture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startPrivateApp } from './private_app_test_server.mjs';
import { waitForPageCondition } from './browser_page_condition.mjs';

const rawRecipe='Crêpes pour quatre personnes. 200 g de farine et 100 ml d’eau. Mélanger 100 g de farine avec l’eau, puis ajouter les 100 g restants.';
const sourceUrl='https://public.example/family-crepes';
const preamble=`
import copy, pathlib, sqlite3
from services import ai_access, llm_client
from routers import braindump_v2
_private_root=pathlib.Path(os.environ['NIA_TODO_DATA_DIR']).resolve()
assert str(_private_root).startswith('/tmp/nia-recipe-ai-e2e-')
_control=_private_root/'provider-control.json'
_events=_private_root/'provider-events.json'
_fixture_config={'enabled':True,'llm_provider':'openai_compatible','llm_model':'private-recipe-fixture','llm_base_url':'https://provider.example.invalid/v1','llm_api_key':'','llm_extra_headers_json':'','llm_timeout_seconds':10}
def _config(**kwargs): return dict(_fixture_config)
ai_access.get_braindump_config=_config
braindump_v2.get_braindump_config=_config
def _post(payload, headers, config):
    data=json.loads(payload['messages'][1]['content'])
    count=json.loads(_events.read_text())['calls'] if _events.exists() else 0
    _events.write_text(json.dumps({'calls':count+1}))
    if data['mode']=='text':
        recipe={'title':'Crêpes familiales','description':'Recette pour quatre personnes.','base_servings':4,'prep_minutes':None,'cook_minutes':None,'tags':[],
          'ingredient_groups':[{'client_key':'group-main','name':'Pâte','ingredients':[
            {'client_key':'flour','name':'Farine','quantity_value':200,'quantity_unit':'g','quantity_text':None,'note':''},
            {'client_key':'water','name':'Eau','quantity_value':100,'quantity_unit':'ml','quantity_text':None,'note':''}]}],
          'steps':[{'client_key':'step-mix','text':'Mélanger 100 g de farine avec l’eau.','ingredients':[]},{'client_key':'step-rest','text':'Ajouter les 100 g de farine restants.','ingredients':[]}]}
    else:
        recipe=copy.deepcopy(data['recipe_data'])
        keys=[ingredient['client_key'] for group in recipe['ingredient_groups'] for ingredient in group['ingredients']]
        recipe['steps'][0]['ingredients']=[{'ingredient_client_key':keys[0],'show_quantity':True,'quantity_value':100,'quantity_text':None},{'ingredient_client_key':keys[1],'show_quantity':True,'quantity_value':100,'quantity_text':None}]
        recipe['steps'][1]['ingredients']=[{'ingredient_client_key':keys[0],'show_quantity':True,'quantity_value':100,'quantity_text':None}]
        recipe['steps'][0]['text']+=' Mélanger soigneusement.'
    if _control.exists() and json.loads(_control.read_text()).get('revoke'):
        database=_private_root/'e2e.db'
        assert database.parent==_private_root and not database.is_symlink()
        with sqlite3.connect(database) as db: db.execute('UPDATE users SET braindump_enabled=0')
    return {'choices':[{'message':{'content':json.dumps(recipe,ensure_ascii=False)},'finish_reason':'stop'}],'usage':{'prompt_tokens':1,'completion_tokens':1}}
llm_client.post_chat=_post
`;
let app,client,phase='starting disposable app';
try{
  app=await startPrivateApp({name:'recipe-ai',pythonPreamble:preamble});
  process.env.NIA_TODO_URL=app.base;process.env.NIA_TODO_DEV_DIR=app.root;process.env.NIA_TODO_DATA_DIR=app.privateDir;
  process.env.NIA_TODO_DB_NAME='e2e.db';process.env.NIA_TODO_TEST_ISOLATED_NETWORK='1';
  const {launchPage,USERNAME,USER_PASSWORD,ADMIN_PASSWORD,BASE_URL,APP_PYTHON}=await import('./frontend_test_lib.mjs');
  assert.equal(BASE_URL,app.base);
  async function setup(path,body){const response=await fetch(app.base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':app.setupToken},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);}
  await setup('/api/setup/admin',{admin_password:ADMIN_PASSWORD});
  await setup('/api/setup/first-user',{username:USERNAME,password:USER_PASSWORD,email:'recipe-ai@example.invalid',display_name:'Disposable recipe fixture'});
  const anonymous=await fetch(app.base+'/api/recipes/ai-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:rawRecipe})});
  assert([401,403].includes(anonymous.status));
  const calls=async()=>{try{return JSON.parse(await readFile(join(app.privateDir,'provider-events.json'),'utf8')).calls;}catch{return 0;}};
  function setPermission(enabled){
    execFileSync(APP_PYTHON,['-c',`import pathlib,sqlite3,sys
root=pathlib.Path(sys.argv[1]).resolve();path=root/'e2e.db'
assert str(root).startswith('/tmp/nia-recipe-ai-e2e-') and path.parent==root and path.is_file() and not path.is_symlink()
with sqlite3.connect(path) as db:
 assert db.execute('SELECT MAX(version) FROM schema_version').fetchone()[0]==71
 assert db.execute('SELECT COUNT(*) FROM users WHERE username=?',(sys.argv[2],)).fetchone()[0]==1
 db.execute('UPDATE users SET braindump_enabled=? WHERE username=?',(int(sys.argv[3]),sys.argv[2]))
`,app.privateDir,USERNAME,enabled?'1':'0'],{stdio:['ignore','ignore','pipe']});
  }
  client=await launchPage({serviceWorkers:'allow'});const {page}=client;
  await page.context().route('**/*',route=>new URL(route.request().url()).origin===app.base?route.continue():route.abort('blockedbyclient'));
  const requests=[];page.context().on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/recipes/ai-preview')requests.push(request.postDataJSON());});
  await client.loginApp();
  const poll=(fn,arg)=>waitForPageCondition(page,fn,arg,{timeout:30000});
  const queueEmpty=()=>poll(async()=>typeof window.dbGetAll==='function'&&!(await window.dbGetAll('syncQueue')).length);
  const headers=await page.evaluate(async()=>(await import('/static/js/api/http.js')).getAuthHeaders());
  const body=JSON.stringify({text:rawRecipe});
  phase='disabled permission and CSRF enforcement';
  const disabled=await fetch(app.base+'/api/recipes/ai-preview',{method:'POST',headers,body});assert.equal(disabled.status,403);assert.equal(await calls(),0);
  const withoutCsrf={...headers};delete withoutCsrf['X-CSRF-Token'];
  assert.equal((await fetch(app.base+'/api/me',{headers:withoutCsrf})).status,200);
  assert.equal((await fetch(app.base+'/api/recipes/ai-preview',{method:'POST',headers:withoutCsrf,body})).status,403);assert.equal(await calls(),0);
  const book=await page.evaluate(async()=>(await import('/static/js/api/recipes.js')).recipesApi.createCookbook({name:'Recipe AI fixture',client_mutation_id:'recipe-ai-e2e-book'}));
  await poll(async id=>typeof window.dbGetAll==='function'&&(await window.dbGetAll('cookbooks')).some(book=>book.id===id),book.id);
  async function selectBook(){
    if(!await page.locator('[data-module-panel="recipes"][data-module-slot="main"]').isVisible()){
      await page.click('#module-switcher-button');await page.click('[data-module-action="select"][data-module-id="recipes"]');
    }
    await page.locator(`#cookbook-sidebar [data-entity-sidebar-action="select"][data-entity-id="${book.id}"]`).click();
  }
  await selectBook();await page.locator('[data-recipe-action="import"]').click();
  assert.equal(await page.locator('#recipe-import-mode').isVisible(),false,'ordinary URL import is available without BrainDump');
  await page.locator('#recipe-import-modal .modal-close-x').click();
  await page.locator('#recipe-import-modal').waitFor({state:'hidden'});
  setPermission(true);await page.reload({waitUntil:'domcontentloaded'});await page.locator('#login-overlay').waitFor({state:'hidden'});await selectBook();
  phase='text creates only an unsaved draft';
  await page.locator('[data-recipe-action="import"]').click();await page.locator('#recipe-import-mode').waitFor({state:'visible'});
  await page.locator('[data-recipe-import-mode="text"]').click();await page.fill('#recipe-import-text',rawRecipe);await page.locator('#recipe-import-save-btn').click();
  await page.locator('#recipe-modal.active').waitFor({timeout:30000});
  assert.equal(await page.locator('#recipe-id').inputValue(),'');assert.equal(await calls(),1);
  const serverRecipes=()=>page.evaluate(async id=>(await (await import('/static/js/api/recipes.js')).recipesApi.getCookbook(id)).recipes,book.id);
  assert.equal((await serverRecipes()).length,0);
  await page.locator('.recipe-editor-source>summary').click();await page.fill('#recipe-source-url',sourceUrl);await page.fill('#recipe-source-author','Source fixture');await page.locator('.recipe-editor-source>summary').click();
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=100;canvas.height=60;canvas.getContext('2d').fillRect(0,0,100,60);return canvas.toDataURL('image/png').split(',')[1];});
  await page.locator('#recipe-image-file').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.locator('#recipe-image-preview').waitFor({state:'visible'});
  const originalImage=await page.locator('#recipe-image-preview-img').getAttribute('src');
  phase='refine current unsaved draft and retain source/image';
  await page.locator('#recipe-ai-refine-btn').click();await poll(()=>!document.getElementById('recipe-ai-refine-btn').disabled);
  assert.equal(await calls(),2);assert.equal((await serverRecipes()).length,0);
  assert.equal(await page.locator('#recipe-source-url').inputValue(),sourceUrl);assert.equal(await page.locator('#recipe-source-author').inputValue(),'Source fixture');
  assert.equal(await page.locator('#recipe-image-preview-img').getAttribute('src'),originalImage);
  assert.equal(requests[1].draft.image_data,undefined,'actual provider request never contains the image');
  assert.equal(await page.locator('#recipe-import-review').isVisible(),true);
  const screenshots=process.env.NIA_RECIPE_AI_SCREENSHOTS_DIR;
  if(screenshots){await mkdir(screenshots,{recursive:true});await page.screenshot({path:join(screenshots,'nia-recipe-ai-editor-desktop.png')});}
  await page.locator('#recipe-save-btn').click();await page.locator('#recipe-modal').waitFor({state:'hidden'});await queueEmpty();
  let stored=(await serverRecipes())[0];assert.equal(stored.source_url,sourceUrl);assert.match(stored.image_url,/^\/api\/recipes\/recipes\/\d+\/image/);
  assert.deepEqual(stored.steps.map(step=>step.ingredients.map(link=>link.quantity_value)),[[100,100],[100]]);
  phase='reload and refine the existing recipe without duplication';
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('.recipe-reading').waitFor();
  const id=stored.id,revision=stored.revision;
  await page.locator('[data-recipe-action="edit"]').click();await page.locator('#recipe-ai-refine-btn').click();await poll(()=>!document.getElementById('recipe-ai-refine-btn').disabled);
  assert.equal(await calls(),3);assert.equal(await page.locator('#recipe-id').inputValue(),String(id));
  assert(!('id'in requests[2].draft.ingredient_groups[0]));assert(!('id'in requests[2].draft.ingredient_groups[0].ingredients[0]));assert(!('id'in requests[2].draft.steps[0]));
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  if(screenshots)await page.screenshot({path:join(screenshots,'nia-recipe-ai-editor-mobile.png')});
  await poll(()=>navigator.serviceWorker?.controller?.state==='activated');
  await page.context().setOffline(true);await poll(()=>navigator.onLine===false);
  await page.locator('#recipe-save-btn').click();await page.locator('#recipe-modal').waitFor({state:'hidden'});
  const pending=await poll(async()=>(await window.dbGetAll('syncQueue')).find(item=>item.action==='UPDATE_RECIPE'));
  assert.equal(pending.data.id,id);assert.equal(pending.data.expected_revision,revision);
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('#login-overlay').waitFor({state:'hidden'});
  await poll(async()=>typeof window.dbGetAll==='function'&&(await window.dbGetAll('syncQueue')).some(item=>item.action==='UPDATE_RECIPE'));
  await page.context().setOffline(false);await queueEmpty();
  const all=await serverRecipes();assert.equal(all.length,1);stored=all[0];assert.equal(stored.id,id);assert.equal(stored.revision,revision+1);assert.equal(stored.source_url,sourceUrl);
  assert.deepEqual(stored.steps.map(step=>step.ingredients.map(link=>link.quantity_value)),[[100,100],[100]]);
  phase='revocation during provider inference wins';
  await writeFile(join(app.privateDir,'provider-control.json'),JSON.stringify({revoke:true}));
  const revoked=await page.evaluate(async text=>{const headers=(await import('/static/js/api/http.js')).getAuthHeaders();const response=await fetch('/api/recipes/ai-preview',{method:'POST',headers,body:JSON.stringify({text})});return{status:response.status,body:await response.json()};},rawRecipe);
  assert.equal(revoked.status,403);assert.equal(revoked.body.detail.code,'recipe.ai.unavailable');assert.equal(await calls(),4);
  assert.equal((await serverRecipes()).length,1,'revoked previews never save a recipe');
  assert.deepEqual(client.pageErrors,[]);
  console.log('PASS private real-app BrainDump permissions/CSRF, text/refine, source/image/partial links, existing identity, offline reload/reconnect and post-inference revocation');
}catch(error){console.error(`Recipe BrainDump E2E failed during: ${phase}`);throw error;}
finally{try{await client?.browser.close();}finally{await app?.stop();}}
