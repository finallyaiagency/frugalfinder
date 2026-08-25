// MCP (Model Context Protocol) server for FrugalFinder — Streamable HTTP transport.
// Exposes wishlist tools so external agents (ChatGPT, Claude, Codex, Hermes) can
// submit wishlists and poll results. Deployed as a Vercel Node function.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { saveWishlist, getWishlist, listWishlists } from '../_lib/store.js';
import { analyzeWishlist } from '../_lib/frugal.js';

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
    cadence: z.enum(['hourly', 'daily', 'weekly']).optional().describe('Monitoring frequency (default daily)'),
    source_url: z.string().optional().describe('Optional URL of a listing that triggered this wish'),
  },
  async ({ item, use_case, budget, flexibility, cadence, source_url }) => {
    const wl = {
      id: crypto.randomUUID(),
      item: String(item).slice(0, 500),
      use_case: String(use_case || '').slice(0, 2000),
      budget: String(budget || '').slice(0, 300),
      flexibility: String(flexibility || '').slice(0, 500),
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

// Stateless request handler — one transport per request.
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const endpointSecret = process.env.MCP_TOKEN;
  if (endpointSecret && req.headers['x-mcp-token'] !== endpointSecret) {
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
