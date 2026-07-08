#!/usr/bin/env node
import { beginFrontendDbSuite, prepareFreshDb, restoreFrontendDbSuite } from './frontend_test_lib.mjs';

const action = process.argv[2];

try {
  if (action === 'begin') {
    beginFrontendDbSuite();
    console.log('📦 Frontend suite DB backup created.');
  } else if (action === 'prepare-shared') {
    process.env.NIA_TODO_FRONTEND_DB_SUITE = '1';
    await prepareFreshDb();
    console.log('🧪 Shared frontend test DB prepared.');
  } else if (action === 'restore') {
    restoreFrontendDbSuite();
    console.log('🔄 Frontend suite DB restored.');
  } else {
    console.error('Usage: node scripts/frontend_db_suite.mjs begin|prepare-shared|restore');
    process.exit(2);
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
