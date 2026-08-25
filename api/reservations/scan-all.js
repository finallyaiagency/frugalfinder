// Cron target: scan all active reservation wishlists once per day (00:00 UTC).
import { listReservations, scanReservation } from '../_lib/reservations.js';

export const maxDuration = 300;

export default async function handler(req, res) {
  // Optional shared secret for cron endpoint
  const auth = req.headers.authorization;
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'bad cron secret' });
    return;
  }

  const all = await listReservations();
  const results = [];
  for (const res of all) {
    try {
      const scan = await scanReservation(res.id);
      results.push({
        id: res.id,
        ok: scan.ok,
        scanned: scan.scanned,
        best: scan.best ? {
          site_name: scan.best.site_name,
          campground: scan.best.campground_name,
          price: scan.best.price,
          score: scan.best.score,
          lakefront: scan.best.lakefront,
        } : null,
      });
    } catch (e) {
      results.push({ id: res.id, error: String(e) });
    }
  }
  res.status(200).json({ scanned: results.length, results });
}