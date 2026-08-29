// MCP (Model Context Protocol) server for FrugalFinder — Streamable HTTP transport.
// Exposes wishlist tools so external agents (ChatGPT, Claude, Codex, Hermes) can
// submit wishlists and poll results. Deployed as a Vercel Node function.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { saveWishlist, getWishlist, listWishlists, deleteWishlist } from './_lib/store.js';
import { analyzeWishlist } from './_lib/frugal.js';
import { matchPreference } from './_lib/wishlist.js';
import { scanReservation, listReservations } from './_lib/reservations.js';
import { compareModels, getModelPerf } from './_lib/llm-compare.js';

export const maxDuration = 300;

const server = new McpServer({
  name: 'frugalfinder',
  version: '0.1.0',
});

server.tool(
  'submit_wishlist',
  {
    item: z.string().describe('The item wanted, e.g. "10ft fishing kayak"'),
    use_case: z.string().describe('What the buyer will actually use it for'),
    budget: z.string().describe('Budget constraints, e.g. "under $400" or "$200-350"'),
    flexibility: z.string().optional().describe('Flexibility on brand/quality/age/condition'),
    notes: z.string().optional().describe('Constraints, measurements, compatibility requirements, or other non-negotiables'),
    match_preference: z.enum(['exact', 'similar', 'alternatives']).optional().describe('exact = named item/spec only; similar = close substitutes; alternatives = solve the need differently'),
    cadence: z.enum(['hourly', 'daily', 'weekly']).optional().describe('Monitoring frequency (default daily)'),
    source_url: z.string().optional().describe('Optional URL of a listing that triggered this wish'),
  },
  async ({ item, use_case, budget, flexibility, notes, match_preference, cadence, source_url }) => {
    const wl = {
      id: crypto.randomUUID(),
      item: String(item).slice(0, 500),
      use_case: String(use_case || '').slice(0, 2000),
      budget: String(budget || '').slice(0, 300),
      flexibility: String(flexibility || '').slice(0, 500),
      notes: String(notes || '').slice(0, 2000),
      match_preference: matchPreference(match_preference),
      cadence: cadence || 'daily',
      source_url: String(source_url || '').slice(0, 1000),
      status: 'active', scans: [],
      created_at: new Date().toISOString(),
      channel: 'mcp',
    };
    await saveWishlist(wl);
    const result = await analyzeWishlist(wl);
    if (result.ok) {
      wl.analysis = result.analysis;
      wl.scans.unshift({ at: wl.created_at, type: 'mcp-initial', ok: true });
      await saveWishlist(wl);
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          wishlist_id: wl.id,
          saved: true,
          cadence: wl.cadence,
          analysis: result.ok ? result.analysis : null,
          error: result.ok ? null : result.error,
          _links: { scans: `/api/mcp → tool get_wishlist(id="${wl.id}")`, web_view: `/?id=${wl.id}` },
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'get_wishlist',
  { id: z.string() },
  async ({ id }) => {
    const wl = await getWishlist(id);
    if (!wl) return { content: [{ type: 'text', text: JSON.stringify({ error: 'not found' }) }] };
    return { content: [{ type: 'text', text: JSON.stringify(wl, null, 2) }] };
  }
);

server.tool(
  'update_wishlist',
  { id: z.string(), item: z.string().optional(), use_case: z.string().optional(), budget: z.string().optional(), flexibility: z.string().optional(), notes: z.string().optional(), match_preference: z.enum(['exact', 'similar', 'alternatives']).optional(), cadence: z.enum(['hourly', 'daily', 'weekly']).optional() },
  async ({ id, ...changes }) => {
    const wl = await getWishlist(id);
    if (!wl) return { content: [{ type: 'text', text: JSON.stringify({ error: 'not found' }) }] };
    for (const field of ['item', 'use_case', 'budget', 'flexibility', 'notes', 'cadence']) if (changes[field] !== undefined) wl[field] = changes[field];
    if (changes.match_preference !== undefined) wl.match_preference = matchPreference(changes.match_preference);
    await saveWishlist(wl);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, wishlist: wl }, null, 2) }] };
  }
);

server.tool(
  'delete_wishlist', { id: z.string().describe('Wishlist id to permanently remove') },
  async ({ id }) => {
    if (!await getWishlist(id)) return { content: [{ type: 'text', text: JSON.stringify({ error: 'not found' }) }] };
    await deleteWishlist(id);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, deleted: id }) }] };
  }
);

