#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const source = new URL('../api/resources/routing_memory_rules.json', import.meta.url);
const target = new URL('../web/static/js/core/routing-memory-rule-data.js', import.meta.url);
const rules = JSON.parse(readFileSync(source, 'utf8'));
const text = '// Generated from api/resources/routing_memory_rules.json. Do not edit by hand.\nexport const routingMemoryRules = '+JSON.stringify(rules,null,2)+';\n';
if(process.argv.includes('--check')) {
 if(readFileSync(target,'utf8')!==text)throw Error('Routing memory rule data is stale; run node scripts/generate_routing_memory_rules.mjs');
} else writeFileSync(target,text);
