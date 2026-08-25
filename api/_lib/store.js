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
  if ((process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) return 'github';
  return 'memory';
}

export async function put(key, value, ttlSeconds) {
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
      await durableSet(k, str).catch(() => {}); // non-fatal
    }
  }
}

export async function get(key) {
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
      raw = await durableGet(k).catch(() => null);
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

export async function listWishlists() {
  const ids = await indexAll();
  const out = [];
  let dirty = false;
  for (const id of ids) {
    const wl = await getWishlist(id);
    if (wl) out.push(wl); else dirty = true;
  }
  if (dirty) await indexSave(out.map((w) => w.id));
  return out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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
