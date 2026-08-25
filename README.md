# FrugalFinder

**Best-value deal hunting as a service.** Submit what you want + why + budget; a FrugalBot agent periodically scans and returns the best *value* opportunity — not the cheapest, not the fanciest.

## Architecture (MVP)

```
[Web UI / Telegram bot / MCP client agents] 
        ↓ POST
   Vercel serverless API  ──→  Vercel KV store (wishlists + scans)
        ↓                        ↑
   FrugalBot analyzer            │ scheduled re-scan
   (OpenRouter LLM)      ────────┘  (Vercel Cron, hourly tick)
```

## Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Web UI: submit wishlist, view analysis |
| `/api/wishlists` | POST | Create wishlist → runs first FrugalBot analysis |
| `/api/wishlists?id=` | GET/PATCH | Fetch or update one wishlist |
| `/api/scan?id=` | GET/POST | Poll latest scan / trigger scan now |
| `/api/scan-all` | POST | Cron target — scans all due wishlists |
| `/api/telegram` | POST | Telegram webhook ingest |
| `/api/mcp` | POST | MCP Streamable HTTP endpoint for external AI agents |

## Env vars (set in Vercel dashboard → Settings → Environment Variables)

- `OPENROUTER_API_KEY` (required) — LLM provider
- `FRUGAL_MODEL` (optional, default `stealth/ox-alpha`) — any OpenRouter model slug
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` (required for production persistence) — from a Vercel KV (Upstash) database attached in Vercel → Storage
- `WISHLIST_TOKEN` (optional) — shared secret for `/api/wishlists`
- `CRON_SECRET` (optional but recommended) — protects `/api/scan-all`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (optional) — Telegram ingest
- `MCP_TOKEN` (optional) — shared secret for `/api/mcp`

## Sharing paths

### Bookmarklet
Create a bookmark with URL:
```javascript
javascript:(function(){var u=location.href;var t=document.title;prompt('Send to FrugalFinder? Add budget/use hints:',t+'\n'+u)&&fetch('https://YOUR-DOMAIN.vercel.app/api/wishlists',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item:t,source_url:u,budget:'see notes',use_case:'shared from '+u,cadence:'daily'})}).then(r=>r.json()).then(d=>alert('Added! id='+d.id))})()
```

### Email (MVP note)
Not yet wired — MVP uses web UI + Telegram + bookmarklet. Email ingest is a natural v2 addition via an inbound-email webhook (e.g. Resend/Postmark → `/api/wishlists`).

## Pricing tiers (recommended)

| Tier | Cadence | Price rationale |
|---|---|---|
| Free | daily | ~30 LLM calls/mo/item at $0 marginal cost on free stealth models ≈ negligible infra |
| Power | hourly | $0.01/scan × ~720 scans/mo = **$7.20/mo per item** — price at **$5/mo flat**, margin comes from batching multiple wishlists into one hourly cron tick |
| Pro (future) | hourly + priority queue + email digests | $12/mo |

The unit economics only work because the analyzer batches all due wishlists into a single cron pass (`/api/scan-all`), amortizing cold-start overhead.

## Auth roadmap (post-MVP)

1. MVP now: no auth, single-user, guarded by optional shared secrets.
2. v1.1: magic-link email login (Auth.js or Clerk free tier) → per-user wishlists keyed by user ID.
3. v2: Stripe checkout for Power/Pro tiers; usage metering = count of scans per billing period.

## Local dev

```bash
npm install
vercel dev   # needs `vercel link` once
npm test    # node:test unit tests
```

## MCP usage (for external agents like ChatGPT/Claude/Codex)

Connect an MCP-capable client to:
```
https://YOUR-DOMAIN.vercel.app/api/mcp
```
Headers: `x-mcp-token: <MCP_TOKEN>` if set.

Exposed tools:
- `submit_wishlist(item, use_case, budget, flexibility?, cadence?, source_url?)` → saves + immediate analysis
- `get_wishlist(id)` → full record incl. latest analysis & scan history
- `list_wishlists()` → summary of all active wishlists
- `trigger_scan(id)` → force an out-of-band frugal-bot scan

Calling agents should treat it as **submit + poll**: submit once, then call `get_wishlist` on whatever cadence suits them (or wait for their own scheduler). The MCP spec has no push channel for arbitrary updates, so periodic polling is the standard pattern.
