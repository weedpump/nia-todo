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
    result = {'title':'Familienkuchen','description':'Originalbeschreibung','base_servings':4,
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
                {'client_key':'mix','title':'','text':'Teig mischen.','ingredients':[{'ingredient_client_key':'dough-flour','show_quantity':True,'quantity_value':100,'quantity_text':None}]},
                {'client_key':'fill','title':'','text':'Füllung herstellen. Zusätzlich Wasser zugeben.','ingredients':[]}]}
    for step in result['steps']:
        step['excluded_ingredients']=[]
        for link in step['ingredients']:link['origin']='manual'
    return result


def proposal(value=None):
    result={key:copy.deepcopy(item) for key,item in (value or draft()).items() if key in ai.CONTENT_FIELDS}
    for step in result['steps']:
        step.pop('excluded_ingredients',None)
        for link in step['ingredients']:link.pop('origin',None)
    return result


def response(value):
    return {'choices':[{'message':{'content':json.dumps(value,ensure_ascii=False)},'finish_reason':'stop'}]}


def issue(step_key, ingredient='Wasser', reason='not_listed', evidence='Zusätzlich Wasser zugeben.'):
    return {'step_key':step_key,'code':'additional_amount_missing','ingredient_name':ingredient,'reason':reason,'evidence':evidence}


def resolved_issue(step_key, ingredient='Wasser', reason='not_listed', evidence='Zusätzlich Wasser zugeben.'):
    return {'step_client_key':step_key,'code':'additional_amount_missing','ingredient_name':ingredient,'reason':reason,'evidence':evidence}


def mostly_named_draft():
    value=draft();value['ingredient_groups'][0]['name']=''
    value['ingredient_groups'].append({'client_key':'finish','name':'Zum Abschluss','ingredients':[
        {'client_key':'finish-sugar','name':'Zucker','quantity_value':1,'quantity_unit':'tbsp','quantity_text':None,'note':''}]})
    return value


