import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/[...route].js';

function response() {
  return { headers: {}, statusCode: 0, body: null, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end() {} };
}

async function call(method, url, body) {
  const res = response();
  await handler({ method, url, headers: {}, body }, res);
  return res;
}

test('wishlist API preserves notes/match mode and supports deletion', async () => {
  const created = await call('POST', '/api/wishlists', { item: 'faux-stone panel', notes: 'must fit 48 inches', match_preference: 'exact', cadence: 'weekly' });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.wishlist.notes, 'must fit 48 inches');
  assert.equal(created.body.wishlist.match_preference, 'exact');
  const id = created.body.id;
  const changed = await call('PATCH', `/api/wishlists?id=${id}`, { notes: 'must fit 48 inches; no real stone' });
  assert.equal(changed.body.wishlist.notes, 'must fit 48 inches; no real stone');
  const removed = await call('DELETE', `/api/wishlists?id=${id}`);
  assert.equal(removed.statusCode, 200);
});

test('Telegram ordinary conversation is acknowledged without creating a wishlist', async () => {
  const res = await call('POST', '/api/telegram', { update_id: 991001, message: { chat: { id: 1 }, text: 'Thanks, that helps.' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, true);
});
