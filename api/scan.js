import { getWishlist, appendScan } from '../_lib/store.js';
import { analyzeWishlist } from '../_lib/frugal.js';

export const maxDuration = 300;

// POST /api/scan?id=<wishlist-id>  → run a frugal-bot analysis pass now.
// GET  /api/scan?id=<wishlist-id>  → return latest scan result (polling endpoint).
export default async function handler(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('id');
  if (!id) { res.status(400).json({ error: 'id required' }); return; }

  const wl = await getWishlist(id);
  if (!wl) { res.status(404).json({ error: 'wishlist not found' }); return; }

  if (req.method === 'GET') {
    res.status(200).json({
      wishlist_id: id,
      cadence: wl.cadence,
      last_scan: wl.scans?.[0] || null,
      scan_count: wl.scans?.length || 0,
      analysis: wl.analysis || null,
    });
    return;
  }

  if (req.method === 'POST') {
    const result = await analyzeWishlist(wl);
    const scan = {
      at: new Date().toISOString(),
      type: 'manual-scan',
      ok: !!result.ok,
      ...(result.ok ? { analysis: result.analysis, model_used: result.model_used } : { error: result.error }),
    };
    await appendScan(id, scan);
    if (result.ok) {
      wl.analysis = result.analysis;
      wl.model_used = result.model_used;
      // persist analysis onto the wishlist object too
      await appendScan(id, null).catch(() => {}); // no-op to keep signature
      await saveAnalysis(id, result.analysis, result.model_used);
    }
    res.status(result.ok ? 200 : 502).json(scan);
    return;
  }

  res.status(405).json({ error: 'Use GET or POST' });
}

async function saveAnalysis(id, analysis, model) {
  const { saveWishlist, getWishlist } = await import('../_lib/store.js');
  const wl = await getWishlist(id);
  if (!wl) return;
  wl.analysis = analysis;
  wl.model_used = model;
  await saveWishlist(wl);
}
