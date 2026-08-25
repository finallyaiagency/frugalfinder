// POST /api/compare — run a 3-model comparison scan on a wishlist (or inline item).
// GET  /api/compare — performance summary across all runs.
import { getWishlist } from '../_lib/store.js';
import { compareModels, getModelPerf } from '../_lib/llm-compare.js';

export const maxDuration = 300;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Shared-secret guard
  const secret = process.env.WISHLIST_TOKEN;
  if (secret && req.headers['x-frugal-token'] !== secret) {
    res.status(401).json({ error: 'bad x-frugal-token' });
    return;
  }

  if (req.method === 'GET') {
    res.status(200).json(await getModelPerf());
    return;
  }

  if (req.method === 'POST') {
    let body = {};
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}

    let wl = null;
    if (body.wishlist_id) {
      wl = await getWishlist(body.wishlist_id);
      if (!wl) { res.status(404).json({ error: 'wishlist not found' }); return; }
    } else {
      wl = {
        id: 'adhoc-' + Date.now(),
        item: String(body.item || '').slice(0, 500),
        use_case: String(body.use_case || '').slice(0, 2000),
        budget: String(body.budget || '').slice(0, 300),
        flexibility: String(body.flexibility || '').slice(0, 500),
        cadence: 'daily',
      };
      if (!wl.item) { res.status(400).json({ error: 'item or wishlist_id required' }); return; }
    }

    const result = await compareModels(wl);
    res.status(result.ok ? 200 : 502).json(result);
    return;
  }

  res.status(405).json({ error: 'GET for perf, POST to compare' });
}