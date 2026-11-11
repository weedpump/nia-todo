#!/usr/bin/env node
// Pure personal-history inference: never opens a database, browser or service.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRoutingName, routingTokens, routingLookupNames, matchRoutingField, singleRoutingTypoEdit, matchRoutingTypoField,
  suggestRoutingRoute, suggestTaskRoutingRoute } from '../web/static/js/features/routing-memory-matcher.js';
import { routingMemoryRules } from '../web/static/js/core/routing-memory-rule-data.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const canonical = (value, key = '') => {
  if (Array.isArray(value)) {
    const result = value.map(item => canonical(item));
    return ['memory_fields', 'store_ids', 'history_fields', 'source_keys'].includes(key)
      ? result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : result;
  }
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k], k)])) : value;
};
function subset(actual, expected, label) {
  if (expected === null) return assert.equal(actual, null, label);
  assert.ok(actual && typeof actual === 'object', `${label}: expected a usable route`);
  for (const [key, value] of Object.entries(expected)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) subset(actual[key], value, `${label}.${key}`);
    else assert.deepEqual(canonical(actual[key], key), canonical(value, key), `${label}.${key}`);
  }
}
function numericRules(value, path = 'rules') {
  if (Array.isArray(value)) { for (const [i, item] of value.entries()) numericRules(item, `${path}[${i}]`); }
  else if (value && typeof value === 'object') { for (const [key, item] of Object.entries(value)) numericRules(item, `${path}.${key}`); }
  else assert.ok(typeof value === 'number' && Number.isFinite(value), `${path}: runtime configuration must contain numeric limits only, no lexical vocabulary`);
}
function propose(vector, rows = vector.entries) {
  return vector.module === 'tasks'
    ? suggestTaskRoutingRoute(rows, vector.name, vector.workspace_id, vector.project_id)
    : suggestRoutingRoute(rows, vector.name, vector.list_id);
}
function fieldRows(vector) {
  if (vector.module !== 'tasks') return vector.entries;
  return vector.entries.filter(row => row.project_id != null && ((row.workspace_id == null && vector.workspace_id == null)
    || row.workspace_id != null && vector.workspace_id != null && String(row.workspace_id) === String(vector.workspace_id)))
    .map(row => ({...row, shopping_list_id:row.project_id, list_known:Boolean(row.list_known ?? row.project_known ?? row.preferred)}));
}
export function runMatchingFixtures(fixture, label) {
  assert.equal(fixture.version, 2);
  const vectors = fixture.vectors.map(vector => ({...vector, entries:structuredClone(vector.entries || fixture.catalogs?.[vector.catalog])}));
  assert.equal(new Set(vectors.map(row => row.id)).size, vectors.length, 'fixture IDs must be unique');
  assert.ok(vectors.every(row => Array.isArray(row.entries)), 'every vector must have a personal evidence catalog');
  execFileSync(process.execPath, [join(root, 'scripts/generate_routing_memory_rules.mjs'), '--check'], {cwd:root, encoding:'utf8'});
  assert.deepEqual(routingMemoryRules, JSON.parse(readFileSync(join(root, 'api/resources/routing_memory_rules.json'), 'utf8')));
  numericRules(routingMemoryRules);
  const texts = ['Bitte Wäsche waschen und Wäsche 123', 'ＳＡＬＺ', 'Straße KEHREN', 'a 2 xl', '人,造黄油', '人 造黄油', '人造黄油', '🧺 café\u0301', 'ΟΣ ος', '𠀀米', 'x '.repeat(65), 'x'.repeat(4097)];
  const edits = [
    ['abcdefg','abcdefg',false], ['abcdefg','abcxefg',true],
    ['abcdefg','abcdxefg',true], ['abcdefgh','abdefgh',true],
    ['abcdefg','abdcefg',true], ['abcdefg','abedcfg',false],
    ['abcdefg','xbcdefh',false], ['abcdefg','abcdef',false],
    ['abcdef','abcdexf',false], ['𐐨abcde','𐐨abcdf',false],
    ['𐐨abcdef','𐐨abcdeg',true], ['ABCDEFG','abcxefg',true],
    ['有机全麦面粉袋','有机全麦米粉袋',false],
  ];
  const python = process.env.NIA_TODO_TEST_PYTHON || (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
  const script = `import json,sys
from services.routing_matcher import suggest_route,suggest_task_route,match_field,routing_tokens,routing_lookup_names,single_typo_edit,typo_field_match
payload=json.load(sys.stdin)
results=[]
for row in payload['vectors']:
 entries=row['entries']
 route=suggest_task_route(entries,row['name'],row.get('workspace_id'),row.get('project_id')) if row.get('module')=='tasks' else suggest_route(entries,row['name'],row.get('list_id'))
 if row.get('module')=='tasks':
  entries=[dict(e,shopping_list_id=e['project_id'],list_known=bool(e.get('list_known',e.get('project_known',e.get('preferred',False))))) for e in entries if e.get('project_id') is not None and ((e.get('workspace_id') is None and row.get('workspace_id') is None) or (e.get('workspace_id') is not None and row.get('workspace_id') is not None and str(e['workspace_id'])==str(row['workspace_id'])))]
 fields={field:match_field(entries,row['name'],field,row.get('project_id') if row.get('module')=='tasks' else row.get('list_id')) for field in ['list','section','stores']}
 typos={field:typo_field_match(entries,row['name'],field,row.get('project_id') if row.get('module')=='tasks' else row.get('list_id')) for field in ['list','section','stores']}
 results.append(dict(route=route,fields=fields,typos=typos))
print(json.dumps(dict(results=results,tokens=[routing_tokens(s) for s in payload['texts']],lookups=[routing_lookup_names(s) for s in payload['texts']],edits=[single_typo_edit(left,right) for left,right,_ in payload['edits']]),ensure_ascii=False))`;
  const backend = JSON.parse(execFileSync(python, ['-c', script], {cwd:join(root,'api'), env:{...process.env,PYTHONPATH:join(root,'api')},
    input:JSON.stringify({vectors,texts,edits}), encoding:'utf8', maxBuffer:16*1024*1024}));
  for (const [index,[left,right,expected]] of edits.entries()) {
    assert.equal(singleRoutingTypoEdit(left,right),expected,`one elementary edit: ${left}/${right}`);
    assert.equal(singleRoutingTypoEdit(right,left),expected,'edit distance is symmetric');
    assert.equal(backend.edits[index],expected,'Unicode edit primitive has Python parity');
  }
  assert.deepEqual(texts.map(routingTokens), backend.tokens, 'whole Unicode tokens, no stopwords, character/input budgets: Python parity');
  assert.deepEqual(texts.map(routingLookupNames), backend.lookups, 'literal focused-recall candidates: Python parity');
  assert.deepEqual(routingTokens('Bitte Wäsche waschen und Wäsche 123'), ['bitte','wäsche','waschen','und','wäsche','123'], 'short words, repeated words, numbers and courtesy words stay present');
  let positives=0, abstentions=0;
  const failures=[];
  for (const [index, vector] of vectors.entries()) {
    try {
      const untouched=structuredClone(vector.entries), result=propose(vector);
      subset(result,vector.expected,vector.id);
      assert.deepEqual(canonical(result),canonical(backend.results[index].route),`${vector.id}: JS/Python route/evidence parity`);
      for (const field of ['list','section','stores']) {
        const decision=matchRoutingField(fieldRows(vector),vector.name,field,vector.module==='tasks'?vector.project_id:vector.list_id);
        assert.deepEqual(canonical(decision),canonical(backend.results[index].fields[field]),`${vector.id}: ${field} decision/source/score parity`);
        const typo=matchRoutingTypoField(fieldRows(vector),vector.name,field,vector.module==='tasks'?vector.project_id:vector.list_id);
        assert.deepEqual(canonical(typo),canonical(backend.results[index].typos[field]),`${vector.id}: independent ${field} typo-stage parity`);
      }
      assert.deepEqual(canonical(propose(vector,[...vector.entries].reverse())),canonical(result),`${vector.id}: row order cannot choose a preference`);
      assert.deepEqual(vector.entries,untouched,`${vector.id}: inference is read-only, never self-reinforces`);
      if(result) {assert.equal(result.name_key,normalizeRoutingName(vector.name),'complete entered title must survive');positives++;} else abstentions++;
    } catch(error) { failures.push(`${vector.id}: ${error.message}`); }
  }
  if(failures.length) assert.fail(`${failures.length}/${vectors.length} ${label} failures:\n${failures.slice(0,15).join('\n')}`);
  console.log(`PASS ${vectors.length} ${label}: ${positives} proposals, ${abstentions} abstentions, field/source/score JS/Python parity, order invariance and read-only inference`);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runMatchingFixtures(JSON.parse(readFileSync(new URL('./fixtures/routing_memory_matching.json',import.meta.url),'utf8')),'personal-history matching fixtures');
}