class RecipeAITests(unittest.TestCase):
    def test_issues_require_concrete_grounded_details_without_failing_valid_recipe(self):
        original=draft()
        base=issue('s2')
        missing=[{'step_key':'s2','code':'additional_amount_missing'}]
        for field in ('ingredient_name','reason','evidence'):
            value=copy.deepcopy(base);value.pop(field);missing.append(value)
        missing.extend([issue('s2',ingredient='  '),issue('s2',evidence='Invented source instruction.'),
                        issue('s2',ingredient='Olivenöl'),issue('s2',evidence='zusätzlich Wasser zugeben.')])
        for value in missing:
            with self.subTest(value=value),patch.object(ai.llm_client,'post_chat',return_value=response({'issues':[value]})):
                result=ai.build_recipe_preview(config=CONFIG,draft=original)
            self.assertEqual(result['issues'],[])
            self.assertEqual(result['draft'],ai._validate(original),'missing/unverified optional diagnosis preserves content')

    def test_malformed_optional_issue_details_are_dropped_without_truncating_quotes(self):
        original=draft()
        for field, values in {'ingredient_name':[42,True,{},[], 'x'*201],
                              'evidence':[42,True,{},[], 'x'*301],
                              'reason':['unknown',42,True,{},[]]}.items():
            for value in values:
                malformed=issue('s2');malformed[field]=value
                with self.subTest(field=field,value=str(value)[:30]),patch.object(ai.llm_client,'post_chat',return_value=response({'issues':[malformed]})):
                    result=ai.build_recipe_preview(config=CONFIG,draft=original)
                self.assertEqual(result['issues'],[])
                self.assertEqual(result['draft'],ai._validate(original))

    def test_issue_evidence_uses_original_title_and_body_and_whitespace_only_matching(self):
        original=draft()
        original['steps'][1].update(title='Zusätzlich Wasser zugeben.',text='Danach gründlich mischen.')
        with patch.object(ai.llm_client,'post_chat',return_value=response({'issues':[issue('s2')]})):
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(result['issues'],[resolved_issue('fill')],'title-only source facts can support an issue')
        original['steps'][1].update(title='',text='Zusätzlich\n\t Wasser  zugeben.')
        with patch.object(ai.llm_client,'post_chat',return_value=response({'issues':[issue('s2',evidence='Zusätzlich  Wasser\nzugeben.')]})):
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(result['issues'],[resolved_issue('fill')],'whitespace differences do not invalidate a verbatim quotation')
        rewritten={'steps':[{'step_key':'s2','text':'Neu erfundenes Öl zugeben.'}],
                   'issues':[issue('s2','Öl','not_listed','Neu erfundenes Öl zugeben.')]}
        with patch.object(ai.llm_client,'post_chat',return_value=response(rewritten)):
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(result['issues'],[],'a model cannot ground an issue in its own invented rewrite')

    def test_assignment_completion_retains_original_evidence_despite_primary_rewrite(self):
        original=draft()
        for step in original['steps']:step['ingredients']=[]
        formatted={'steps':[{'step_key':'s2','text':'Erfundenes Öl zugeben.'}]}
        assigned={'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i1'}]},{'step_key':'s2','ingredients':[]}],
                  'issues':[issue('s2','Öl','not_listed','Erfundenes Öl zugeben.'),issue('s2')]}
        with patch.object(ai.llm_client,'post_chat',side_effect=[response(formatted),response(assigned)]):
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(result['issues'],[resolved_issue('fill')],'focused repair uses original source, not rewritten draft')

    def test_multiple_issue_ingredients_and_reasons_survive_but_identical_details_deduplicate(self):
        original=draft();original['steps'][1]['text']='Zusätzlich Wasser und Öl zugeben.'
        values=[issue('s2','Wasser','not_listed','Wasser und Öl zugeben.'),
                issue('s2','Öl','amount_missing','Wasser und Öl zugeben.'),
                issue('s2','Öl','already_used','Wasser und Öl zugeben.'),
                issue('s2','  Wasser  ','not_listed','Wasser und Öl zugeben.')]
        with patch.object(ai.llm_client,'post_chat',return_value=response({'issues':values})):
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual([(value['ingredient_name'],value['reason']) for value in result['issues']],
                         [('Wasser','not_listed'),('Öl','amount_missing'),('Öl','already_used')])

    def test_text_issues_quote_raw_input_instead_of_generated_instructions(self):
        data=proposal()
        data['steps'][1]['text']='Erfundenes Öl zugeben.'
        data['issues']=[issue('fill'),issue('fill','Öl','not_listed','Erfundenes Öl zugeben.')]
        with patch.object(ai.llm_client,'post_chat',return_value=response(data)):
            result=ai.build_recipe_preview(config=CONFIG,text='Zusätzlich Wasser zugeben.')
        self.assertEqual(result['issues'],[resolved_issue('fill')])
        self.assertIn('explicitly measured processing inputs',ai.RECIPE_SYSTEM_PROMPT)
        self.assertIn('then drains/discards it',ai.RECIPE_SYSTEM_PROMPT)

    def test_missing_group_name_gets_naming_only_completion_without_changing_assignments(self):
        original=mostly_named_draft()
        original['ingredient_groups'].extend([{'client_key':'empty-1','name':'','ingredients':[]},{'client_key':'empty-2','name':'','ingredients':[]}])
        primary={'description':'Bereinigt.','steps':[{'step_key':'s2','ingredients':[{'ingredient_key':'i3'}]}],
                 'issues':[issue('s2')]}
        with patch.object(ai.llm_client,'post_chat',side_effect=[response(primary),response({'groups':[{'group_key':'g1','name':'Teig'}]})]) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(send.call_count,2)
        self.assertEqual(result['draft']['ingredient_groups'][0]['name'],'Teig')
        self.assertEqual(result['draft']['steps'][0]['ingredients'],original['steps'][0]['ingredients'])
        self.assertEqual(result['draft']['steps'][1]['ingredients'][0]['ingredient_client_key'],'filling-flour')
        self.assertEqual(result['draft']['steps'][1]['ingredients'][0]['origin'],'braindump')
        self.assertEqual(result['issues'],[resolved_issue('fill')])
        self.assertEqual(result['draft']['description'],'Bereinigt.')
        payload=json.loads(send.call_args_list[1].args[0]['messages'][1]['content'])
        self.assertEqual(payload['mode'],'group_names')
        self.assertEqual(send.call_args_list[1].args[0]['max_tokens'],4096)
        self.assertEqual(send.call_args_list[0].args[2]['_deadline_at'],send.call_args_list[1].args[2]['_deadline_at'])

    def test_focused_naming_can_decline_or_fail_without_forcing_names_or_editing_links(self):
        original=mostly_named_draft()
        replies=[response({'groups':[]}),response({'groups':[{'group_key':'g2','name':'Do not rename'}]}),
                 response({'groups':[{'group_key':'g99','name':'Unknown'}]}),
                 response({'groups':[],'steps':[{'step_key':'s1','ingredients':[]}]}),
                 response({'groups':[],'description':'Unwanted edit'}),{'choices':[]},
                 RuntimeError('provider failure')]
        for reply in replies:
            with self.subTest(reply=str(reply)[:70]),patch.object(ai.llm_client,'post_chat',side_effect=[response({}),reply]) as send:
                result=ai.build_recipe_preview(config=CONFIG,draft=original)
            self.assertEqual(send.call_count,2)
            self.assertEqual(result['draft'],ai._validate(original),'ambiguous/failed naming leaves the valid primary draft intact')

    def test_assignment_completion_can_also_fill_skipped_group_name_in_same_second_call(self):
        original=mostly_named_draft()
        for step in original['steps']:step['ingredients']=[]
        completion={'groups':[{'group_key':'g1','name':'Teig'}],
                    'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i1'}]},
                             {'step_key':'s2','ingredients':[{'ingredient_key':'i3'}]}]}
        with patch.object(ai.llm_client,'post_chat',side_effect=[response({}),response(completion)]) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(send.call_count,2)
        self.assertEqual(json.loads(send.call_args_list[1].args[0]['messages'][1]['content'])['mode'],'assign')
        self.assertEqual(result['draft']['ingredient_groups'][0]['name'],'Teig')
        self.assertEqual([step['ingredients'][0]['ingredient_client_key'] for step in result['draft']['steps']],['dough-flour','filling-flour'])

    def test_naming_completion_respects_existing_retry_budget_and_majority_condition(self):
        original=mostly_named_draft()
        truncated={'choices':[{'message':{'content':'{"groups":['},'finish_reason':'length'}]}
        with patch.object(ai.llm_client,'post_chat',side_effect=[truncated,response({})]) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(send.call_count,2,'a primary retry cannot be followed by a third naming call')
        self.assertEqual(result['draft']['ingredient_groups'][0]['name'],'')
        # A tie is not "most groups are already named"; primary refinement may
        # still infer a name, but it does not automatically buy a completion call.
        original=draft();original['ingredient_groups'][0]['name']=''
        with patch.object(ai.llm_client,'post_chat',return_value=response({})) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(send.call_count,1)
        self.assertEqual(result['draft']['ingredient_groups'][0]['name'],'')

    def test_blank_group_name_can_be_inferred_but_established_groups_are_protected(self):
        original=draft();original['ingredient_groups'][0]['name']=''
        before=copy.deepcopy(original)
        with patch.object(ai.llm_client,'post_chat',return_value=response({'groups':[{'group_key':'g1','name':'  Für den Teig  '}]})):
            actual=ai.build_recipe_preview(config=CONFIG,draft=original)['draft']
        self.assertEqual(actual['ingredient_groups'][0]['name'],'Für den Teig')
        self.assertEqual(actual['ingredient_groups'][0]['ingredients'],before['ingredient_groups'][0]['ingredients'])
        self.assertEqual(actual['ingredient_groups'][1],before['ingredient_groups'][1])
        self.assertEqual(original,before)
        invalid=[{'group_key':'g2','name':'Umbenannt'}, {'group_key':'g99','name':'Unknown'},
                 {'group_key':'g1','name':'   '}, {'group_key':'g1','name':'x'*201},
                 {'group_key':'g1','name':'New','id':42}]
        for group in invalid:
            with self.subTest(group=group),patch.object(ai.llm_client,'post_chat',return_value=response({'groups':[group]})),self.assertRaises(ai.RecipeAIError):
                ai.build_recipe_preview(config=CONFIG,draft=original)
        with patch.object(ai.llm_client,'post_chat',return_value=response({'groups':[{'group_key':'g1','name':'First'},{'group_key':'g1','name':'Second'}]})),self.assertRaises(ai.RecipeAIError):
            ai.build_recipe_preview(config=CONFIG,draft=original)

    def test_only_ai_links_are_replaceable_and_manual_negative_choices_remain_protected(self):
        original=draft()
        original['steps'][1]['ingredients']=[
            {'ingredient_client_key':'dough-flour','show_quantity':True,'quantity_value':150,'quantity_text':None,'origin':'braindump'},
            {'ingredient_client_key':'filling-flour','show_quantity':False,'quantity_value':None,'quantity_text':None,'origin':'manual'}]
        original['steps'][1]['excluded_ingredients']=['raw']
        proposal={'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i1','quantity_value':25}]},
                           {'step_key':'s2','ingredients':[{'ingredient_key':'i2'}]}]}
        with patch.object(ai.llm_client,'post_chat',return_value=response(proposal)) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        actual=result['draft']
        self.assertEqual(actual['steps'][0]['ingredients'],original['steps'][0]['ingredients'],'manual numeric amount cannot be rewritten')
        self.assertEqual(actual['steps'][1]['ingredients'],[original['steps'][1]['ingredients'][1]],'an omitted AI amount/link can be removed but manual links remain')
        self.assertEqual(actual['steps'][1]['excluded_ingredients'],['raw'],'model cannot re-add a manually unchecked ingredient')
        context=json.loads(send.call_args.args[0]['messages'][1]['content'])['recipe_data']
        self.assertEqual(context['steps'][1]['excluded_ingredients'],['i2'],'negative choices use the same short references as links')
        self.assertNotIn('dough-flour',json.dumps(context))
        self.assertEqual(result['issues'],[])

    def test_finished_sauce_does_not_readd_incorporated_fats_and_missing_extra_is_reviewed(self):
        original=draft()
        original['ingredient_groups']=[
            {'client_key':'main','name':'','ingredients':[{'client_key':'sheets','name':'Lasagneplatten','quantity_value':.5,'quantity_unit':'pack','quantity_text':None,'note':''}]},
            {'client_key':'bechamel','name':'Béchamel','ingredients':[{'client_key':'sauce-fat','name':'Margarine','quantity_value':5,'quantity_unit':'tbsp','quantity_text':None,'note':''}]},
            {'client_key':'topping','name':'Hefeschmelz','ingredients':[{'client_key':'topping-fat','name':'Margarine','quantity_value':2,'quantity_unit':'tbsp','quantity_text':None,'note':''}]}]
        original['steps']=[
            {'client_key':'sauce','text':'Die 5 EL Margarine vollständig in der Béchamel verarbeiten.','ingredients':[]},
            {'client_key':'topping','text':'Die 2 EL Margarine vollständig im Hefeschmelz verarbeiten.','ingredients':[]},
            {'client_key':'layer','text':'Fertige Saucen und Lasagneplatten schichten, zusätzlich einen Klecks Margarine darauf geben.',
             'ingredients':[{'ingredient_client_key':key,'show_quantity':True,'quantity_value':None,'quantity_text':None,'origin':'braindump'} for key in ['sheets','sauce-fat','topping-fat']]}]
        value={'groups':[{'group_key':'g1','name':'Für die Lasagne'}],
               'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i2'}]},
                        {'step_key':'s2','ingredients':[{'ingredient_key':'i3'}]},
                        {'step_key':'s3','ingredients':[{'ingredient_key':'i1'}]}],
               'issues':[issue('s3','Margarine','already_used','zusätzlich einen Klecks Margarine darauf geben.')]}
        with patch.object(ai.llm_client,'post_chat',return_value=response(value)) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        actual=result['draft']
        self.assertEqual([link['ingredient_client_key'] for link in actual['steps'][2]['ingredients']],['sheets'])
        self.assertTrue(all(link['origin']=='braindump' for step in actual['steps'] for link in step['ingredients']))
        self.assertEqual(result['issues'],[resolved_issue('layer','Margarine','already_used','zusätzlich einen Klecks Margarine darauf geben.')])
        self.assertIn('recipe.ai.reviewQuantities',result['warnings'])
        self.assertEqual([group['ingredients'] for group in actual['ingredient_groups']],[group['ingredients'] for group in original['ingredient_groups']],'missing extra fat never changes source totals')
        prompt=send.call_args.args[0]['messages'][0]['content']
        self.assertNotIn('ingredients in a prepared mixture',prompt)
        self.assertIn('peeling and later cutting',prompt,'ordinary continued preparation remains supported')
        self.assertIn('do not borrow another group',prompt)

    def test_text_origin_is_server_owned_and_issues_use_generated_step_keys(self):
        value=proposal();value['issues']=[issue('fill')]
        with patch.object(ai.llm_client,'post_chat',return_value=response(value)):
            result=ai.build_recipe_preview(config=CONFIG,text='Füllung herstellen. Zusätzlich Wasser zugeben.')
        self.assertEqual(result['draft']['steps'][0]['ingredients'][0]['origin'],'braindump')
        self.assertEqual(result['issues'],[resolved_issue('fill')])
        injected_origin=proposal();injected_origin['steps'][0]['ingredients'][0]['origin']='manual'
        injected_exclusions=proposal();injected_exclusions['steps'][0]['excluded_ingredients']=['raw']
        for data in (injected_origin,injected_exclusions):
            with self.subTest(data=data),patch.object(ai.llm_client,'post_chat',return_value=response(data)),self.assertRaises(ai.RecipeAIError):
                ai.build_recipe_preview(config=CONFIG,text='Recipe')

    def test_issue_schema_and_step_references_are_strict(self):
        invalid=[None, [{'step_key':'s99','code':'additional_amount_missing'}],
                 [{'step_key':'mix','code':'additional_amount_missing'}],
                 [{'step_key':'s2','code':'invented_code'}],
                 [{'step_key':'s2','code':'additional_amount_missing','text':'Untrusted prose'}],
                 [{'step_key':'s2','code':'additional_amount_missing'}]*101]
        for issues in invalid:
            with self.subTest(issues=str(issues)[:80]),patch.object(ai.llm_client,'post_chat',return_value=response({'issues':issues})),self.assertRaises(ai.RecipeAIError):
                ai.build_recipe_preview(config=CONFIG,draft=draft())
        for field in ('origin','excluded_ingredients'):
            value={'steps':[{'step_key':'s2','ingredients':[{'ingredient_key':'i3',field:'manual' if field=='origin' else []}]}]}
            with patch.object(ai.llm_client,'post_chat',return_value=response(value)),self.assertRaises(ai.RecipeAIError):
                ai.build_recipe_preview(config=CONFIG,draft=draft())

    def test_assignment_pass_preserves_inferred_group_and_resolves_its_issues(self):
        original=draft();original['ingredient_groups'][0]['name']=''
        for step in original['steps']:step['ingredients']=[]
        formatted={'groups':[{'group_key':'g1','name':'Teig'}]}
        assigned={'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i1'}]},{'step_key':'s2','ingredients':[]}],
                  'issues':[issue('s2')]}
        with patch.object(ai.llm_client,'post_chat',side_effect=[response(formatted),response(assigned)]) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(send.call_count,2)
        self.assertEqual(result['draft']['ingredient_groups'][0]['name'],'Teig')
        self.assertEqual(result['issues'],[resolved_issue('fill')])
        self.assertEqual(result['draft']['steps'][0]['ingredients'][0]['origin'],'braindump')
        assigned['issues'][0]['step_key']='s99'
        with patch.object(ai.llm_client,'post_chat',side_effect=[response(formatted),response(assigned)]):
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(result['issues'],[],'failed optional check cannot leak unverified issues')
        self.assertEqual(result['draft']['ingredient_groups'][0]['name'],'Teig')

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

    def test_refinement_separates_headings_and_cleans_description_without_changing_source(self):
        original=draft()
        original['description']='Saftiger Kuchen. Über 40 Bewertungen. Mit Portionsrechner und Video-Tipps!'
        original['steps'][1]['text']='Mehl für die Füllung vorsichtig mischen und ruhen lassen.'
        value={'description':'Saftiger Kuchen.', 'steps':[{'step_key':'s2','title':'Füllung vorbereiten'}]}
        with patch.object(ai.llm_client,'post_chat',return_value=response(value)) as send:
            actual=ai.build_recipe_preview(config=CONFIG,draft=original)['draft']
        self.assertEqual(actual['description'],'Saftiger Kuchen.')
        self.assertEqual(actual['steps'][1]['title'],'Füllung vorbereiten')
        self.assertEqual(actual['steps'][1]['text'],original['steps'][1]['text'])
        self.assertEqual(actual['steps'][1]['client_key'],'fill')
        for field in ai.SOURCE_FIELDS:self.assertEqual(actual[field],original[field])
        self.assertIn('remaining amounts',send.call_args.args[0]['messages'][0]['content'])
        # Boilerplate-only descriptions may be cleared; omitted titles stay intact.
        original['steps'][1]['title']='Eigener Titel'
        for description in ('',None):
            with self.subTest(description=description),patch.object(ai.llm_client,'post_chat',return_value=response({'description':description})):
                cleaned=ai.build_recipe_preview(config=CONFIG,draft=original)['draft']
            self.assertEqual(cleaned['description'],'')
            self.assertEqual(cleaned['steps'][1]['title'],'Eigener Titel')
        # A title-only source can move its instructions into the body explicitly.
        original['steps'][1].update(title='Alle Zutaten mischen und für zehn Minuten ruhen lassen.',text='')
        with patch.object(ai.llm_client,'post_chat',return_value=response({'steps':[{'step_key':'s2','title':'Mischen und ruhen lassen','text':original['steps'][1]['title']}]})):
            moved=ai.build_recipe_preview(config=CONFIG,draft=original)['draft']['steps'][1]
        self.assertEqual(moved['title'],'Mischen und ruhen lassen')
        self.assertEqual(moved['text'],original['steps'][1]['title'])

    def test_refinement_uses_explicit_partial_and_remaining_amounts_with_same_named_groups(self):
        original=draft()
        original['steps'][0]['ingredients']=[]
        original['steps'][0]['text']='100 g Mehl vom Teig mischen.'
        original['steps'][1]['text']='Das restliche Mehl vom Teig und die 50 g Mehl für die Füllung verwenden.'
        value={'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i1','show_quantity':True,'quantity_value':100}]},
                        {'step_key':'s2','ingredients':[{'ingredient_key':'i1','show_quantity':True,'quantity_value':150},
                                                       {'ingredient_key':'i3','show_quantity':True}]}]}
        with patch.object(ai.llm_client,'post_chat',return_value=response(value)):
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        steps=result['draft']['steps']
        self.assertEqual([step['ingredients'][0]['quantity_value'] for step in steps],[100,150])
        self.assertEqual(steps[1]['ingredients'][1]['ingredient_client_key'],'filling-flour')
        self.assertIsNone(steps[1]['ingredients'][1]['quantity_value'],'null override displays the original whole total')
        self.assertNotIn('recipe.ai.reviewQuantities',result['warnings'])
        uncertain={'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i1','show_quantity':False}]},
                            {'step_key':'s2','ingredients':[{'ingredient_key':'i1','show_quantity':False}]}]}
        with patch.object(ai.llm_client,'post_chat',return_value=response(uncertain)):
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertIn('recipe.ai.reviewQuantities',result['warnings'])
        self.assertTrue(all(not step['ingredients'][0]['show_quantity'] for step in result['draft']['steps']))

    def test_formatting_only_reply_gets_focused_assignment_pass_without_losing_edits(self):
        original=draft()
        for step in original['steps']:step['ingredients']=[]
        formatting={'description':'Bereinigte Beschreibung.', 'steps':[{'step_key':'s1','title':'Teig vorbereiten'}],
                    'ingredients':[{'ingredient_key':'i2','name':'Backpulver','quantity_value':.5,'quantity_unit':'pack'}]}
        assignments={'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i1','show_quantity':False}, {'ingredient_key':'i2','show_quantity':True}]},
                              {'step_key':'s2','ingredients':[{'ingredient_key':'i3','show_quantity':True}]}]}
        with patch.object(ai.llm_client,'post_chat',side_effect=[response(formatting),response(assignments)]) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        actual=result['draft']
        self.assertEqual(send.call_count,2)
        self.assertEqual(actual['description'],'Bereinigte Beschreibung.')
        self.assertEqual(actual['steps'][0]['title'],'Teig vorbereiten')
        self.assertEqual(actual['steps'][0]['text'],original['steps'][0]['text'])
        self.assertEqual(actual['ingredient_groups'][0]['ingredients'][1]['quantity_value'],.5)
        self.assertEqual(actual['steps'][0]['ingredients'][0]['ingredient_client_key'],'dough-flour')
        self.assertFalse(actual['steps'][0]['ingredients'][0]['show_quantity'],'uncertain amount must retain a clear ingredient assignment')
        self.assertIn('recipe.ai.reviewQuantities',result['warnings'])
        context=json.loads(send.call_args_list[1].args[0]['messages'][1]['content'])
        self.assertEqual(context['mode'],'assign')
        self.assertEqual(context['recipe_data']['description'],'Bereinigte Beschreibung.')
        self.assertEqual(context['recipe_data']['steps'][0]['title'],'Teig vorbereiten')
        self.assertEqual(send.call_args_list[0].args[2]['_deadline_at'],send.call_args_list[1].args[2]['_deadline_at'])
        self.assertLess(send.call_args_list[1].args[2]['llm_timeout_seconds'],send.call_args_list[0].args[2]['llm_timeout_seconds'])

    def test_focused_assignment_may_find_no_matches_without_forcing_links(self):
        original=draft()
        for step in original['steps']:step.update(ingredients=[],text='Den Ofen einschalten.')
        empty={'steps':[{'step_key':'s1','ingredients':[]},{'step_key':'s2','ingredients':[]}]}
        with patch.object(ai.llm_client,'post_chat',side_effect=[response({'description':'Clean.'}),response(empty)]) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(send.call_count,2)
        self.assertEqual(result['draft']['description'],'Clean.')
        self.assertTrue(all(not step['ingredients'] for step in result['draft']['steps']))
        self.assertIn('recipe.ai.reviewAssignments',result['warnings'])

    def test_existing_links_survive_omission_and_authored_unresolved_amounts_stay_protected(self):
        original=draft()
        original['steps'][0]['ingredients']=[{'ingredient_client_key':'dough-flour','show_quantity':True,'quantity_value':None,'quantity_text':None,'origin':'manual'}]
        original['steps'][1]['ingredients']=[{'ingredient_client_key':'filling-flour','show_quantity':False,'quantity_value':None,'quantity_text':None,'origin':'manual'}]
        value={'steps':[{'step_key':'s1','ingredients':[]},
                        {'step_key':'s2','ingredients':[{'ingredient_key':'i3','show_quantity':True,'quantity_value':25}]}]}
        with patch.object(ai.llm_client,'post_chat',return_value=response(value)) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(send.call_count,1)
        self.assertEqual([s['ingredients'] for s in result['draft']['steps']],[s['ingredients'] for s in original['steps']])
        # Authored full-total links are protected as well as authored partials.
        with patch.object(ai.llm_client,'post_chat',return_value=response({'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i1','quantity_value':100}]}]})):
            refined=ai.build_recipe_preview(config=CONFIG,draft=original)['draft']
        self.assertIsNone(refined['steps'][0]['ingredients'][0]['quantity_value'])
        original['steps'][0]['ingredients'][0]['origin']='braindump'
        with patch.object(ai.llm_client,'post_chat',return_value=response({'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i1','quantity_value':100}]}]})):
            refined=ai.build_recipe_preview(config=CONFIG,draft=original)['draft']
        self.assertEqual(refined['steps'][0]['ingredients'][0]['quantity_value'],100)
        self.assertEqual(refined['steps'][0]['ingredients'][0]['origin'],'braindump')

    def test_failed_or_incomplete_assignment_pass_keeps_valid_formatted_draft(self):
        original=draft()
        for step in original['steps']:step['ingredients']=[]
        invalid=[response({'steps':[{'step_key':'s1','ingredients':[]}]}),
                 response({'steps':[{'step_key':'s1','ingredients':[]},{'step_key':'s1','ingredients':[]}]}),
                 response({'description':'Unwanted rewrite.','steps':[]}),
                 response({'steps':[{'step_key':'s1','ingredients':[{'ingredient_key':'i99'}]},{'step_key':'s2','ingredients':[]}]}),
                 {'choices':[{'message':{'content':'{"steps":['},'finish_reason':'length'}]},
                 {}, {'choices':[]}, {'choices':[None]}, {'choices':[{'message':None}]},
                 RuntimeError('private provider error')]
        for value in invalid:
            with self.subTest(value=str(value)[:70]),patch.object(ai.llm_client,'post_chat',side_effect=[response({'description':'Clean.'}),value]) as send:
                result=ai.build_recipe_preview(config=CONFIG,draft=original)
            self.assertEqual(send.call_count,2)
            self.assertEqual(result['draft']['description'],'Clean.')
            self.assertTrue(all(not step['ingredients'] for step in result['draft']['steps']))
            self.assertIn('recipe.ai.reviewAssignments',result['warnings'])

    def test_assignment_repair_shares_two_call_budget_with_truncation_retry(self):
        original=draft()
        for step in original['steps']:step['ingredients']=[]
        partial={'choices':[{'message':{'content':'{"steps":['},'finish_reason':'length'}]}
        with patch.object(ai.llm_client,'post_chat',side_effect=[partial,response({'description':'Clean.'})]) as send:
            result=ai.build_recipe_preview(config=CONFIG,draft=original)
        self.assertEqual(send.call_count,2,'a primary truncation retry consumes the repair slot')
        self.assertEqual(result['draft']['description'],'Clean.')
        self.assertIn('recipe.ai.reviewAssignments',result['warnings'])

    def test_assignment_repair_does_not_resend_output_above_input_bound(self):
        value=proposal()
        value['steps']=[{'client_key':f'step-{n}','title':'','text':'x'*7000,'ingredients':[]} for n in range(20)]
        with patch.object(ai.llm_client,'post_chat',return_value=response(value)) as send:
            result=ai.build_recipe_preview(config=CONFIG,text='Supplied recipe')
        self.assertGreater(len(ai._encoded(result['draft'])),ai.MAX_INPUT_BYTES)
        self.assertEqual(send.call_count,1,'a large generated draft must not bypass the follow-up input bound')
        self.assertIn('recipe.ai.reviewAssignments',result['warnings'])

    def test_assignment_pass_rechecks_access_and_total_deadline(self):
        original=draft()
        for step in original['steps']:step['ingredients']=[]
        empty={'steps':[{'step_key':'s1','ingredients':[]},{'step_key':'s2','ingredients':[]}]}
        for allowed_calls, expected_dispatches in [(2,1),(3,2)]:
            gate=unittest.mock.Mock(side_effect=[None]*allowed_calls+[HTTPException(403,'revoked')])
            with self.subTest(allowed_calls=allowed_calls),patch.object(ai.llm_client,'post_chat',side_effect=[response({}),response(empty)]) as send,self.assertRaises(HTTPException):
                ai.build_recipe_preview(config=CONFIG,draft=original,check_access=gate)
            self.assertEqual(send.call_count,expected_dispatches)
        with patch.object(ai.llm_client,'post_chat',side_effect=[response({}),response(empty)]) as send,patch.object(ai.time,'monotonic',side_effect=[0,25,26,41]),self.assertRaises(ai.RecipeAIError) as error:
            ai.build_recipe_preview(config={**CONFIG,'llm_timeout_seconds':40},draft=original)
        self.assertEqual(error.exception.reason,'deadline')
        self.assertEqual(send.call_count,2)
        self.assertEqual(send.call_args_list[1].args[2]['llm_timeout_seconds'],14)
        self.assertEqual(send.call_args_list[1].args[2]['_deadline_at'],40)

    def test_invalid_heading_description_or_empty_step_is_rejected(self):
        cases=[{'description':'x'*4001}, {'description':42},
               {'steps':[{'step_key':'s2','title':'x'*201}]},
               {'steps':[{'step_key':'s2','title':42}]},
               {'steps':[{'step_key':'s2','title':'','text':''}]}]
        for value in cases:
            with self.subTest(value=str(value)[:40]),patch.object(ai.llm_client,'post_chat',return_value=response(value)),self.assertRaises(ai.RecipeAIError) as error:
                ai.build_recipe_preview(config=CONFIG,draft=draft())
            self.assertEqual(error.exception.reason,'schema')

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
            original['steps'].append({'client_key':f'import-87654321-4321-4321-8432-{index:012d}','title':'','text':(f'Schritt {index}. '+('Unveränderte ausführliche Zubereitung. '*45)).rstrip(),'ingredients':[],'excluded_ingredients':[]})
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
        for step in value['steps']:step['title']=None
        for group in value['ingredient_groups']:
            group['name']=None
            for ingredient in group['ingredients']:ingredient['note']=None
        with patch.object(ai.llm_client,'post_chat',return_value=response(value)):
            result=ai.build_recipe_preview(config=CONFIG,text='Original recipe text')
        self.assertEqual(result['draft']['description'],'')
        self.assertEqual(result['draft']['tags'],[])
        self.assertTrue(all(step['title']=='' for step in result['draft']['steps']))
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
