// GET /api/reservations          — list all
// GET /api/reservations?id=      — fetch one
// POST /api/reservations/scan?id= — trigger scan now
// PATCH /api/reservations?id=    — update preferences
import { getWishlist, listWishlists, saveWishlist } from '../_lib/store.js';
import { listReservations, scanReservation } from '../_lib/reservations.js';

export const maxDuration = 300;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const url = new URL(req.url, 'http://x');

  // POST scan trigger
  if (req.method === 'POST' && url.pathname.endsWith('/scan')) {
    const id = url.searchParams.get('id');
    if (!id) { res.status(400).json({ error: 'id required' }); return; }
    const scan = await scanReservation(id);
    res.status(scan.ok ? 200 : 502).json(scan);
    return;
  }

  // GET list or single
  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) {
      const items = await listReservations();
      const summary = items.map((w) => ({
        id: w.id,
        campground_ids: w.campground_ids,
        date_window: w.date_window,
        site_preference: w.site_preference,
        cadence: w.cadence,
        status: w.status,
        last_result: w.last_result,
        scans: (w.scans || []).length,
      }));
      res.status(200).json({ reservations: summary });
      return;
    }
    const wl = await getWishlist(id);
    if (!wl || wl.type !== 'reservation') { res.status(404).json({ error: 'not found' }); return; }
    res.status(200).json(wl);
    return;
  }

  // PATCH update
  if (req.method === 'PATCH') {
    const id = url.searchParams.get('id');
    const wl = await getWishlist(id);
    if (!wl || wl.type !== 'reservation') { res.status(404).json({ error: 'not found' }); return; }
    let body = {};
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}
    for (const k of ['status', 'cadence', 'site_preference', 'max_price', 'date_window']) {
      if (body[k] !== undefined) wl[k] = String(body[k]).slice(0, 2000);
    }
    if (Array.isArray(body.min_features)) wl.min_features = body.min_features.map((x) => String(x)).slice(0, 20);
    if (Array.isArray(body.campground_ids)) wl.campground_ids = body.campground_ids.map((x) => String(x)).slice(0, 20);
    await saveWishlist(wl);
    res.status(200).json({ ok: true, reservation: wl });
    return;
  }

  res.status(405).json({ error: 'Use GET, PATCH, or POST /scan' });
}