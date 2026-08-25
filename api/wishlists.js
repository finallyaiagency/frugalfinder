import crypto from 'node:crypto';
import { saveWishlist } from './_lib/store.js';
import { analyzeWishlist } from './_lib/frugal.js';

export const maxDuration = 300; // Vercel Pro allows up to 300s on serverless

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  // Simple shared-secret guardrail (set WISHLIST_TOKEN in Vercel env).
  const token = process.env.WISHLIST_TOKEN;
  if (token) {
    const provided = req.headers['x-frugal-token'] || new URL(req.url, 'http://x').searchParams.get('token');
    if (provided !== token) {
      res.status(401).json({ error: 'Bad or missing x-frugal-token' });
      return;
    }
  }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}

  const wl = {
    id: crypto.randomUUID(),
    item: String(body.item || '').slice(0, 500),
    use_case: String(body.use_case || '').slice(0, 2000),
    budget: String(body.budget || '').slice(0, 300),
    flexibility: String(body.flexibility || '').slice(0, 500),
    cadence: ['hourly', 'daily', 'weekly'].includes(body.cadence) ? body.cadence : 'daily',
    source_url: String(body.source_url || '').slice(0, 1000),
    status: 'active',
    scans: [],
    created_at: new Date().toISOString(),
    channel: body.channel === 'mcp' ? 'mcp' : (body.channel === 'telegram' ? 'telegram' : 'web'),
  };

  if (!wl.item) {
    res.status(400).json({ error: 'item is required (what do you want?)' });
    return;
  }

  await saveWishlist(wl);

  // Fire-and-forget first scan so the UI has something immediately.
  // We don't await the full analysis before responding if client sets ?async=1.
  if (new URL(req.url, 'http://x').searchParams.get('async') !== '1') {
    const result = await analyzeWishlist(wl);
    if (result.ok) {
      wl.analysis = result.analysis;
      wl.model_used = result.model_used;
      wl.scans.unshift({ at: wl.created_at, type: 'initial-analysis', result });
      await saveWishlist(wl);
    } else {
      wl.scan_error = result.error;
      wl.scans.unshift({ at: wl.created_at, type: 'initial-analysis-failed', error: result.error });
      await saveWishlist(wl);
    }
  }

  res.status(201).json({
    ok: true,
    id: wl.id,
    wishlist: wl,
    _links: {
      self: `/api/wishlists/${wl.id}`,
      scans: `/api/scan/${wl.id}`,
      web_view: `/?id=${wl.id}`,
    },
  });
}
