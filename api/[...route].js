// Single catch-all serverless function — routes /api/* internally.
// Keeps us under Vercel Hobby's 12-function limit.
import { saveWishlist, getWishlist, listWishlists, appendScan, deleteWishlist, get, put, renewWishlist, getExpiringWishlists, getExpiredWishlists } from './_lib/store.js';
import { analyzeWishlist, buildUserPrompt } from './_lib/frugal.js';
import { wishlistFields, matchPreference } from './_lib/wishlist.js';
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
        const now = Date.now();
        const wl = {
          id: crypto.randomUUID(),
          ...wishlistFields(body),
          status: 'active', scans: [],
          created_at: new Date().toISOString(),
          channel: ['mcp', 'telegram', 'web'].includes(body.channel) ? body.channel : 'web',
          // Expiration: default 45 days, configurable via body.expires_in_days
          expires_at: new Date(now + (body.expires_in_days || 45) * 86400e3).toISOString(),
          renew_count: 0,
        };
        // Store chat_id from Telegram messages for notifications
        if (body.chat_id) wl.chat_id = body.chat_id;
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
        for (const k of ['status', 'cadence', 'budget', 'flexibility', 'use_case', 'item', 'notes', 'source_url']) {
          if (body[k] !== undefined) wl[k] = String(body[k]).slice(0, 2000);
        }
        if (body.match_preference !== undefined) wl.match_preference = matchPreference(body.match_preference);
        if (body.expires_in_days !== undefined) {
          const days = parseInt(body.expires_in_days, 10);
          if (days > 0) {
            const now = Date.now();
            const extendFrom = Math.max(now, wl.expires_at ? new Date(wl.expires_at).getTime() : now);
            wl.expires_at = new Date(extendFrom + days * 86400e3).toISOString();
            wl.renew_count = (wl.renew_count || 0) + 1;
            wl.last_renewed_at = new Date().toISOString();
          }
        }
        await saveWishlist(wl);
        return json(res, 200, { ok: true, wishlist: wl });
      }

      if (method === 'DELETE' && id) {
        const wl = await getWishlist(id);
        if (!wl) return json(res, 404, { error: 'not found' });
        await deleteWishlist(id);
        return json(res, 200, { ok: true, deleted: id });
      }
    }

    // ---------------- renew ----------------
    if (parts[0] === 'renew') {
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: 'id required' });
      const wl = await renewWishlist(id);
      if (!wl) return json(res, 404, { error: 'wishlist not found' });
      return json(res, 200, { ok: true, wishlist: wl, message: `Renewed for 45 days. Expires ${wl.expires_at}` });
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

      const token = process.env.TELEGRAM_BOT_TOKEN;

      // 1. Auto-archive expired wishlists
      const expired = await getExpiredWishlists();
      const notifications = [];
      for (const wl of expired) {
        if (wl.chat_id && token) {
          const daysAgo = Math.floor((Date.now() - new Date(wl.expires_at).getTime()) / 86400e3);
          notifications.push({
            chat_id: wl.chat_id,
            text: `🗑️ <b>Wishlist expired</b>\n\n<code>${wl.item}</code>\nExpired ${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago.\nIt has been archived and will no longer be scanned.\n\nReply with:\n<code>renew ${wl.id.slice(0, 8)}</code>\nto renew it for another 45 days.`,
          });
        }
        wl.status = 'expired';
        await saveWishlist(wl);
      }

      // 2. Notify about wishlists expiring soon (within 3 days)
      const expiring = await getExpiringWishlists(3);
      for (const wl of expiring) {
        if (wl.chat_id && token) {
          const daysLeft = Math.ceil((new Date(wl.expires_at).getTime() - Date.now()) / 86400e3);
          const renewHint = wl.renew_count > 0 ? ` (renewed ${wl.renew_count}x)` : '';
          notifications.push({
            chat_id: wl.chat_id,
            text: `⏰ <b>Wishlist expiring soon${renewHint}</b>\n\n<code>${wl.item}</code>\nExpires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.\n\nReply with:\n<code>renew ${wl.id.slice(0, 8)}</code>\nto renew for another 45 days.`,
          });
        }
      }

      // 3. Send notifications via Telegram
      for (const n of notifications) {
        await fetch(`${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: n.chat_id, text: n.text, parse_mode: 'HTML' }),
        }).catch(() => {});
      }

      // 4. Scan due wishlists
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
      return json(res, 200, { scanned: results.length, expiring: expiring.length, expired: expired.length, results });
    }

    // ---------------- reservations (removed — now handled by Groundbnb agent) ----------------
    if (parts[0] === 'reservations') {
      return json(res, 410, { error: 'Reservations are now handled by the Groundbnb agent. Use Groundbnb for campground and travel itinerary monitoring.' });
    }

    // ---------------- reservation scan (removed — now handled by Groundbnb agent) ----------------
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
      const text = msg?.text || msg?.caption || '';
      if (!chatId) return json(res, 200, { ok: true, ignored: true });

      // Telegram retries slow webhooks. Record the update before background work so a
      // retried update cannot create a second wishlist.
      const updateKey = update.update_id == null ? '' : `tg-update:${update.update_id}`;
      if (updateKey && await get(updateKey)) return json(res, 200, { ok: true, duplicate: true });

      const token = process.env.TELEGRAM_BOT_TOKEN;
      const send = async (reply) => {
        if (!token) return;
        const delivered = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: 'HTML' }),
        });
        if (!delivered.ok) throw new Error(`Telegram confirmation failed: ${delivered.status}`);
      };

      const { createWishlist, analyzeAndReply, shoppingIntent, listWishlists } = await import('./_lib/telegram-ingest.js');
      const photo = msg?.photo?.at(-1);
      const hasUrl = /https?:\/\/\S+/i.test(text);
      if (!shoppingIntent(text, { hasPhoto: !!photo, hasUrl })) {
        // Check for commands that createWishlist handles
        const cmdResult = await createWishlist(text, { chatId });
        if (cmdResult?.renewId) {
          // Handle renew command
          const wl = await renewWishlist(cmdResult.renewId);
          if (!wl) {
            await send(`❌ Wishlist not found.`);
          } else {
            await send(`✅ <b>Renewed!</b>\n\n<code>${wl.item}</code>\nNow expires in 45 days (${new Date(wl.expires_at).toLocaleDateString()}).\nRenewed ${wl.renew_count} time${wl.renew_count !== 1 ? 's' : ''}.`);
          }
          if (updateKey) await put(updateKey, true, 86400);
          return json(res, 200, { ok: true, renewed: cmdResult.renewId });
        }
        if (cmdResult?.statusCommand) {
          // Handle status command
          const all = await listWishlists();
          const myWishlists = all.filter(w => w.chat_id == chatId && w.status === 'active');
          if (!myWishlists.length) {
            await send('You have no active wishlists. Send me an item to get started!');
          } else {
            const lines = ['<b>Your active wishlists:</b>'];
            for (const wl of myWishlists) {
              const expDate = new Date(wl.expires_at);
              const daysLeft = Math.ceil((expDate.getTime() - Date.now()) / 86400e3);
              const status = daysLeft <= 0 ? '⏰ EXPIRED' : daysLeft <= 3 ? `⏰ ${daysLeft}d left` : `✅ ${daysLeft}d left`;
              lines.push(`\n• <code>${wl.item}</code>\n  ID: <code>${wl.id.slice(0, 8)}</code> ${status}`);
            }
            lines.push('\n\n<code>renew &lt;id&gt;</code> — renew for 45 days');
            await send(lines.join(''));
          }
          if (updateKey) await put(updateKey, true, 86400);
          return json(res, 200, { ok: true, status: true });
        }
        await send('I can chat, but I only create a wishlist when you ask me to shop, find, watch, or track something. Try <code>wishlist: patio heater</code>.');
        if (updateKey) await put(updateKey, true, 86400);
        return json(res, 200, { ok: true, ignored: true, reason: 'not-shopping-intent' });
      }

      let image_data_url = '';
      if (photo && token && photo.file_size <= 5_000_000) {
        const fileInfo = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(photo.file_id)}`).then(r => r.json());
        if (fileInfo.ok && fileInfo.result?.file_path) {
          const image = await fetch(`https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`);
          if (image.ok) image_data_url = `data:${image.headers.get('content-type') || 'image/jpeg'};base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`;
        }
      }
      const created = await createWishlist(text, { image_data_url, deferAnalysis: true, chatId });
      await send(created.reply);
      if (updateKey) await put(updateKey, { wishlist_id: created.wl.id }, 86400);
      waitUntil(analyzeAndReply(created.wl).then(send).catch(err => console.error('Telegram analysis notification failed:', err)));
      return json(res, 200, { ok: true });
    }

    // ---------------- mcp passthrough ----------------
    if (parts[0] === 'mcp') {
      return json(res, 404, { error: 'MCP is served by api/mcp.js; check the Vercel route configuration.' });
    }

    return json(res, 404, { error: `unknown route ${method} /${path}` });
  } catch (err) {
    console.error('API error:', err);
    return json(res, 500, { error: String(err?.message || err), stack: String(err?.stack || '').split('\n')[0] });
  }
}
