// Parses a Telegram message into a wishlist and calls the internal API logic.
import crypto from 'node:crypto';
import { saveWishlist } from './store.js';
import { analyzeWishlist, buildUserPrompt } from './frugal.js';
import { shoppingIntent, wishlistFields, matchPreference } from './wishlist.js';

// Travel/campground intent that should be handled by Groundbnb, not FrugalFinder
const TRAVEL_KEYWORDS = [
  'campsite', 'campground', 'camp site', 'camp ground', 'rv site', 'tent site',
  'reservation', 'recreation.gov', 'recreation gov', 'national park', 'state park',
  'kOA', 'koa', 'hipcamp', 'the dyrt', 'tent camping', 'rv camping',
  'itinerary', 'trip planning', 'road trip', 'vacation planning', 'travel itinerary',
  'dan nicholas', 'stone mountain', 'lake norman', 'falls lake', 'jordan lake',
  'camping spot', 'campsite availability', 'campground hookup', 'electric hookup rv',
  'lakeside camping', 'waterfront campsite', 'lakefront campground',
];

export function isTravelIntent(text) {
  const lower = String(text || '').toLowerCase();
  return TRAVEL_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

export function getTravelRedirectMessage() {
  return [
    '🏕️ It looks like you\'re asking about camping or travel — that\'s handled by my friend <b>Groundbnb</b>!',
    '',
    'Groundbnb specializes in:',
    '• Campsite & campground availability',
    '• RV site upgrades with hookups',
    '• Lakefront and waterfront sites',
    '• Trip itinerary improvements',
    '',
    'Message the <b>Groundbnb</b> bot to get help with your trip!',
  ].join('\n');
}

// Format: first line = item, then key: value lines for use/budget/flex/cadence.
// Or just freeform text — FrugalBot will infer fields.
export async function createWishlist(text, options = {}) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length && !options.image_data_url) return 'Send me what you want to find a deal on!';

  // Check for travel/camping intent — redirect to Groundbnb
  if (isTravelIntent(text)) {
    return getTravelRedirectMessage();
  }

  // Simple /start or help
  if (/^\/(start|help)$/i.test(lines[0])) {
    return [
      '<b>FrugalFinder Wishlist Bot</b>',
      '',
      'Send me an item and I\'ll start hunting for the best-value deal.',
      '',
      'Simple format:',
      '<code>wishlist: kayak',
      'use: flatwater fishing on lakes',
      'budget: under $400',
      'flex: any brand, used OK, prefer 10ft+</code>',
      '',
      '(or just describe it in plain English — I\'ll figure out the fields)',
      '',
      'Each wishlist expires after 45 days. I\'ll remind you to renew it.',
      '',
      '<b>Commands:</b>',
      '<code>renew &lt;id&gt;</code> — renew a wishlist for 45 more days',
      '<code>status</code> — see your active wishlists and expiration dates',
    ].join('\n');
  }

  // Handle: renew <id>
  const renewMatch = text.match(/^\/?renew\s+([a-f0-9-]{36})/i);
  if (renewMatch) {
    return { renewId: renewMatch[1] };
  }

  // Handle: status command
  if (/^\/?status$/i.test(text.trim())) {
    return { statusCommand: true };
  }

  const wl = {
    id: crypto.randomUUID(),
    ...wishlistFields({
      item: normalizeItem(lines[0] || 'Identify the item in this photo'),
      source_url: (text.match(/https?:\/\/\S+/) || [])[0] || '',
    }),
    status: 'active', scans: [],
    created_at: new Date().toISOString(),
    channel: 'telegram',
    chat_id: options.chatId || null,
    expires_at: new Date(Date.now() + (options.expires_in_days || 45) * 86400e3).toISOString(),
    renew_count: 0,
  };

  for (const line of lines.slice(1)) {
    let m;
    if ((m = line.match(/^(use|use case|purpose)\s*[:\-]\s*(.+)/i))) wl.use_case = m[2].slice(0, 2000);
    else if ((m = line.match(/^(budget|price|max)\s*[:\-]\s*(.+)/i))) wl.budget = m[2].slice(0, 300);
    else if ((m = line.match(/^(flex|flexibility|brand|quality|age)\s*[:\-]\s*(.+)/i))) wl.flexibility = m[2].slice(0, 500);
    else if ((m = line.match(/^(notes?|constraints?|must[- ]?have)\s*[:\-]\s*(.+)/i))) wl.notes = m[2].slice(0, 2000);
    else if ((m = line.match(/^(match|mode|preference)\s*[:\-]\s*(exact|similar|alternatives)/i))) wl.match_preference = matchPreference(m[2]);
    else if ((m = line.match(/^(cadence|frequency|scan)\s*[:\-]\s*(hourly|daily|weekly)/i))) wl.cadence = m[2].toLowerCase();
  }

  await saveWishlist(wl);
  if (options.deferAnalysis) {
    // Keep the potentially large Telegram image only in this invocation; persisting
    // it would exceed common KV limits and leaks an unnecessary copy.
    wl.image_data_url = options.image_data_url || '';
    return { wl, reply: `✅ Added <b>${escapeHtml(wl.item)}</b> to your wishlist. I’m checking the photo/listing and will send the value analysis shortly.\n<i>ID <code>${wl.id}</code> · scanning ${wl.cadence}</i>` };
  }
  return analyzeAndReply(wl);
}

