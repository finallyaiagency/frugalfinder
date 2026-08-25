// POST /api/reservations  — create a reservation wishlist.
import crypto from 'node:crypto';
import { saveWishlist } from './_lib/store.js';

export const maxDuration = 300;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const secret = process.env.WISHLIST_TOKEN;
  if (secret && req.headers['x-frugal-token'] !== secret) {
    res.status(401).json({ error: 'bad x-frugal-token' }); return;
  }
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}

  const wl = {
    id: crypto.randomUUID(),
    type: 'reservation',
    campground_ids: Array.isArray(body.campground_ids)
      ? body.campground_ids.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
      : body.campground_ids
        ? [String(body.campground_ids).trim()]
        : [],
    site_preference: String(body.site_preference || 'any').slice(0, 100),
    min_features: Array.isArray(body.min_features)
      ? body.min_features.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
      : [],
    max_price: String(body.max_price || '').slice(0, 100),
    date_window: String(body.date_window || 'next_30_days').slice(0, 200),
    cadence: ['hourly', 'daily', 'weekly'].includes(body.cadence) ? body.cadence : 'daily',
    source_url: String(body.source_url || '').slice(0, 1000),
    notes: String(body.notes || '').slice(0, 2000),
    status: 'active',
    scans: [],
    created_at: new Date().toISOString(),
    channel: body.channel || 'web',
  };

  if (!wl.campground_ids.length && !body.item) {
    res.status(400).json({ error: 'At least one campground_id or item is required.' }); return;
  }
  // Fallback: if only item is provided, treat as text description for FrugalBot to infer campgrounds
  if (!wl.campground_ids.length && body.item) {
    wl.item = String(body.item).slice(0, 500);
  }

  await saveWishlist(wl);
  setImmediate(async () => {
    try {
      const { scanReservation } = await import('./_lib/reservations.js');
      await scanReservation(wl.id);
    } catch {}
  });

  res.status(201).json({
    ok: true, reservation_id: wl.id,
    _links: { scan_now: `/api/reservations/scan?id=${wl.id}`, view: `/?id=${wl.id}` },
  });
}
