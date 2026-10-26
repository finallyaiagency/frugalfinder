import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/[...route].js';

const ACCESS_KEY = 'test-ownership-secret-with-at-least-32-characters';
process.env.WISHLIST_TOKEN = ACCESS_KEY;
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-telegram-webhook-secret';

function response() {
  return {
    headers: {}, statusCode: 0, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() {},
  };
}

async function call(method, url, body, headers = { authorization: `Bearer ${ACCESS_KEY}` }) {
  const res = response();
  await handler({ method, url, headers, body }, res);
  return res;
}

test('public health endpoint remains available', async () => {
  const res = await call('GET', '/api/health', undefined, {});
  assert.equal(res.statusCode, 200);
});

test('wishlist listing and paid analysis require owner authentication', async () => {
  assert.equal((await call('GET', '/api/wishlists', undefined, {})).statusCode, 401);
  assert.equal((await call('POST', '/api/wishlists', { item: 'hijack' }, {})).statusCode, 401);
  assert.equal((await call('PATCH', '/api/wishlists?id=anything', { item: 'hijack' }, {})).statusCode, 401);
  assert.equal((await call('DELETE', '/api/wishlists?id=anything', undefined, {})).statusCode, 401);
  assert.equal((await call('POST', '/api/scan?id=anything', undefined, {})).statusCode, 401);
  assert.equal((await call('POST', '/api/compare', { item: 'hijack' }, {})).statusCode, 401);
  assert.equal((await call('POST', '/api/renew?id=anything', undefined, {})).statusCode, 401);
  assert.equal((await call('GET', '/api/wishlists', undefined, { authorization: 'Bearer wrong' })).statusCode, 401);
});

test('login issues HttpOnly session cookie, usable without the access key in browser JS', async () => {
  const unauthorized = await call('POST', '/api/auth/login', { token: 'wrong' }, {});
  assert.equal(unauthorized.statusCode, 401);
  const loggedIn = await call('POST', '/api/auth/login', { token: ACCESS_KEY }, {});
  assert.equal(loggedIn.statusCode, 200);
  const setCookie = loggedIn.headers['Set-Cookie'];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0];
  const session = await call('GET', '/api/auth/session', undefined, { cookie });
  assert.equal(session.statusCode, 200);
  assert.equal((await call('GET', '/api/wishlists', undefined, { cookie })).statusCode, 200);
  const logout = await call('POST', '/api/auth/logout', undefined, { cookie });
  assert.equal(logout.statusCode, 200);
  assert.match(logout.headers['Set-Cookie'], /Max-Age=0/);
});

test('unconfigured access fails closed', async () => {
  const original = process.env.WISHLIST_TOKEN;
  process.env.WISHLIST_TOKEN = 'short';
  try {
    assert.equal((await call('GET', '/api/wishlists')).statusCode, 401);
    assert.equal((await call('POST', '/api/auth/login', { token: 'short' }, {})).statusCode, 503);
  } finally {
    process.env.WISHLIST_TOKEN = original;
  }
});

test('wishlist API preserves notes/match mode and supports deletion with authorized key', async () => {
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

test('Telegram requires a webhook secret, then acknowledges ordinary conversation', async () => {
  const payload = { update_id: 991001, message: { chat: { id: 1 }, text: 'Thanks, that helps.' } };
  const unauthorized = await call('POST', '/api/telegram', payload, {});
  assert.equal(unauthorized.statusCode, 401);
  const authorized = await call('POST', '/api/telegram', payload, {
    'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET,
  });
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.body.ignored, true);
});