server.tool(
  'list_wishlists',
  {},
  async () => {
    const all = await listWishlists();
    const summary = all.map(w => ({ id: w.id, item: w.item, budget: w.budget, cadence: w.cadence, status: w.status, scans: w.scans?.length || 0 }));
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
);

server.tool(
  'trigger_scan',
  { id: z.string().describe('wishlist id to scan now') },
  async ({ id }) => {
    const wl = await getWishlist(id);
    if (!wl) return { content: [{ type: 'text', text: JSON.stringify({ error: 'not found' }) }] };
    const result = await analyzeWishlist(wl);
    const scan = { at: new Date().toISOString(), type: 'mcp-triggered', ok: !!result.ok, ...(result.ok ? {} : { error: result.error }) };
    wl.scans.unshift(scan);
    wl.scans = wl.scans.slice(0, 20);
    if (result.ok) { wl.analysis = result.analysis; wl.model_used = result.model_used; }
    await saveWishlist(wl);
    return { content: [{ type: 'text', text: JSON.stringify({ ...scan, analysis: result.ok ? result.analysis : null }, null, 2) }] };
  }
);

// ---- Campground reservation tools ---------------------------------------

server.tool(
  'submit_reservation_watch',
  {
    campground_ids: z.array(z.string()).describe('Recreation.gov campground facility IDs to watch, e.g. ["233117"]'),
    date_window: z.string().optional().describe('Date range wanted, e.g. "2026-10-09 to 2026-10-12" or "next 30 days"'),
    site_preference: z.enum(['any', 'lakefront', 'riverfront', 'shaded']).optional().describe('Preferred site type — lakefront outranks plain sites if one frees up'),
    min_features: z.array(z.string()).optional().describe('Required site attributes, e.g. ["pets allowed", "shade", "paved driveway"]'),
    max_price: z.string().optional().describe('Max $/night e.g. "$35"'),
    cadence: z.enum(['hourly', 'daily', 'weekly']).optional().describe('Scan frequency (default daily)'),
    notes: z.string().optional().describe('Free-text context for the frugal analysis'),
  },
  async ({ campground_ids, date_window, site_preference, min_features, max_price, cadence, notes }) => {
    const wl = {
      id: crypto.randomUUID(),
      type: 'reservation',
      campground_ids,
      date_window: date_window || 'next_30_days',
      site_preference: site_preference || 'any',
      min_features: min_features || [],
      max_price: max_price || '',
      cadence: cadence || 'daily',
      notes: notes || '',
      status: 'active', scans: [],
      created_at: new Date().toISOString(),
      channel: 'mcp',
    };
    await saveWishlist(wl);
    const scan = await scanReservation(wl.id);
    return {
      content: [{ type: 'text', text: JSON.stringify({
        reservation_id: wl.id,
        saved: true,
        first_scan: { ok: scan.ok, best_site: scan.best?.site_name, campground: scan.best?.campground_name, price: scan.best?.price, lakefront: scan.best?.lakefront },
        candidates_found: scan.candidates?.length || 0,
        _links: { scan_now: `tool trigger_reservation_scan(id="${wl.id}")`, web_view: `/?id=${wl.id}` },
      }, null, 2) }],
    };
  }
);

server.tool(
  'list_reservations',
  {},
  async () => {
    const items = await listReservations();
    return { content: [{ type: 'text', text: JSON.stringify(items.map(w => ({
      id: w.id, campground_ids: w.campground_ids, site_preference: w.site_preference,
      date_window: w.date_window, cadence: w.cadence,
      last_best: w.last_result, scans: (w.scans || []).length,
    })), null, 2) }] };
  }
);

server.tool(
  'trigger_reservation_scan',
  { id: z.string().describe('reservation id to re-scan now') },
  async ({ id }) => {
    const scan = await scanReservation(id);
    return { content: [{ type: 'text', text: JSON.stringify(scan, null, 2) }] };
  }
);

// ---- Multi-LLM comparison tools ------------------------------------------

server.tool(
  'run_model_comparison',
  {
    item: z.string(),
    use_case: z.string(),
    budget: z.string(),
    flexibility: z.string().optional(),
  },
  async ({ item, use_case, budget, flexibility }) => {
    const wl = { id: 'adhoc-' + crypto.randomUUID(), item, use_case, budget, flexibility: flexibility || '', cadence: 'daily' };
    const r = await compareModels(wl);
    return {
      content: [{ type: 'text', text: JSON.stringify({
        ok: r.ok,
        best_tier: r.best_tier,
        worst_tier: r.worst_tier,
        judge_reasoning: r.judge?.reasoning || r.judge?.error || null,
        per_model: r.entries.map(e => ({ tier: e.tier, model: e.slug, score: e.score ?? null, cost_est_usd: e.cost_est, error: e.error })),
        total_cost_est_usd: r.total_cost_est,
        winning_analysis: r.winning_analysis,
      }, null, 2) }],
    };
  }
);

server.tool(
  'get_model_performance',
  {},
  async () => {
    const perf = await getModelPerf();
    return { content: [{ type: 'text', text: JSON.stringify(perf, null, 2) }] };
  }
);

// Stateless request handler — one transport per request.
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // MCP_PREVIEW_TOKEN is intentionally Preview-only: it lets a team verify a
  // protected preview without sharing the production client credential.
  const endpointSecrets = [process.env.MCP_TOKEN, process.env.MCP_PREVIEW_TOKEN].filter(Boolean);
  if (endpointSecrets.length && !endpointSecrets.includes(req.headers['x-mcp-token'])) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'bad x-mcp-token' }, id: null });
    return;
  }

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
    res.on('close', () => { transport.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(err?.message || err) }, id: null });
    }
  }
}
