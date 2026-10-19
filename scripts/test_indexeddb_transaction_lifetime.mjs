#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/__idb_test__.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>IndexedDB transaction test</title>');
    return;
  }
  const relativePath = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
  const filePath = join(root, relativePath || 'web/index.html');
  if (!filePath.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (!statSync(filePath).isFile()) throw new Error('not a file');
    response.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' });
    createReadStream(filePath).pipe(response);
  } catch (_error) {
    response.writeHead(404).end();
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/__idb_test__.html`);
  const result = await page.evaluate(async () => {
    const indexedDb = await import('/web/static/js/storage/indexed-db.js');
    await indexedDb.openDatabase();

    await indexedDb.putStrict('todos', { id: 'late-rejection', title: 'before' });
    let rejectionMessage = '';
    try {
      await indexedDb.transactionStrict(['todos'], 'readwrite', async transaction => {
        await transaction.put('todos', { id: 'late-rejection', title: 'must roll back' });
        await new Promise(resolve => setTimeout(resolve, 50));
        throw new Error('late operation failure');
      });
    } catch (error) {
      rejectionMessage = error?.message || String(error);
    }
    const afterRejection = await indexedDb.getStrict('todos', 'late-rejection');

    await indexedDb.putStrict('todos', { id: 'late-commit', title: 'before' });
    await indexedDb.transactionStrict(['todos'], 'readwrite', async transaction => {
      await transaction.put('todos', { id: 'late-commit', title: 'first write' });
      await new Promise(resolve => setTimeout(resolve, 50));
      await transaction.put('todos', { id: 'late-commit', title: 'committed after await' });
    });
    const afterCommit = await indexedDb.getStrict('todos', 'late-commit');
    await indexedDb.closeAndDeleteDatabase();
    return { rejectionMessage, afterRejection, afterCommit };
  });

  assert.match(result.rejectionMessage, /late operation failure/);
  assert.equal(result.afterRejection.title, 'before', 'a real delayed rejection must abort the browser IndexedDB transaction');
  assert.equal(result.afterCommit.title, 'committed after await', 'a real browser IndexedDB transaction must accept requests after an asynchronous await');
  console.log('✅ Browser IndexedDB transaction lifetime tests passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
