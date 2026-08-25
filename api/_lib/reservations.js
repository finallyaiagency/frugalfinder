// Campground reservation watcher library.
// Scans campgrounds for availability changes (especially preferred site types like lakefront)
// and feeds findings into the FrugalBot reasoning engine for value optimization.

import crypto from 'node:crypto';
import { saveWishlist, getWishlist, listWishlists, appendScan } from './store.js';
import { analyzeWishlist } from './frugal.js';

// Fetch campground metadata from recreation.gov public API (verified working)
export async function getCampgroundMeta(cgId) {
  const res = await fetch(
    `https://www.recreation.gov/api/camps/campgrounds/${cgId}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' } }
  );
  if (!res.ok) return null;
  const d = await res.json();
  const camp = d.campground || d;
  return {
    name: camp.facility_name || `Campground ${cgId}`,
    description: camp.facility_description_map?.Facilities || '',
    id: cgId,
  };
}

// Fetch campsite list for a campground (loops, attributes, status, price)
export async function getCampgroundSites(cgId) {
  const res = await fetch(
    `https://www.recreation.gov/api/search/campsites?fq=asset_id:${cgId}&size=100`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' } }
  );
  if (!res.ok) return [];
  const d = await res.json();
  return d.campsites || [];
}

function attributeNames(s) {
  return (s.attributes || []).map((a) => String(a.attribute_name || '').toLowerCase());
}

export function isLakefrontLike(s, meta) {
  const name = String(s?.name || '').toLowerCase();
  const loop = String(s?.loop || '').toLowerCase();
  const attrs = attributeNames(s);
  const mDesc = String(meta?.description || '').toLowerCase();
  return (
    name.includes('lake') ||
    loop.includes('lake') ||
    attrs.includes('lake') ||
    attrs.includes('lakefront') ||
    mDesc.includes('lake') ||
    attrs.includes('river') ||
    loop.includes('river')
  );
}

export function scoreSite(s, wl) {
  let score = 0;
  if (s.campsite_status === 'Open' && s.reservable !== false) score += 30;
  else if (s.campsite_status === 'Not Reservable') score = -10;
  else score += 10;

  if (wl.site_preference === 'lakefront' && isLakefrontLike(s, wl)) score += 40;
  if (wl.site_preference === 'riverfront' && (String(s.name || '').match(/river|creek/i) || String(s.loop || '').match(/river|creek/i))) score += 25;
  if ((wl.site_preference === 'shaded' || wl.min_features?.includes('shade')) && attributeNames(s).includes('shade')) score += 15;

  if (Array.isArray(wl.min_features)) {
    const attrs = attributeNames(s);
    for (const f of wl.min_features) {
      if (attrs.some((n) => n.includes(String(f).toLowerCase()))) score += 5;
    }
  }

  const price = parseFloat(s.price_range?.amount_max || s.price_range?.amount_min || 0);
  if (price > 0) score -= price / 3;
  return Math.round(score);
}

export function siteMatchesPrefs(s, wl) {
  const p = String(wl.site_preference || '').toLowerCase();
  if (!p || p === 'any') return true;
  if (p.includes('lake') && isLakefrontLike(s, wl)) return true;
  if (p.includes('river') && (s.name || '').match(/river|creek/i)) return true;
  if (p.includes('shade') && attributeNames(s).includes('shade')) return true;
  return false;
}

export async function listReservations() {
  const all = await listWishlists();
  return all.filter((w) => w.type === 'reservation');
}

export async function scanReservation(id) {
  const wl = await getWishlist(id);
  if (!wl) return { ok: false, error: 'reservation wishlist not found' };

  const results = { scanned: 0, candidates: [], best: null };
  let bestScore = -Infinity;
  let bestSite = null;

  for (const cgId of wl.campground_ids || []) {
    try {
      const meta = await getCampgroundMeta(cgId);
      const sites = await getCampgroundSites(cgId);
      results.scanned += 1;
      for (const s of sites || []) {
        const score = scoreSite(s, wl);
        const candidate = {
          campground_id: cgId,
          campground_name: meta?.name || `Campground ${cgId}`,
          site_id: s.campsite_id,
          site_name: s.name,
          loop: s.loop,
          status: s.campsite_status,
          price: s.price_range?.amount_max || s.price_range?.amount_min || '',
          attributes: attributeNames(s),
          lakefront: isLakefrontLike(s, meta),
          score,
          matches_preference: siteMatchesPrefs(s, wl),
        };
        results.candidates.push(candidate);
        if (score > bestScore && score >= 0) {
          bestScore = score;
          bestSite = candidate;
        }
      }
    } catch (e) {
      results.candidates.push({ error: String(e), campground_id: cgId });
    }
  }

  results.best = bestSite;
  const scan = {
    at: new Date().toISOString(),
    type: 'reservation-scan',
    ok: !!results.best,
    scanned: results.scanned,
    best: results.best,
    candidates: results.candidates
      .filter((c) => !c.error)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8),
  };

  const updated = await getWishlist(id);
  if (updated) {
    updated.scans = updated.scans || [];
    updated.scans.unshift(scan);
    updated.scans = updated.scans.slice(0, 30);
    updated.last_result = results.best
      ? {
          site_name: results.best.site_name,
          campground: results.best.campground_name,
          price: results.best.price,
          lakefront: results.best.lakefront,
          score: results.best.score,
          matches_preference: results.best.matches_preference,
        }
      : null;
    await saveWishlist(updated);
  }
  return scan;
}
