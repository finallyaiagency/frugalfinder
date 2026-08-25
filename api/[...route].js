// Single catch-all serverless function — routes /api/* internally.
// Keeps us under Vercel Hobby's 12-function limit.
import { saveWishlist, getWishlist, listWishlists, appendScan } from './_lib/store.js';
import { analyzeWishlist, buildUserPrompt } from './_lib/frugal.js';
import { getCampgroundMeta, getCampgroundSites, scanReservation, listReservations } from './_lib/reservations.js';
import { compareModels, getModelPerf } from './_lib/llm-compare.js';
import { waitUntil } from '@vercel/functions';

export const maxDuration = 300;

function json(res, code, obj) {
  res.status(code).json(obj);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const parts = path.split('/').filter(Boolean);
  const method = req.method;

  // ---- CORS: bookmarklets POST here from arbitrary pages ----
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Origin');
  }
  if (method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  try {
    // ---------------- health ----------------
    if (path === '' || path === 'health') {
      return json(res, 200, { ok: true, service: 'frugalfinder', endpoints: ['/api/wishlists', '/api/scan', '/api/scan-all', '/api/reservations', '/api/reservations/scan', '/api/compare', '/api/mcp', '/api/telegram'] });
    }

    // ---------------- wishlists ----------------
    if (parts[0] === 'wishlists') {
      const id = url.searchParams.get('id');

      if (method === 'POST' && !id) {
        let body = await readBody(req);
        const wl = {
          id: crypto.randomUUID(),
          item: String(body.item || '').slice(0, 500),
          use_case: String(body.use_case || '').slice(0, 2000),
          budget: String(body.budget || '').slice(0, 300),
          flexibility: String(body.flexibility || '').slice(0, 500),
          cadence: ['hourly', 'daily', 'weekly'].includes(body.cadence) ? body.cadence : 'daily',
          source_url: String(body.source_url || '').slice(0, 1000),
          status: 'active', scans: [],
          created_at: new Date().toISOString(),
          channel: ['mcp', 'telegram', 'web'].includes(body.channel) ? body.channel : 'web',
        };
        if (!wl.item) return json(res, 400, { error: 'item is required' });
        await saveWishlist(wl);
        const result = await analyzeWishlist(wl);
        if (result.ok) {
          wl.analysis = result.analysis;
          wl.model_used = result.model_used;
          wl.scans.unshift({ at: wl.created_at, type: 'initial-analysis', ok: true });
        } else {
          wl.scan_error = result.error;
          wl.scans.unshift({ at: wl.created_at, type: 'initial-analysis-failed', error: result.error });
        }
        await saveWishlist(wl);
        return json(res, 201, { ok: true, id: wl.id, wishlist: wl });
      }

      if (method === 'GET' && id) {
        const wl = await getWishlist(id);
        if (!wl) return json(res, 404, { error: 'not found' });
        return json(res, 200, wl);
      }

      if (method === 'GET') {
        return json(res, 200, { wishlists: await listWishlists() });
      }

      if (method === 'PATCH' && id) {
        const wl = await getWishlist(id);
        if (!wl) return json(res, 404, { error: 'not found' });
        const body = await readBody(req);
        for (const k of ['status', 'cadence', 'budget', 'flexibility', 'use_case', 'item']) {
          if (body[k] !== undefined) wl[k] = String(body[k]).slice(0, 2000);
        }
        await saveWishlist(wl);
        return json(res, 200, { ok: true, wishlist: wl });
      }
    }

    // ---------------- scan (single wishlist) ----------------
    if (parts[0] === 'scan') {
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: 'id required' });
      const wl = await getWishlist(id);
      if (!wl) return json(res, 404, { error: 'wishlist not found' });

      if (method === 'GET') {
        return json(res, 200, { wishlist_id: id, cadence: wl.cadence, last_scan: wl.scans?.[0] || null, analysis: wl.analysis || null });
      }
      if (method === 'POST') {
        const result = await analyzeWishlist(wl);
        const scan = { at: new Date().toISOString(), type: 'manual-scan', ok: !!result.ok, ...(result.ok ? { model_used: result.model_used } : { error: result.error }) };
        await appendScan(id, scan);
        if (result.ok) {
          wl.analysis = result.analysis;
          wl.model_used = result.model_used;
          await saveWishlist(wl);
        }
        return json(res, result.ok ? 200 : 502, { ...scan, analysis: result.ok ? result.analysis : null });
      }
    }

    // ---------------- scan-all (cron) ----------------
    if (parts[0] === 'scan-all' && method === 'POST') {
      const secret = process.env.CRON_SECRET;
      if (secret && req.headers.authorization !== `Bearer ${secret}`) {
        return json(res, 401, { error: 'bad cron secret' });
      }
      const all = await listWishlists();
      const windowsMs = { hourly: 3600e3, daily: 86400e3, weekly: 604800e3 };
      const now = Date.now();
      const results = [];
      for (const wl of all.filter(w => w.status === 'active' && !w.type)) {
        const last = wl.scans?.[0]?.at ? new Date(wl.scans[0].at).getTime() : 0;
        if (now - last < (windowsMs[wl.cadence] || windowsMs.daily)) continue;
        const result = await analyzeWishlist(wl);
        const scan = { at: new Date().toISOString(), type: 'scheduled-scan', ok: !!result.ok, ...(result.ok ? {} : { error: result.error }) };
        await appendScan(wl.id, scan);
        if (result.ok) { wl.analysis = result.analysis; await saveWishlist(wl); }
        results.push({ id: wl.id, item: wl.item, ok: scan.ok });
      }
      // Also scan due reservations while we're here (single cron covers both)
      for (const r of await listReservations()) {
        if (r.status !== 'active') continue;
        const last = r.scans?.[0]?.at ? new Date(r.scans[0].at).getTime() : 0;
        if (now - last < (windowsMs[r.cadence] || windowsMs.daily)) continue;
        const scan = await scanReservation(r.id);
        results.push({ id: r.id, reservation: true, ok: !!scan.best });
      }
      return json(res, 200, { scanned: results.length, results });
    }

    // ---------------- reservations ----------------
    if (parts[0] === 'reservations') {
      // /api/reservations/scan?id= — POST trigger
      if (parts[1] === 'scan') {
        const id = url.searchParams.get('id');
        if (!id) return json(res, 400, { error: 'id required' });
        const scan = await scanReservation(id);
        return json(res, scan.ok ? 200 : 502, scan);
      }

      const id = url.searchParams.get('id');
      if (method === 'POST') {
        const body = await readBody(req);
        const wl = {
          id: crypto.randomUUID(),
          type: 'reservation',
          campground_ids: Array.isArray(body.campground_ids)
            ? body.campground_ids.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
            : body.campground_ids ? [String(body.campground_ids).trim()] : [],
          site_preference: String(body.site_preference || 'any').slice(0, 100),
          min_features: Array.isArray(body.min_features) ? body.min_features.map(String).slice(0, 20) : [],
          max_price: String(body.max_price || '').slice(0, 100),
          date_window: String(body.date_window || 'next_30_days').slice(0, 200),
          cadence: ['hourly', 'due'].includes(body.cadence) ? body.cadence : (['hourly', 'daily', 'weekly'].includes(body.cadence) ? body.cadence : 'daily'),
          source_url: '', notes: String(body.notes || '').slice(0, 2000),
          status: 'active', scans: [],
          created_at: new Date().toISOString(),
          channel: body.channel || 'web',
        };
        if (!wl.campground_ids.length && !body.item) return json(res, 400, { error: 'campground_ids or item required' });
        if (!wl.campground_ids.length) wl.item = String(body.item).slice(0, 500);
        await saveWishlist(wl);
        waitUntil(scanReservation(wl.id).catch(() => {}));
        return json(res, 201, { ok: true, reservation_id: wl.id, _links: { scan_now: `/api/reservations/scan?id=${wl.id}` } });
      }
      if (method === 'GET' && id) {
        const wl = await getWishlist(id);
        if (!wl || wl.type !== 'reservation') return json(res, 404, { error: 'not found' });
        return json(res, 200, wl);
      }
      if (method === 'GET') {
        const items = await listReservations();
        return json(res, 200, { reservations: items.map((w) => ({ id: w.id, campground_ids: w.campground_ids, site_preference: w.site_preference, date_window: w.date_window, cadence: w.cadence, last_result: w.last_result, scans: (w.scans || []).length })) });
      }
      if (method === 'PATCH' && id) {
        const wl = await getWishlist(id);
        if (!wl || wl.type !== 'reservation') return json(res, 404, { error: 'not found' });
        const body = await readBody(req);
        for (const k of ['status', 'cadence', 'site_preference', 'max_price', 'date_window']) {
          if (body[k] !== undefined) wl[k] = String(body[k]).slice(0, 2000);
        }
        if (Array.isArray(body.min_features)) wl.min_features = body.min_features.map(String).slice(0, 20);
        if (Array.isArray(body.campground_ids)) wl.campground_ids = body.campground_ids.map(String).slice(0, 20);
        await saveWishlist(wl);
        return json(res, 200, { ok: true, reservation: wl });
      }
    }

    // ---------------- compare ----------------
    if (parts[0] === 'compare') {
      if (method === 'GET') {
        return json(res, 200, await getModelPerf());
      }
      if (method === 'POST') {
        const body = await readBody(req);
        let wl;
        if (body.wishlist_id) {
          wl = await getWishlist(body.wishlist_id);
          if (!wl) return json(res, 404, { error: 'wishlist not found' });
        } else {
          wl = { id: 'adhoc-' + Date.now(), item: String(body.item || ''), use_case: String(body.use_case || ''), budget: String(body.budget || ''), flexibility: String(body.flexibility || ''), cadence: 'daily' };
        }
        if (!wl.item) return json(res, 400, { error: 'item or wishlist_id required' });
        const result = await compareModels(wl);
        return json(res, result.ok ? 200 : 502, result);
      }
    }

    // ---------------- telegram ----------------
    if (parts[0] === 'telegram' && method === 'POST') {
      const tSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (tSecret && req.headers['x-telegram-bot-api-secret-token'] !== tSecret) {
        return json(res, 401, { error: 'bad webhook secret' });
      }
      const update = await readBody(req);
      const msg = update.message || update.edited_message;
      const chatId = msg?.chat?.id;
      const text = msg?.text || '';
      if (!chatId) return json(res, 200, { ok: true, ignored: true });

      // Reuse telegram-ingest parser via dynamic import
      const { createWishlist } = await import('./_lib/telegram-ingest.js');
      const reply = await createWishlist(text);
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (token) {
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: 'HTML' }),
        }).catch(() => {});
      }
      return json(res, 200, { ok: true });
    }

    // ---------------- mcp passthrough ----------------
    if (parts[0] === 'mcp') {
      const mcpHandler = (await import('./mcp-handler.js')).default;
      return mcpHandler(req, res);
    }

    return json(res, 404, { error: `unknown route ${method} /${path}` });
  } catch (err) {
    console.error('API error:', err);
    return json(res, 500, { error: String(err?.message || err), stack: String(err?.stack || '').split('\n')[0] });
  }
}