export async function analyzeAndReply(wl) {
  const result = await analyzeWishlist(wl);
  delete wl.image_data_url;

  if (!result.ok) {
    return `⚠️ Saved your wishlist for <b>${escapeHtml(wl.item)}</b> (id <code>${wl.id}</code>) but the analysis failed: ${escapeHtml(result.error || 'unknown')}\nI'll retry at the next scheduled scan.`;
  }

  wl.analysis = result.analysis;
  await saveWishlist(wl);

  return formatAnalysisReply(wl, result.analysis);
}

export { shoppingIntent };

function normalizeItem(text) {
  let item = String(text || '').trim();
  // Strip leading action prefixes
  item = item.replace(/^(add|find|search|track|watch|buy|i want|i need|looking for|get me|help me find|let'?s find|please find|start tracking|put this on)\s+/i, '');
  // Strip trailing wishlist fluff
  item = item.replace(/\s*(to\s+(my\s+)?wishlist|to\s+(the\s+)?wishlist|on\s+(my\s+)?wishlist|from\s+(my\s+)?wishlist)$/i, '');
  // Strip leading "wishlist:" prefix (legacy format)
  item = item.replace(/^wishlist:\s*/i, '');
  return item.trim();
}

export function formatAnalysisReply(wl, a) {
  const out = [`✅ <b>FrugalBot analysis — ${escapeHtml(wl.item)}</b>`];
  if (a.recommendation?.target) {
    out.push('');
    out.push(`🎯 <b>Target:</b> ${escapeHtml(a.recommendation.target)} (${escapeHtml(a.recommendation.condition || 'any')})`);
    if (a.recommendation.good_deal_range) out.push(`💰 <b>Good deal range:</b> ${escapeHtml(a.recommendation.good_deal_range)}`);
    if (Array.isArray(a.recommendation.where_to_look) && a.recommendation.where_to_look.length) {
      out.push(`📍 <b>Where:</b> ${a.recommendation.where_to_look.map(escapeHtml).join(', ')}`);
    }
  }
  if (Array.isArray(a.alternatives) && a.alternatives.length) {
    out.push('');
    out.push('<b>Alternatives worth considering:</b>');
    for (const alt of a.alternatives.slice(0, 3)) {
      out.push(`• ${escapeHtml(alt.item)} — ${escapeHtml(alt.why || '')} ${alt.est_price_range ? '(' + escapeHtml(alt.est_price_range) + ')' : ''}`);
    }
  }
  if (a.joy_analysis) { out.push(''); out.push(`⚖️ <b>Joy vs cost:</b> ${escapeHtml(a.joy_analysis)}`); }
  if (a.notes) { out.push(''); out.push(`💡 ${escapeHtml(a.notes)}`); }
  if (wl.id) { out.push(''); out.push(`<i>ID <code>${wl.id}</code> · scanning ${wl.cadence} · view scans at /?id=${wl.id}</i>`); }
  return out.join('\n');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
