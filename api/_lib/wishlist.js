export const MATCH_PREFERENCES = ['exact', 'similar', 'alternatives'];

export function shoppingIntent(text, { hasPhoto = false, hasUrl = false } = {}) {
  const value = String(text || '').trim();
  if (hasPhoto || hasUrl) return true;
  if (!value || /^\/(start|help|settings|stop|status)\b/i.test(value)) return false;
  return /\b(wishlist|wish\s*list|find|search|shop|buy|purchase|deal|watch|track|monitor|looking\s+for|need\s+(?:a|an|to\s+buy))\b/i.test(value) || /^wishlist\s*:/i.test(value);
}

export function matchPreference(value) {
  const normalized = String(value || 'similar').trim().toLowerCase();
  return MATCH_PREFERENCES.includes(normalized) ? normalized : 'similar';
}

export function wishlistFields(body = {}) {
  return {
    item: String(body.item || '').slice(0, 500), use_case: String(body.use_case || '').slice(0, 2000),
    budget: String(body.budget || '').slice(0, 300), flexibility: String(body.flexibility || '').slice(0, 500),
    notes: String(body.notes || '').slice(0, 2000), match_preference: matchPreference(body.match_preference),
    cadence: ['hourly', 'daily', 'weekly'].includes(body.cadence) ? body.cadence : 'daily',
    source_url: String(body.source_url || '').slice(0, 1000),
  };
}
