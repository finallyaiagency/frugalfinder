// Telegram webhook: forward any message/text to the wishlist API.
// Set TELEGRAM_BOT_TOKEN + verify secret token match in Vercel env.
import { createWishlist } from './_lib/telegram-ingest.js';

export const maxDuration = 300;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    res.status(401).json({ error: 'bad webhook secret' });
    return;
  }

  let update = {};
  try { update = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}

  const msg = update.message || update.edited_message;
  const text = msg?.text || '';
  const chatId = msg?.chat?.id;

  if (!chatId) { res.status(200).json({ ok: true, ignored: true }); return; }

  const reply = await createWishlist(text);

  // Reply to the user via Telegram API
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: 'HTML' }),
    }).catch(() => {});
  }

  res.status(200).json({ ok: true });
}
