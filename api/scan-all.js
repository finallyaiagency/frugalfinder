import { listWishlists, getWishlist, appendScan, saveWishlist } from '../_lib/store.js';
import { analyzeWishlist } from '../_lib/frugal.js';

export const maxDuration = 300;

// Cron target (hourly per vercel.json). Scans every active wishlist whose
// cadence window has elapsed. Protect with CRON_SECRET in Vercel env.
export default async function handler(req, res) {
  const auth = req.headers.authorization;
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'bad cron secret' });
    return;
  }

  const all = await listWishlists();
  const now = Date.now();
  const windowsMs = { hourly: 3600e3, daily: 86400e3, weekly: 604800e3 };
  const results = [];

  for (const wl of all) {
    if (wl.status !== 'active') continue;
    const last = wl.scans?.[0]?.at ? new Date(wl.scans[0].at).getTime() : 0;
    const windowMs = windowsMs[wl.cadence] || windowsMs.daily;
    if (now - last < windowMs) continue;

    const result = await analyzeWishlist(wl);
    const scan = {
      at: new Date().toISOString(),
      type: 'scheduled-scan',
      ok: !!result.ok,
      ...(result.ok ? { analysis: result.analysis, model_used: result.model_used } : { error: result.error }),
    };
    await appendScan(wl.id, scan);
    if (result.ok) {
      wl.analysis = result.analysis;
      wl.model_used = result.model_used;
      await saveWishlist(wl);
    }
    results.push({ id: wl.id, item: wl.item, ok: scan.ok });
  }

  res.status(200).json({ scanned: results.length, results });
}
