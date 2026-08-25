// FrugalFinder storage layer — Vercel KV (Upstash Redis) with graceful in-memory fallback.
// All data is JSON-serializable; keys are namespaced under ff:.

let memory = null;

function getKV() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    // Lazy import so the app works without @vercel/kv installed locally.
    const mod = require('@vercel/kv');
    return { kv: mod.kv, type: 'kv' };
  } catch {
    return null;
  }
}

function mem() {
  if (!memory) memory = new Map();
  return memory;
}

export async function put(key, value, ttlSeconds) {
  const k = `ff:${key}`;
  const store = getKV();
  if (store) {
    if (ttlSeconds) await store.kv.set(k, JSON.stringify(value), { ex: ttlSeconds });
    else await store.kv.set(k, JSON.stringify(value));
  } else {
    const entry = { v: JSON.stringify(value) };
    if (ttlSeconds) entry.exp = Date.now() + ttlSeconds * 1000;
    mem().set(k, entry);
  }
}

export async function get(key) {
  const k = `ff:${key}`;
  const store = getKV();
  let raw = null;
  if (store) {
    raw = await store.kv.get(k);
  } else {
    const entry = mem().get(k);
    if (entry && (!entry.exp || entry.exp > Date.now())) raw = entry.v;
  }
  if (raw == null) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return raw; }
}

export async function del(key) {
  const k = `ff:${key}`;
  const store = getKV();
  if (store) await store.kv.del(k);
  else mem().delete(k);
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
  for (const id of ids) {
    const wl = await getWishlist(id);
    if (wl) out.push(wl);
    else await indexSave((await indexAll()).filter(x => x !== id)); // prune dead
  }
  return out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// ---- Scan results --------------------------------------------------------

export async function appendScan(wishlistId, scan) {
  const wl = await getWishlist(wishlistId);
  if (!wl) return null;
  wl.scans = wl.scans || [];
  wl.scans.unshift(scan);
  wl.scans = wl.scans.slice(0, 20); // keep last 20 scans per wishlist
  await put(WL_PREFIX + wishlistId, wl);
  return wl;
}
