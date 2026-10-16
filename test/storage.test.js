import test from 'node:test';
import assert from 'node:assert/strict';
import { put, get, listWishlists, wishlistStorageHealth, storageMode } from '../api/_lib/store.js';

test('wishlist index remains unchanged when a referenced document is missing', async () => {
  assert.equal(storageMode(), 'memory');
  const ids = ['test-missing-record'];
  await put('wishlist-index', ids);
  await assert.rejects(listWishlists(), /missing record/);
  assert.deepEqual(await get('wishlist-index'), ids);
  const health = await wishlistStorageHealth();
  assert.equal(health.indexed, 1);
  assert.deepEqual(health.missing, ids);
});

test('healthy wishlist records are listed without modifying the index', async () => {
  const id = 'test-present-record';
  await put('wl:' + id, { id, item: 'test item', created_at: '2026-01-01T00:00:00Z' });
  await put('wishlist-index', [id]);
  const list = await listWishlists();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.deepEqual(await get('wishlist-index'), [id]);
});
