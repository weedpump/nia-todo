#!/usr/bin/env python3
"""Mock-only recipe BrainDump regression suite; no database/service/provider use."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from routers import recipe_import as router
from routers.auth import require_auth
from services import recipe_ai as ai

CONFIG = {'llm_provider':'openai_compatible', 'llm_base_url':'https://provider.invalid/v1',
          'llm_model':'test-model', 'llm_api_key':'not-a-real-key', 'llm_timeout_seconds':180}


def draft():
    return {'title':'Familienkuchen','description':'Originalbeschreibung','base_servings':4,
            'prep_minutes':10,'cook_minutes':20,'tags':['Familie'],
            'source_url':'https://example.com/kuchen','source_name':'Family Kitchen',
            'source_author':'Original Author','source_yield':'4 Portionen',
            'ingredient_groups':[
                {'client_key':'dough','name':'Teig','ingredients':[
                    {'client_key':'dough-flour','name':'Mehl','quantity_value':250,'quantity_unit':'g','quantity_text':None,'note':'gesiebt'},
                    {'client_key':'raw','name':'½ Packung Backpulver','quantity_value':None,'quantity_unit':None,'quantity_text':None,'note':''}]},
                {'client_key':'filling','name':'Füllung','ingredients':[
                    {'client_key':'filling-flour','name':'Mehl','quantity_value':50,'quantity_unit':'g','quantity_text':None,'note':''}]}],
            'steps':[
                {'client_key':'mix','text':'Teig mischen.','ingredients':[{'ingredient_client_key':'dough-flour','show_quantity':True,'quantity_value':100,'quantity_text':None}]},
                {'client_key':'fill','text':'Füllung herstellen.','ingredients':[]}]}


def proposal(value=None):
    return {key:copy.deepcopy(item) for key,item in (value or draft()).items() if key in ai.CONTENT_FIELDS}


def response(value):
    return {'choices':[{'message':{'content':json.dumps(value,ensure_ascii=False)},'finish_reason':'stop'}]}


class RecipeAITests(unittest.TestCase):
    def test_refinement_preserves_numeric_facts_metadata_membership_and_explicit_links(self):
        original=draft(); before=copy.deepcopy(original)
        proposed={'ingredients':[{'ingredient_key':'i2','name':'Backpulver','quantity_value':.5,'quantity_unit':'pack'}],
                  'steps':[{'step_key':'s1','ingredients':[]},
                           {'step_key':'s2','ingredients':[{'ingredient_key':'i3','show_quantity':True}]}]}
        with patch.object(ai.llm_client,'post_chat',return_value=response(proposed)) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        actual=result['draft']
        self.assertEqual(original,before,'analysis must not mutate the caller draft')
        for key in ('title','description','base_servings','prep_minutes','cook_minutes','tags',*ai.SOURCE_FIELDS):self.assertEqual(actual[key],original[key])
        self.assertEqual(actual['ingredient_groups'][0]['name'],'Teig')
        self.assertEqual(actual['ingredient_groups'][0]['ingredients'][0],original['ingredient_groups'][0]['ingredients'][0])
        self.assertEqual(actual['ingredient_groups'][0]['ingredients'][1]['quantity_value'],.5)
        self.assertEqual(actual['steps'][0]['ingredients'],original['steps'][0]['ingredients'])
        self.assertEqual(actual['steps'][1]['ingredients'][0]['ingredient_client_key'],'filling-flour')
        self.assertIn('recipe.ai.reviewQuantities',result['warnings'])
        sent=send.call_args.args[0]
        self.assertEqual(sent['messages'][0]['content'],ai.RECIPE_SYSTEM_PROMPT)
        self.assertNotIn('source_url',sent['messages'][1]['content'],'provenance is not model-editable or necessary prompt data')
        context=json.loads(sent['messages'][1]['content'])['recipe_data']
        self.assertEqual(context['ingredient_groups'][0]['client_key'],'g1')
        self.assertEqual(context['steps'][0]['ingredients'][0]['ingredient_client_key'],'i1')
        self.assertNotIn('_deadline_at',sent,'private transport deadlines are not sent to the provider')
        self.assertLessEqual(send.call_args.args[2]['llm_timeout_seconds'],100)

    def test_references_cannot_be_added_duplicated_or_used_to_rewrite_protected_facts(self):
        cases=[{'steps':[{'step_key':'s99','ingredients':[]}]},
               {'steps':[{'step_key':'s1'},{'step_key':'s1'}]},
               {'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i99'}]}]},
               {'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i1'},{'ingredient_key':'i1'}]}]},
               {'ingredients':[{'ingredient_key':'i1','name':'Invented wheat','quantity_value':1}]},
               {'ingredients':[{'ingredient_key':'i2','name':'Backpulver'},{'ingredient_key':'i2','name':'Again'}]},
               {'steps':[],'title':'Invented title'},
               proposal()]
        for value in cases:
            with self.subTest(value=value),patch.object(ai.llm_client,'post_chat',return_value=response(value)),self.assertRaises(ai.RecipeAIError) as error:
                ai.build_recipe_preview(config=CONFIG,draft=draft())
            self.assertEqual(error.exception.code,'recipe.ai.invalidResponse')
            self.assertIn(error.exception.reason,{'schema','reference'})

    def test_imported_uuid_keys_and_long_steps_need_only_a_small_partial_patch(self):
        original=draft()
        original['steps']=[]
        original['ingredient_groups']=[{'client_key':'import-00000000-0000-4000-8000-000000000001','name':'Teig','ingredients':[]},
                                       {'client_key':'import-00000000-0000-4000-8000-000000000002','name':'Füllung','ingredients':[]}]
        for index in range(22):
            original['ingredient_groups'][index//11]['ingredients'].append({'client_key':f'import-12345678-1234-4123-8123-{index:012d}',
                'name':'Mehl' if index in (0,11) else f'Zutat {index}','quantity_value':50+index,'quantity_unit':'g','quantity_text':None,'note':''})
        for index in range(7):
            original['steps'].append({'client_key':f'import-87654321-4321-4321-8432-{index:012d}','text':(f'Schritt {index}. '+('Unveränderte ausführliche Zubereitung. '*45)).rstrip(),'ingredients':[]})
        proposed={'steps':[{'step_key':'s2','ingredients':[{'ingredient_key':'i12','show_quantity':True,'quantity_value':25}]}]}
        with patch.object(ai.llm_client,'post_chat',return_value=response(proposed)) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        actual=result['draft']
        self.assertEqual(actual['ingredient_groups'],original['ingredient_groups'])
        for index in (0,2,3,4,5,6):self.assertEqual(actual['steps'][index],original['steps'][index])
        self.assertEqual(actual['steps'][1]['text'],original['steps'][1]['text'])
        self.assertEqual(actual['steps'][1]['client_key'],original['steps'][1]['client_key'])
        self.assertEqual(actual['steps'][1]['ingredients'][0]['ingredient_client_key'],original['ingredient_groups'][1]['ingredients'][0]['client_key'])
        self.assertEqual(actual['steps'][1]['ingredients'][0]['quantity_value'],25)
        self.assertIn('recipe.ai.reviewAssignments',result['warnings'])
        context=send.call_args.args[0]['messages'][1]['content']
        self.assertNotIn('import-',context,'provider never needs to reproduce imported UUIDs')
        self.assertLess(len(json.dumps(proposed)),len(json.dumps(original))//20)

    def test_raw_ingredient_structuring_preserves_existing_notes(self):
        original=draft();original['ingredient_groups'][0]['ingredients'][1]['note']='Unveränderte eigene Notiz'
        value={'ingredients':[{'ingredient_key':'i2','name':'Backpulver','quantity_value':.5,'quantity_unit':'pack','note':None}]}
        with patch.object(ai.llm_client,'post_chat',return_value=response(value)):
            actual=ai.build_recipe_preview(config=CONFIG,draft=original)['draft']
        self.assertEqual(actual['ingredient_groups'][0]['ingredients'][1]['note'],'Unveränderte eigene Notiz')
        self.assertEqual(actual['ingredient_groups'][0]['ingredients'][1]['quantity_value'],.5)

    def test_partial_patch_text_only_empty_patches_and_final_quantity_validation(self):
        for value in ({}, {'steps':[]}, {'steps':[{'step_key':'s2','text':'Füllung vorsichtig mischen.'}]}):
            with self.subTest(value=value),patch.object(ai.llm_client,'post_chat',return_value=response(value)):
                result=ai.build_recipe_preview(config=CONFIG,draft=draft())
            self.assertEqual(result['draft']['steps'][0],draft()['steps'][0])
        cases=[{'steps':[{'step_key':'s2','ingredients':[{'ingredient_key':'i3','quantity_value':51}]}]},
               {'steps':[{'step_key':'s2','ingredients':[{'ingredient_key':'i3','quantity_value':10,'quantity_text':'etwas'}]}]},
               {'steps':[{'step_key':'s2','ingredients':[{'ingredient_key':'i3','show_quantity':False,'quantity_value':10}]}]},
               {'steps':[{'step_key':'s2','text':'   '}]},
               {'steps':[{'step_key':'s2','ingredients':[{'ingredient_key':'i3','quantity_value':'10'}]}]},
               {'steps':[{'step_key':'s2','ingredients':[{'ingredient_key':'i3','id':42}]}]}]
        for value in cases:
            with self.subTest(value=value),patch.object(ai.llm_client,'post_chat',return_value=response(value)),self.assertRaises(ai.RecipeAIError) as error:
                ai.build_recipe_preview(config=CONFIG,draft=draft())
            self.assertEqual(error.exception.reason,'schema')

    def test_malformed_and_unsafe_response_is_rejected(self):
        cases=['not json','[]','{"title":"a","title":"b"}','{"title":"x","base_servings":NaN}',json.dumps({**proposal(),'source_url':'https://attacker.invalid/'}),json.dumps({**proposal(),'id':123})]
        child_extra=proposal();child_extra['ingredient_groups'][0]['ingredients'][0]['id']=23;cases.append(json.dumps(child_extra))
        outofbounds=proposal();outofbounds['steps'][1]['ingredients']=[{'ingredient_client_key':'filling-flour','show_quantity':True,'quantity_value':51}];cases.append(json.dumps(outofbounds))
        oversized='x'*(512*1024);cases.append(oversized)
        for content in cases:
            with self.subTest(content=content[:40]),patch.object(ai.llm_client,'post_chat',return_value={'choices':[{'message':{'content':content}}]}),self.assertRaises(ai.RecipeAIError):
                ai.build_recipe_preview(config=CONFIG,text='Supplied recipe')

    def test_international_text_and_no_generated_source_metadata(self):
        for title,text in [('Crêpes','Crêpes pour 4 personnes. 250 g farine. Mélanger.'),('番茄汤','番茄汤，4人份。番茄200克。煮汤。'),('Placki','Placki dla 4 osób. 250 g mąki. Wymieszaj.')]:
            data=proposal();data['title']=title
            with self.subTest(title=title),patch.object(ai.llm_client,'post_chat',return_value=response(data)):
                result=ai.build_recipe_preview(config=CONFIG,text=text)
            self.assertEqual(result['draft']['title'],title)
            self.assertTrue(all(result['draft'][key]=='' for key in ai.SOURCE_FIELDS))

    def test_model_null_optional_prose_is_normalized_without_relaxing_requests(self):
        value=proposal()
        value['description']=None
        value['tags']=None
        for group in value['ingredient_groups']:
            group['name']=None
            for ingredient in group['ingredients']:ingredient['note']=None
        with patch.object(ai.llm_client,'post_chat',return_value=response(value)):
            result=ai.build_recipe_preview(config=CONFIG,text='Original recipe text')
        self.assertEqual(result['draft']['description'],'')
        self.assertEqual(result['draft']['tags'],[])
        self.assertTrue(all(group['name']=='' for group in result['draft']['ingredient_groups']))
        self.assertTrue(all(item['note']=='' for group in result['draft']['ingredient_groups'] for item in group['ingredients']))
        self.assertIsNone(value['description'],'only parsed model output is normalized')
        invalid_request=draft();invalid_request['description']=None
        with patch.object(ai.llm_client,'post_chat') as send,self.assertRaises(ai.RecipeAIError) as error:
            ai.build_recipe_preview(config=CONFIG,draft=invalid_request)
        send.assert_not_called();self.assertEqual(error.exception.code,'recipe.ai.invalidInput')
        cases=[]
        bad_title=copy.deepcopy(value);bad_title['title']=None;cases.append(bad_title)
        bad_key=copy.deepcopy(value);bad_key['ingredient_groups'][0]['client_key']=None;cases.append(bad_key)
        bad_number=copy.deepcopy(value);bad_number['ingredient_groups'][0]['ingredients'][0]['quantity_value']='250';cases.append(bad_number)
        bad_links=copy.deepcopy(value);bad_links['steps'][0]['ingredients']=None;cases.append(bad_links)
        for invalid in cases:
            with self.subTest(invalid=invalid),patch.object(ai.llm_client,'post_chat',return_value=response(invalid)),self.assertRaises(ai.RecipeAIError) as error:
                ai.build_recipe_preview(config=CONFIG,text='Original recipe text')
            self.assertEqual(error.exception.code,'recipe.ai.invalidResponse')

    def test_invalid_inputs_do_not_call_the_provider(self):
        invalid=[{}, {'text':''}, {'text':'x','draft':draft()}, {'text':'x'*32001}, {'draft':{**draft(),'image_data':'data:image/png;base64,AA=='}}, {'draft':{**draft(),'id':4}}]
        for kwargs in invalid:
            with self.subTest(kwargs=list(kwargs)),patch.object(ai.llm_client,'post_chat') as send,self.assertRaises(ai.RecipeAIError):
                ai.build_recipe_preview(config=CONFIG,**kwargs)
            send.assert_not_called()
        oversized=draft();oversized['description']='x'*(129*1024)
        with self.assertRaises(ai.RecipeAIError) as error:ai.prepare_input(draft=oversized)
        self.assertEqual(error.exception.code,'recipe.ai.tooLarge')

    def test_explicit_step_allocations_above_total_are_flagged_without_guessing(self):
        data=proposal()
        for step in data['steps']:
            step['ingredients']=[{'ingredient_client_key':'dough-flour','show_quantity':True,'quantity_value':150,'quantity_text':None}]
        with patch.object(ai.llm_client,'post_chat',return_value=response(data)):
            result=ai.build_recipe_preview(config=CONFIG,text='250 g Mehl. 150 g zum ersten Schritt, danach dieselbe Mischung verwenden.')
        self.assertIn('recipe.ai.reviewQuantities',result['warnings'])
        self.assertEqual([step['ingredients'][0]['quantity_value'] for step in result['draft']['steps']],[150,150])

    def test_not_configured_and_provider_failure_have_safe_errors(self):
        with self.assertRaises(ai.RecipeAIError) as error:ai.build_recipe_preview(config={**CONFIG,'llm_model':''},text='Recipe')
        self.assertEqual(error.exception.code,'recipe.ai.notConfigured')
        with patch.object(ai.llm_client,'post_chat',side_effect=RuntimeError('secret provider contents')),self.assertRaises(ai.RecipeAIError) as error:
            ai.build_recipe_preview(config=CONFIG,text='Recipe')
        self.assertEqual(str(error.exception),'recipe.ai.failed')

    def test_retry_uses_remaining_total_budget(self):
        empty={'choices':[{'message':{'content':''},'finish_reason':'length'}]}
        with patch.object(ai.llm_client,'post_chat',side_effect=[empty,response(proposal())]) as send,patch.object(ai.time,'monotonic',side_effect=[0,25,26]):
            ai.build_recipe_preview(config={**CONFIG,'llm_timeout_seconds':40},text='Recipe')
        self.assertEqual(send.call_args_list[0].args[2]['llm_timeout_seconds'],40)
        self.assertEqual(send.call_args_list[1].args[2]['llm_timeout_seconds'],15)
        self.assertEqual(send.call_args_list[0].args[2]['_deadline_at'],40)
        self.assertEqual(send.call_args_list[1].args[2]['_deadline_at'],40)
        with patch.object(ai.llm_client,'post_chat',return_value=empty) as send,patch.object(ai.time,'monotonic',side_effect=[0,41]),self.assertRaises(ai.RecipeAIError):
            ai.build_recipe_preview(config={**CONFIG,'llm_timeout_seconds':40},text='Recipe')
        self.assertEqual(send.call_count,1)

    def test_nonempty_truncation_retries_once_with_same_deadline(self):
        partial={'choices':[{'message':{'content':'{"steps":[{"step_key":"s1"'},'finish_reason':'length'}]}
        good={'steps':[{'step_key':'s2','ingredients':[{'ingredient_key':'i3'}]}]}
        with patch.object(ai.llm_client,'post_chat',side_effect=[partial,response(good)]) as send,patch.object(ai.time,'monotonic',side_effect=[0,25,26]):
            result=ai.build_recipe_preview(config={**CONFIG,'llm_timeout_seconds':40},draft=draft())
        self.assertEqual(result['draft']['steps'][1]['ingredients'][0]['ingredient_client_key'],'filling-flour')
        self.assertEqual(send.call_count,2)
        self.assertEqual(send.call_args_list[1].args[2]['llm_timeout_seconds'],15)
        self.assertEqual(send.call_args_list[1].args[2]['_deadline_at'],40)
        with patch.object(ai.llm_client,'post_chat',return_value=partial) as send,self.assertRaises(ai.RecipeAIError) as error:
            ai.build_recipe_preview(config=CONFIG,draft=draft())
        self.assertEqual(send.call_count,2)
        self.assertEqual(error.exception.reason,'truncated')
        self.assertEqual(str(error.exception),'recipe.ai.invalidResponse')
        gate=unittest.mock.Mock(side_effect=[None,HTTPException(403,'revoked')])
        with patch.object(ai.llm_client,'post_chat',return_value=partial) as send,self.assertRaises(HTTPException):
            ai.build_recipe_preview(config=CONFIG,draft=draft(),check_access=gate)
        self.assertEqual(send.call_count,1)

    def test_diagnostic_reasons_are_fixed_categories_without_content(self):
        secret='private-value-never-in-diagnostics'
        for value, reason in [(secret,'json_syntax'),(json.dumps({'unknown':secret}),'schema')]:
            with self.subTest(reason=reason),patch.object(ai.llm_client,'post_chat',return_value={'choices':[{'message':{'content':value}}]}),self.assertRaises(ai.RecipeAIError) as error:
                ai.build_recipe_preview(config=CONFIG,draft=draft())
            self.assertEqual(error.exception.reason,reason)
            self.assertNotIn(secret,str(error.exception))
        self.assertEqual(ai.RecipeAIError('recipe.ai.failed',reason=secret).reason,'unknown')

    def test_midflight_revocation_also_prevents_the_optional_retry(self):
        empty={'choices':[{'message':{'content':''},'finish_reason':'length'}]}
        gate=unittest.mock.Mock(side_effect=[None,HTTPException(403,'revoked')])
        with patch.object(ai.llm_client,'post_chat',return_value=empty) as send,self.assertRaises(HTTPException) as error:
            ai.build_recipe_preview(config=CONFIG,text='Recipe',check_access=gate)
        self.assertEqual(error.exception.status_code,403)
        self.assertEqual(send.call_count,1,'a revoked reply must not trigger a second paid model request')

    def test_ollama_uses_shared_payload_and_response_adapter(self):
        value=proposal()
        with patch.object(ai.llm_client,'post_chat',return_value={'message':{'content':json.dumps(value)},'done_reason':'stop'}) as send:
            result=ai.build_recipe_preview(config={**CONFIG,'llm_provider':'ollama'},text='Recipe')
        self.assertEqual(result['draft']['title'],value['title'])
        self.assertIn('options',send.call_args.args[0]);self.assertNotIn('max_tokens',send.call_args.args[0])

    def test_recipe_api_gate_denial_and_midflight_revocation(self):
        app=FastAPI();app.include_router(router.router);app.dependency_overrides[require_auth]=lambda:73
        with TestClient(app) as client:
            router._attempts.clear()
            with patch.object(router,'require_braindump_ai_access',side_effect=HTTPException(403,'disabled')),patch.object(router,'build_recipe_preview') as build:
                denied=client.post('/api/recipes/ai-preview',json={'text':'Recipe'})
            self.assertEqual(denied.status_code,403);self.assertEqual(denied.json()['detail']['code'],'recipe.ai.unavailable');build.assert_not_called()
            with patch.object(router,'require_braindump_ai_access',side_effect=[CONFIG,HTTPException(403,'revoked')]),patch.object(router,'build_recipe_preview',return_value={'draft':proposal(),'warnings':[]}):
                revoked=client.post('/api/recipes/ai-preview',json={'text':'Recipe'})
            self.assertEqual(revoked.status_code,403);self.assertNotIn('draft',revoked.json())

    def test_api_validates_inputs_rate_limit_and_releases_provider_slot(self):
        app=FastAPI();app.include_router(router.router);app.dependency_overrides[require_auth]=lambda:74
        router._attempts.clear()
        with TestClient(app) as client,patch.object(router,'require_braindump_ai_access',return_value=CONFIG),patch.object(router,'build_recipe_preview',side_effect=ai.RecipeAIError('recipe.ai.failed')) as build:
            self.assertEqual(client.post('/api/recipes/ai-preview',json={'text':'x','draft':draft()}).status_code,422)
            build.assert_not_called()
            for _ in range(6):self.assertEqual(client.post('/api/recipes/ai-preview',json={'text':'Recipe'}).status_code,502)
            limited=client.post('/api/recipes/ai-preview',json={'text':'Recipe'})
            self.assertEqual(limited.status_code,429);self.assertEqual(limited.json()['detail']['code'],'recipe.ai.rateLimited')
        self.assertTrue(router._slots.acquire(blocking=False));self.assertTrue(router._slots.acquire(blocking=False));router._slots.release();router._slots.release()


if __name__=='__main__':unittest.main()
