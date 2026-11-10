#!/usr/bin/env python3
"""Pure fixtures for recipe extraction/import; no app DB or live sites."""
import base64
import io
import json
import socket
import sys
import unittest
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from PIL import Image
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services import recipe_import as imports
from services.public_fetch import PublicResponse, PublicFetchError
from services.recipe_images import normalize_recipe_image
from routers import recipe_import as route
from routers.auth import require_auth


def page(**changes):
    data={'@context':'https://schema.org','@type':'Recipe','name':'Apfelkuchen','description':'Ein einfaches Rezept.',
          'recipeYield':'4 Portionen','prepTime':'PT15M','cookTime':'PT30M','author':{'@type':'Person','name':'Test Author'},
          'keywords':'süß, einfach','image':'/cake.png','recipeIngredient':['200 g Mehl','1½ Liter Milch','2 Äpfel','Salz nach Geschmack'],
          'recipeInstructions':[{'@type':'HowToStep','text':'Mehl und Milch mischen.'},{'@type':'HowToStep','text':'Äpfel hinzugeben.'}]}
    data.update(changes)
    return '<html><head><script type="application/ld+json">'+json.dumps(data)+'</script></head></html>'


class ImportTests(unittest.TestCase):
    def test_generic_schema_and_normalized_amounts(self):
        linked = page() + '<div vocab="http://169.254.169.254/ontology" typeof="Recipe"><span property="name">No external vocabulary fetch</span></div>'
        with patch.object(socket,'socket',side_effect=AssertionError('parser must not access network')), patch.object(urllib.request,'urlopen',side_effect=AssertionError('parser must not fetch contexts')):
            result=imports.extract_recipe_html(linked,'https://unknown.example/rezept')
        draft=result['draft']; ingredients=draft['ingredient_groups'][0]['ingredients']
        self.assertEqual(draft['title'],'Apfelkuchen'); self.assertEqual(draft['base_servings'],4)
        self.assertEqual((draft['prep_minutes'],draft['cook_minutes']),(15,30))
        self.assertEqual(draft['source_author'],'Test Author'); self.assertEqual(draft['source_yield'],'4 Portionen')
        self.assertEqual(draft['source_url'],'https://unknown.example/rezept')
        self.assertEqual((ingredients[0]['quantity_value'],ingredients[0]['quantity_unit'],ingredients[0]['name']),(200,'g','Mehl'))
        self.assertEqual((ingredients[1]['quantity_value'],ingredients[1]['quantity_unit']),(1.5,'l'))
        self.assertEqual((ingredients[2]['quantity_value'],ingredients[2]['name']),(2,'Äpfel'))
        self.assertEqual(ingredients[3]['name'],'Salz nach Geschmack'); self.assertIsNone(ingredients[3]['quantity_value'])
        self.assertIn('recipe.import.reviewIngredients',result['warnings'])
        self.assertTrue(all(step['ingredients']==[] for step in draft['steps']))
        self.assertTrue(all(step['title']=='' for step in draft['steps']),'plain instructions remain body text, never implicit headings')
        keys=[record['client_key'] for record in [*ingredients,*draft['steps'],*draft['ingredient_groups']]]
        self.assertEqual(len(keys),len(set(keys)))

    def test_registered_chefkoch_adapter(self):
        result=imports.extract_recipe_html(page(recipeInstructions=[{'@type':'HowToSection','name':'Teig','itemListElement':[{'@type':'HowToStep','name':'1.','text':'Mehl mischen.'}]}]),'https://www.chefkoch.de/rezepte/123/kuchen.html')
        self.assertEqual(result['draft']['title'],'Apfelkuchen')
        self.assertEqual([step['text'] for step in result['draft']['steps']], ['Mehl mischen.'])
        self.assertTrue(all(step['ingredients']==[] for step in result['draft']['steps']))

    def test_structured_step_titles_are_optional_distinct_headings(self):
        instructions=[{'@type':'HowToSection','name':'Teig','itemListElement':[
            {'@type':'HowToStep','name':'Teig mischen','text':'Mehl und Milch gründlich mischen.'},
            {'@type':'HowToStep','name':'2.','text':'Zehn Minuten ruhen lassen.'},
            {'@type':'HowToStep','name':'Äpfel hinzugeben.','text':'Äpfel hinzugeben.'},
            {'@type':'HowToStep','name':'x'*201,'text':'Zum Schluss backen.'}]}]
        for host in ('unknown.example','www.chefkoch.de'):
            with self.subTest(host=host):
                result=imports.extract_recipe_html(page(recipeInstructions=instructions),'https://'+host+'/rezept')
                steps=result['draft']['steps']
                self.assertEqual([step['title'] for step in steps],['Teig · Teig mischen','Teig','Teig','Teig'])
                self.assertEqual([step['text'] for step in steps],['Mehl und Milch gründlich mischen.','Zehn Minuten ruhen lassen.','Äpfel hinzugeben.','x'*201+'\n\nZum Schluss backen.'])
        # Unsupported schema shapes retain the site's adapter fallback as body text.
        scraper=SimpleNamespace(schema=SimpleNamespace(data={'recipeInstructions':'Adapter-specific format'}),
            ingredients=lambda:['1 g Mehl'],ingredient_groups=lambda:[],instructions_list=lambda:['Anderer Adaptertext.'],title=lambda:'Brot')
        with patch.object(imports,'scrape_html',return_value=scraper):
            steps=imports.extract_recipe_html('<html></html>','https://unknown.example/rezept')['draft']['steps']
        self.assertEqual(steps[0]['title'],'')
        self.assertEqual(steps[0]['text'],'Anderer Adaptertext.')
        section={'@type':'HowToSection','name':'x'*201,'text':'Alle Zutaten zimmerwarm verwenden.',
                 'itemListElement':[{'@type':'HowToStep','text':'Mehl mischen.'}]}
        steps=imports.extract_recipe_html(page(recipeInstructions=[section]),'https://unknown.example/rezept')['draft']['steps']
        self.assertEqual(steps[0]['title'],'')
        self.assertEqual(steps[0]['text'],'Alle Zutaten zimmerwarm verwenden.\n\n'+'x'*201+'\n\nMehl mischen.')

    def test_yields_are_not_invented_person_counts(self):
        for raw in ['12 cookies','1 Blech','2 Kuchen','24 Stück','unbekannt']:
            with self.subTest(raw=raw):
                result=imports.extract_recipe_html(page(recipeYield=raw),'https://unknown.example/rezept')
                self.assertEqual(result['draft']['base_servings'],1)
                self.assertEqual(result['draft']['source_yield'],raw)
                self.assertIn('recipe.import.reviewServings',result['warnings'])
        for raw in ['4','4 servings','4 Personen','4 порции','4 人份']:
            with self.subTest(raw=raw): self.assertEqual(imports.extract_recipe_html(page(recipeYield=raw),'https://unknown.example/rezept')['draft']['base_servings'],4)

    def test_oversized_raw_arrays_fail_before_per_ingredient_work(self):
        def fixture(**changes):
            values={'schema':SimpleNamespace(data={}), 'ingredients':lambda:['1 g Mehl'],
                    'ingredient_groups':lambda:[], 'instructions_list':lambda:['Mischen.'],
                    'title':lambda:'Brot'}
            values.update(changes)
            return SimpleNamespace(**values)
        cases=[fixture(ingredients=lambda:['a']*501),
               fixture(ingredient_groups=lambda:[SimpleNamespace(ingredients=[])]*51),
               fixture(ingredient_groups=lambda:[SimpleNamespace(ingredients=['a']*501)]),
               fixture(ingredient_groups=lambda:[SimpleNamespace(ingredients=['a']*251)]*2),
               fixture(instructions_list=lambda:['a']*101),
               fixture(schema=SimpleNamespace(data={'recipeIngredient':['a']*501})),
               fixture(schema=SimpleNamespace(data={'recipeInstructions':['a']*101})),
               fixture(schema=SimpleNamespace(data={'recipeInstructions':[{'@type':'HowToSection','itemListElement':['a']*101}]}))]
        for index,scraper in enumerate(cases):
            with self.subTest(case=index),patch.object(imports,'scrape_html',return_value=scraper), \
                 patch.object(imports,'parse_ingredient') as parser, self.assertRaises(PublicFetchError) as error:
                imports.extract_recipe_html('<html></html>','https://unknown.example/rezept')
            self.assertEqual(error.exception.code,'recipe.import.invalidRecipe')
            parser.assert_not_called()

    def test_keyword_collections_are_capped_before_html_cleaning(self):
        for keywords in [['tag'+str(index) for index in range(10000)], ','.join('tag'+str(index) for index in range(10000))]:
            with self.subTest(kind=type(keywords).__name__):
                # Extraction itself must never clean all ten thousand tags.
                original=imports._text
                tag_calls=[]
                def clean(value):
                    if isinstance(value,str) and value.startswith('tag'):tag_calls.append(value)
                    return original(value)
                with patch.object(imports,'_text',side_effect=clean):
                    result=imports.extract_recipe_html(page(keywords=keywords),'https://unknown.example/rezept')
                self.assertEqual(len(result['draft']['tags']),40)
                self.assertLessEqual(len(tag_calls),40)
                self.assertIn('recipe.import.truncated',result['warnings'])

    def test_explicit_serving_labels_all_locales_and_yield_alternatives(self):
        labels={'cs':'porce','de':'Portion(en)','en':'servings','es':'porciones','fr':'personnes','it':'porzioni',
                'nl':'porties','pl':'porcje','pt-BR':'porções','ru':'порций','sv':'portioner','zh-CN':'人份'}
        for locale,label in labels.items():
            with self.subTest(locale=locale):
                result=imports.extract_recipe_html(page(recipeYield='4 '+label),'https://unknown.example/rezept')
                self.assertEqual(result['draft']['base_servings'],4)
                self.assertNotIn('recipe.import.reviewServings',result['warnings'])
        for value,amount in [(['1','1 Portionen'],1),(['4','4 servings'],4),(['4 servings','24 cookies'],4),
                             ({'@type':'QuantitativeValue','value':4,'unitText':'Portionen'},4)]:
            with self.subTest(value=value):
                result=imports.extract_recipe_html(page(recipeYield=value),'https://unknown.example/rezept')
                self.assertEqual(result['draft']['base_servings'],amount)
                self.assertNotIn('recipe.import.reviewServings',result['warnings'])
        for value in [['12','12 cookies'],['1','1 Blech'],['4 servings','6 servings'],'1.000 Portionen','1,000 servings']:
            with self.subTest(value=value):
                result=imports.extract_recipe_html(page(recipeYield=value),'https://unknown.example/rezept')
                self.assertEqual(result['draft']['base_servings'],1)
                self.assertIn('recipe.import.reviewServings',result['warnings'])

    def test_save_envelope_budget_and_optional_image_overflow(self):
        self.assertEqual(imports._DRAFT_BYTE_BUDGET,512*1024-1024)
        large=page(recipeInstructions=[{'@type':'HowToStep','text':'x'*7000} for _ in range(70)])
        response=PublicResponse('https://unknown.example/rezept',large.encode(),'text/html','utf-8')
        with patch.object(imports,'fetch_public',side_effect=[response,PublicResponse('https://unknown.example/cake.png',b'placeholder','image/png')]), \
             patch.object(imports,'normalize_recipe_image_bytes',return_value={'content':b'x'*75000}):
            result=imports.import_recipe('https://unknown.example/rezept')
        self.assertNotIn('image_data',result['draft'])
        self.assertIn('recipe.import.imageUnavailable',result['warnings'])
        # A maximal legal client mutation ID must still fit the real save model.
        validated=imports.RecipeCreate.model_validate({**result['draft'],'client_mutation_id':'i'*200})
        self.assertLessEqual(len(validated.model_dump_json().encode()),512*1024)
        oversized=page(recipeInstructions=[{'@type':'HowToStep','text':'x'*7000} for _ in range(76)])
        with self.assertRaises(PublicFetchError) as error:
            imports.extract_recipe_html(oversized,'https://unknown.example/rezept')
        self.assertEqual(error.exception.code,'recipe.import.tooLarge')

    def test_yield_collection_is_bounded_before_per_value_cleaning(self):
        with patch.object(imports,'_text') as clean,self.assertRaises(PublicFetchError):
            imports._yield_alternatives(['4 servings']*10000)
        clean.assert_not_called()

    def test_fraction_and_ambiguous_ingredient_lines(self):
        for raw,quantity,unit,name in [('½ tbsp oil',.5,'tbsp','oil'),('1 1/4 tsp salt',1.25,'tsp','salt'),('0,25 l Milch',.25,'l','Milch'),('200g flour',200,'g','flour'),('2 xylitol',2,None,'xylitol'),('500 毫升 水',500,'ml','水')]:
            with self.subTest(raw=raw):
                ingredient,uncertain=imports.parse_ingredient(raw)
                self.assertFalse(uncertain); self.assertEqual((ingredient['quantity_value'],ingredient['quantity_unit'],ingredient['name']),(quantity,unit,name))
        for raw in ['2-3 EL Öl','1 x 400 g Tomaten','1 (400g) Dose Tomaten','1/0 l Wasser','0 g Salz','Mehl nach Bedarf','1/4','1.000 g Mehl','1,000 g flour','1 000 g Mehl','1.000,5 g Mehl']:
            with self.subTest(raw=raw):
                ingredient,uncertain=imports.parse_ingredient(raw)
                self.assertTrue(uncertain); self.assertEqual(ingredient['name'],raw); self.assertIsNone(ingredient['quantity_value'])

    def test_nonrecipes_and_oversized_aggregates_fail(self):
        for html in ['<html><title>Not a recipe</title></html>',page(recipeIngredient=[],recipeInstructions=[]),page(recipeIngredient=['g'*501])]:
            with self.subTest(html=html[:40]),self.assertRaises(PublicFetchError): imports.extract_recipe_html(html,'https://unknown.example/rezept')

    def test_optional_image_is_private_normalized_draft(self):
        raw=io.BytesIO();Image.new('RGB',(1600,800),'red').save(raw,format='PNG')
        calls=[]
        def download(url,**kwargs):
            calls.append((url,kwargs))
            return PublicResponse('https://unknown.example/rezept',page().encode(),'text/html','utf-8') if len(calls)==1 else PublicResponse(url,raw.getvalue(),'image/png')
        with patch.object(imports,'fetch_public',side_effect=download): result=imports.import_recipe('https://unknown.example/rezept')
        self.assertTrue(result['draft']['image_data'].startswith('data:image/webp;base64,'))
        normalized=normalize_recipe_image(result['draft']['image_data'])
        with Image.open(io.BytesIO(normalized['content'])) as image:self.assertLessEqual(max(image.size),1280)
        self.assertTrue(calls[1][1]['image']);self.assertEqual(calls[1][0],'https://unknown.example/cake.png')
        self.assertNotIn('image_url',result)
        with patch.object(imports,'fetch_public',return_value=PublicResponse('https://unknown.example/rezept',page().encode(),'text/html','utf-8')) as fetcher:
            no_image=imports.import_recipe('https://unknown.example/rezept',include_image=False)
        self.assertNotIn('image_data',no_image['draft']);self.assertEqual(fetcher.call_count,1)

    def test_html_meta_charset_without_http_charset(self):
        html=page().replace('<html>','<html><meta charset="windows-1252">')
        # ensure_ascii=False makes the charset relevant to actual recipe text.
        html=html.replace('Ein einfaches Rezept.', 'Grüße aus Köln')
        response=PublicResponse('https://unknown.example/rezept', html.encode('cp1252'),'text/html')
        with patch.object(imports,'fetch_public',return_value=response):
            result=imports.import_recipe('https://unknown.example/rezept',include_image=False)
        self.assertEqual(result['draft']['description'],'Grüße aus Köln')

    def test_image_failure_keeps_recipe_and_does_not_expose_image_url(self):
        responses=[PublicResponse('https://unknown.example/rezept',page(image='http://127.0.0.1/private').encode(),'text/html'),PublicFetchError('recipe.import.blockedUrl')]
        with patch.object(imports,'fetch_public',side_effect=responses): result=imports.import_recipe('https://unknown.example/rezept')
        self.assertEqual(result['draft']['title'],'Apfelkuchen')
        self.assertIn('recipe.import.imageUnavailable',result['warnings'])
        self.assertNotIn('image_data',result['draft']);self.assertNotIn('image_url',result)

    def test_endpoint_auth_validation_limits_and_sanitized_errors(self):
        app=FastAPI();app.include_router(route.router)
        client=TestClient(app)
        # Missing authentication is rejected before any page fetch.
        with patch.object(route,'import_recipe') as importer:
            response=client.post('/api/recipes/import-preview',json={'url':'https://example.com'})
            self.assertIn(response.status_code,[401,403]);importer.assert_not_called()
        app.dependency_overrides[require_auth]=lambda:777
        route._attempts.clear()
        with patch.object(route,'import_recipe',return_value={'draft':{'title':'Preview'},'warnings':[]}) as importer:
            self.assertEqual(client.post('/api/recipes/import-preview',json={'url':'https://example.com','include_image':'false'}).status_code,422)
            for _ in range(6):self.assertEqual(client.post('/api/recipes/import-preview',json={'url':'https://example.com','include_image':False}).status_code,200)
            self.assertEqual(client.post('/api/recipes/import-preview',json={'url':'https://example.com'}).status_code,429)
            self.assertEqual(importer.call_count,6)
        route._attempts.clear()
        with patch.object(route,'import_recipe',side_effect=PublicFetchError('recipe.import.blockedUrl')):
            response=client.post('/api/recipes/import-preview',json={'url':'http://127.0.0.1/private'})
            self.assertEqual(response.status_code,422);self.assertEqual(response.json(),{'detail':{'code':'recipe.import.blockedUrl'}})
        with patch.object(route,'_slots') as slots:
            slots.acquire.return_value=False
            self.assertEqual(client.post('/api/recipes/import-preview',json={'url':'https://example.com'}).status_code,429)
        route._attempts.clear()


if __name__=='__main__':unittest.main()
