import { getWishlist, listWishlists, saveWishlist } from './_lib/store.js';

export const maxDuration = 300;

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');

  if (req.method === 'GET') {
    if (id) {
      const wl = await getWishlist(id);
      if (!wl) { res.status(404).json({ error: 'not found' }); return; }
      res.status(200).json(wl);
      return;
    }
    res.status(200).json({ wishlists: await listWishlists() });
    return;
  }

  if (req.method === 'PATCH' && id) {
    const wl = await getWishlist(id);
    if (!wl) { res.status(404).json({ error: 'not found' }); return; }
    let body = {};
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}
    for (const k of ['status', 'cadence', 'budget', 'flexibility', 'use_case', 'item']) {
      if (body[k] !== undefined) wl[k] = String(body[k]).slice(0, 2000);
    }
    await saveWishlist(wl);
    res.status(200).json({ ok: true, wishlist: wl });
    return;
  }

  res.status(405).json({ error: 'Use GET or PATCH' });
}
