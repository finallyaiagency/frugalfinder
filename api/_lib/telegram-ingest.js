// Parses a Telegram message into a wishlist and calls the internal API logic.
import crypto from 'node:crypto';
import { saveWishlist } from './store.js';
import { analyzeWishlist, buildUserPrompt } from './frugal.js';

// Format: first line = item, then key: value lines for use/budget/flex/cadence.
// Or just freeform text — FrugalBot will infer fields.
export async function createWishlist(text) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return 'Send me what you want to find a deal on!';

  // Simple /start or help
  if (/^\/?(start|help)$/i.test(lines[0])) {
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
    ].join('\n');
  }

  const wl = {
    id: crypto.randomUUID(),
    item: lines[0].replace(/^wishlist:\s*/i, '').slice(0, 500),
    use_case: '', budget: '', flexibility: '', cadence: 'daily',
    source_url: (text.match(/https?:\/\/\S+/) || [])[0] || '',
    status: 'active', scans: [],
    created_at: new Date().toISOString(),
    channel: 'telegram',
  };

  for (const line of lines.slice(1)) {
    let m;
    if ((m = line.match(/^(use|use case|purpose)\s*[:\-]\s*(.+)/i))) wl.use_case = m[2].slice(0, 2000);
    else if ((m = line.match(/^(budget|price|max)\s*[:\-]\s*(.+)/i))) wl.budget = m[2].slice(0, 300);
    else if ((m = line.match(/^(flex|flexibility|brand|quality|age)\s*[:\-]\s*(.+)/i))) wl.flexibility = m[2].slice(0, 500);
    else if ((m = line.match(/^(cadence|frequency|scan)\s*[:\-]\s*(hourly|daily|weekly)/i))) wl.cadence = m[2].toLowerCase();
  }

  await saveWishlist(wl);
  const result = await analyzeWishlist(wl);

  if (!result.ok) {
    return `⚠️ Saved your wishlist for <b>${escapeHtml(wl.item)}</b> (id <code>${wl.id}</code>) but the analysis failed: ${escapeHtml(result.error || 'unknown')}\nI'll retry at the next scheduled scan.`;
  }

  wl.analysis = result.analysis;
  await saveWishlist(wl);

  return formatAnalysisReply(wl, result.analysis);
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
