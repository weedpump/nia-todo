#!/usr/bin/env node
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createMutationId } from '../web/static/js/core/mutation-id.js';
import { createCookbooksController } from '../web/static/js/features/cookbooks.js';
import { createShoppingListDetailsFeature } from '../web/static/js/features/shopping-list-details.js';

// No browser, service or database. Exercise both default production generators.
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalRandom = Math.random;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const setCrypto = value => Object.defineProperty(globalThis, 'crypto', { configurable: true, value });

async function createCookbook(options = {}) {
  const mutations = [];
  const controller = createCookbooksController({
    getCurrentUser: () => ({ id: 7 }),
    commitMutation: async build => { const mutation = build(); mutations.push(mutation); return mutation; },
    ...options,
  });
  const entity = await controller.create({ name: 'Offline cookbook' });
  return { entity, mutations };
}

async function createShoppingList(options = {}) {
  const mutations = [], errors = [];
  let lists = [];
  const fields = new Map([
    ['shopping-list-name', { value: 'Offline shopping' }],
    ['shopping-list-id', { value: '' }],
    ['shopping-list-form', { addEventListener() {}, removeEventListener() {} }],
    ['shopping-list-save-btn', {}],
  ]);
  const feature = createShoppingListDetailsFeature({
    document: { getElementById: id => fields.get(id) || null },
    getActorId: () => 7,
    getLists: () => lists,
    setLists: next => { lists = next; },
    commitMutation: async build => { const mutation = build(); mutations.push(mutation); return mutation; },
    onError: error => errors.push(error),
    ...options,
  });
  await feature.save();
  return { entity: lists[0], mutations, errors };
}

try {
  Math.random = () => { throw new Error('Insecure randomness must never be used'); };
  const expectedUuid = '12345678-1234-4234-9234-123456789abc';
  const secureContext = {
    randomUUID() { assert.equal(this, secureContext); return expectedUuid; },
    getRandomValues() { assert.fail('randomUUID is preferred when available'); },
  };
  setCrypto(secureContext);
  assert.equal(createMutationId('temp-'), `temp-${expectedUuid}`);
  assert.equal((await createCookbook()).entity.id, `temp-cookbook-${expectedUuid}`);
  assert.equal((await createShoppingList()).entity.id, `temp-shopping-list-${expectedUuid}`);

  let calls = 0;
  const httpContext = {
    getRandomValues(bytes) {
      assert.equal(this, httpContext, 'Web Crypto methods retain their receiver');
      assert.equal(bytes.length, 16);
      calls += 1;
      return webcrypto.getRandomValues(bytes);
    },
  };
  setCrypto(httpContext);
  const ids = new Set(Array.from({ length: 256 }, () => createMutationId()));
  assert.equal(ids.size, 256);
  for (const id of ids) assert.match(id, uuidPattern);
  for (const [create, prefix, action] of [
    [createCookbook, 'temp-cookbook-', 'CREATE_COOKBOOK'],
    [createShoppingList, 'temp-shopping-list-', 'CREATE_SHOPPING_LIST'],
  ]) {
    const { entity, mutations, errors = [] } = await create();
    assert.deepEqual(errors, []);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].action, action);
    assert(entity.id.startsWith(prefix));
    assert.match(entity.id.slice(prefix.length), uuidPattern);
    assert.equal(entity.created_by_user_id, 7);
    assert.equal(entity.client_mutation_id, entity.id);
    assert.equal(mutations[0].data.temp_id, entity.id);
    assert.equal(mutations[0].data.client_mutation_id, entity.id);
  }
  assert.equal(calls, 258, 'both consumers use secure bytes when randomUUID is unavailable');

  for (const unavailable of [undefined, {}]) {
    setCrypto(unavailable);
    assert.throws(() => createMutationId(), /Secure random number generation is unavailable/);
    await assert.rejects(createCookbook(), /Secure random number generation is unavailable/);
    const shopping = await createShoppingList();
    assert.equal(shopping.entity, undefined);
    assert.deepEqual(shopping.mutations, []);
    assert.equal(shopping.errors.length, 1);
    assert.match(shopping.errors[0].message, /Secure random number generation is unavailable/);
  }
  // Embedded consumers and deterministic tests retain their injected identities.
  assert.equal((await createCookbook({ createTempId: () => 'temp-cookbook-injected' })).entity.id, 'temp-cookbook-injected');
  assert.equal((await createShoppingList({ createTempListId: () => 'temp-shopping-list-injected' })).entity.id, 'temp-shopping-list-injected');
} finally {
  Math.random = originalRandom;
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  else delete globalThis.crypto;
}

console.log('✅ Secure mutation IDs, HTTP fallback, durable consumer identities and unavailable-crypto boundaries passed');
