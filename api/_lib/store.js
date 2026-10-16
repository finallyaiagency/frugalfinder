// FrugalFinder storage layer — three tiers:
//   1. Vercel KV / Upstash (if KV_REST_API_URL + KV_REST_API_TOKEN set)  [best]
//   2. GitHub-backed JSON store (if GH_TOKEN + GH_DATA_REPO set)         [durable default]
//   3. In-memory Map fallback                                            [dev only]
// Memory always mirrors writes for fast reads within a warm instance.
// Keys are namespaced under ff:.

import { durableGet, durableSet } from './durable.js';

let memory = null;

function mem() {
  if (!memory) memory = new Map();
  return memory;
}

function getKV() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    const mod = require('@vercel/kv');
    return { kv: mod.kv, type: 'kv' };
  } catch {
    return null;
  }
}

export function storageMode() {
  if (getKV()) return 'vercel-kv';
  if ((process.env.GH_TOKEN || process.env.GITHUB_TOKEN) && process.env.GH_DATA_REPO) return 'github';
  return 'memory';
}

export async function put(key, value, ttlSeconds) {
  if (process.env.VERCEL_ENV === 'production' && storageMode() === 'memory') throw new Error('Persistent storage is not configured');
  const k = `ff:${key}`;
  const str = JSON.stringify(value);
  const store = getKV();
  if (store) {
    if (ttlSeconds) await store.kv.set(k, str, { ex: ttlSeconds });
    else await store.kv.set(k, str);
  } else {
    const entry = { v: str };
    if (ttlSeconds) entry.exp = Date.now() + ttlSeconds * 1000;
    mem().set(k, entry);
    if (!ttlSeconds && storageMode() === 'github') {
      // A successful response must mean the record survives a serverless recycle.
      // Do not quietly claim success when GitHub persistence is misconfigured.
      await durableSet(k, str);
    }
  }
}

export async function get(key) {
  if (process.env.VERCEL_ENV === 'production' && storageMode() === 'memory') throw new Error('Persistent storage is not configured');
  const k = `ff:${key}`;
  // memory first (fresh mirror)
  let raw = null;
  const entry = mem().get(k);
  if (entry && (!entry.exp || entry.exp > Date.now())) raw = entry.v;

  if (raw == null) {
    const store = getKV();
    if (store) {
      raw = await store.kv.get(k);
    } else if (storageMode() === 'github') {
      raw = await durableGet(k);
      if (raw != null) mem().set(k, { v: raw }); // cache in warm instance
    }
  }

  if (raw == null) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return raw; }
}

export async function del(key) {
  const k = `ff:${key}`;
  mem().delete(k);
  const store = getKV();
  if (store) await store.kv.del(k);
  // GitHub layer: leave tombstone-free; deletion is rare in this app
}

// ---- Wishlists -----------------------------------------------------------

const WL_PREFIX = 'wl:';
const WL_INDEX = 'wishlist-index';

async function indexAll() {
  return (await get(WL_INDEX)) || [];
}

async function indexSave(ids) {
  await put(WL_INDEX, ids);
}

export async function saveWishlist(wl) {
  await put(WL_PREFIX + wl.id, wl);
  const ids = await indexAll();
  if (!ids.includes(wl.id)) {
    ids.push(wl.id);
    await indexSave(ids);
  }
}

export async function getWishlist(id) {
  return get(WL_PREFIX + id);
}

export async function deleteWishlist(id) {
  await del(WL_PREFIX + id);
  const ids = await indexAll();
  await indexSave(ids.filter((savedId) => savedId !== id));
}

export async function wishlistStorageHealth() {
  const ids = await indexAll();
  if (!Array.isArray(ids)) throw new Error('Wishlist index is not an array');
  const missing = [];
  for (const id of ids) {
    if (!(await getWishlist(id))) missing.push(id);
  }
  return { backend: storageMode(), indexed: ids.length, readable: ids.length - missing.length, missing, checked_at: new Date().toISOString() };
}

export async function listWishlists() {
  const ids = await indexAll();
  const out = [];
  for (const id of ids) {
    const wl = await getWishlist(id);
    // A missing document must never silently remove an indexed wishlist.
    // Repair orphaned IDs explicitly after investigating the data repository.
    if (!wl) throw new Error(`Wishlist index references missing record: ${id}`);
    out.push(wl);
  }
  return out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function renewWishlist(id, days = 45) {
  const wl = await getWishlist(id);
  if (!wl) return null;
  const now = Date.now();
  const currentExpiry = wl.expires_at ? new Date(wl.expires_at).getTime() : now;
  // Extend from the later of now or current expiry
  const extendFrom = Math.max(now, currentExpiry);
  wl.expires_at = new Date(extendFrom + days * 86400e3).toISOString();
  wl.renew_count = (wl.renew_count || 0) + 1;
  wl.last_renewed_at = new Date().toISOString();
  wl.status = 'active';
  await saveWishlist(wl);
  return wl;
}

// Get wishlists expiring within N days (default 3), including already-expired
export async function getExpiringWishlists(days = 3) {
  const all = await listWishlists();
  const now = Date.now();
  const cutoff = now + days * 86400e3;
  return all.filter(w => {
    if (w.status !== 'active') return false;
    if (!w.expires_at) return false;
    const exp = new Date(w.expires_at).getTime();
    return exp <= cutoff;
  });
}

// Get already-expired wishlists
export async function getExpiredWishlists() {
  const all = await listWishlists();
  const now = Date.now();
  return all.filter(w => {
    if (w.status !== 'active') return false;
    if (!w.expires_at) return false;
    return new Date(w.expires_at).getTime() < now;
  });
}

// ---- Scan results --------------------------------------------------------

export async function appendScan(wishlistId, scan) {
  const wl = await getWishlist(wishlistId);
  if (!wl) return null;
  wl.scans = wl.scans || [];
  if (scan) wl.scans.unshift(scan);
  wl.scans = wl.scans.slice(0, 20);
  await saveWishlist(wl);
  return wl;
}
