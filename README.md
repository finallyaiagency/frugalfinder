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
| `/api/reservations` | POST | Create campground reservation watcher (Recreation.gov) |
| `/api/reservations?id=` | GET/PATCH | List/fetch/update reservation watchers |
| `/api/reservations/scan?id=` | POST | Trigger reservation scan now |
| `/api/compare` | POST/GET | 3-model LLM comparison scan / performance summary |
| `/admin.html` | GET | Admin dashboard: LLM quality-vs-cost monitor |

## Campground Reservation Watcher

Watch multiple Recreation.gov campgrounds for openings in your date window.
`site_preference: "lakefront"` scores lakefront sites higher when they free up via cancellation.
Scoring: availability + preference match + features (shade, pets, paved driveway) − price.

```bash
curl -X POST https://YOUR-DOMAIN.vercel.app/api/reservations \
  -H 'Content-Type: application/json' \
  -d '{"campground_ids":["233117","232665"],"date_window":"2026-10-09 to 2026-10-12","site_preference":"lakefront","cadence":"daily"}'
```

Known limit: Recreation.gov's date-based availability endpoint currently returns 404 to anonymous
callers (API changed). The scanner uses their public site-metadata search (verified working:
loops, attributes, status, price). When date-level availability is re-exposed, wire it into
`getCampgroundSites()` — everything downstream already handles it. ReserveAmerica (NC state parks)
blocks anonymous API calls; add as a provider with cookies/session if needed later.

## Multi-LLM Comparison ("quality vs cost control")

`POST /api/compare` races three model tiers on the same frugal-bot prompt:

| Tier | Default model | Purpose |
|---|---|---|
| `pareto` | `openrouter/auto` | OpenRouter's own best-model routing |
| `budget_web` | `openai/gpt-4.1-nano` (+web plugin) | cheapest web-capable |
| `mid_web` | `perplexity/sonar` | mid-range web-capable |

A judge (`anthropic/claude-opus-4.1`) then ranks all three blind (order-shuffled), scoring 1–10.
Every run logs tokens/cost/score/wins to the perf store; `GET /api/compare` aggregates them and
`/admin.html` visualizes. All slugs are env-overridable weekly without code changes:
`PARETO_MODEL`, `BUDGET_WEB_MODEL`, `MID_WEB_MODEL`, `JUDGE_MODEL`.

Verified live run: mid_web (Sonar) scored 9 vs pareto (routed DeepSeek v4 flash) 8 vs budget (GPT-4.1-nano) 4–7, total cost ≈ $0.05/comparison.

## Env vars (set in Vercel dashboard → Settings → Environment Variables)

- `OPENROUTER_API_KEY` (required) — LLM provider
- `FRUGAL_MODEL` (optional, default `stealth/ox-alpha`) — any OpenRouter model slug
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` (required for production persistence) — from a Vercel KV (Upstash) database attached in Vercel → Storage
- `WISHLIST_TOKEN` (**required for owner access**, at least 32 unpredictable characters) — server-side login and Bearer authentication for private APIs
- `CRON_SECRET` (**required** for `/api/scan-all` and `/api/health/storage`) — configure before deployment
- `TELEGRAM_BOT_TOKEN` (optional), `TELEGRAM_WEBHOOK_SECRET` (**required if Telegram webhook is used**) — webhook now rejects requests if the secret is missing
- `MCP_TOKEN` (optional) — shared secret for `/api/mcp`
- `PARETO_MODEL`, `BUDGET_WEB_MODEL`, `MID_WEB_MODEL`, `JUDGE_MODEL` (optional) — LLM comparison tier overrides

## MCP: Codex and Hermes setup

The deployed endpoint is Streamable HTTP (not SSE): `https://YOUR-DOMAIN.vercel.app/api/mcp`.
Set a long random `MCP_TOKEN` in Vercel for Preview and Production, then configure the same token as the `x-mcp-token` request header in each client. The MCP tools include `submit_wishlist`, `get_wishlist`, `list_wishlists`, `update_wishlist`, `delete_wishlist`, and `trigger_scan`.

Codex configuration (`~/.codex/config.toml`):

```toml
[mcp_servers.frugalfinder]
url = "https://YOUR-DOMAIN.vercel.app/api/mcp"
http_headers = { "x-mcp-token" = "YOUR_MCP_TOKEN" }
```

Hermes configuration (use the equivalent server entry in its MCP settings):

```json
{"mcpServers":{"frugalfinder":{"url":"https://YOUR-DOMAIN.vercel.app/api/mcp","headers":{"x-mcp-token":"YOUR_MCP_TOKEN"}}}}
```

Use `match_preference` as `exact`, `similar`, or `alternatives`; `notes` holds first-class fit, finish, compatibility, and other constraints. Never commit the token—use the client's secret/environment-variable support when available.

## Sharing paths

### Add to Wishlist (bookmarklet)
Create a browser bookmark named **Add to Wishlist** with this URL:
```javascript
javascript:(function(){var u=location.href,t=document.title;window.open('https://frugalfinder.vercel.app/?share='+encodeURIComponent(u)+'&item='+encodeURIComponent(t),'_blank')})()
```
Click it on any product page to open FrugalFinder with the listing prefilled. Sign in on the FrugalFinder domain, then submit the wishlist; cross-origin POST requests are no longer permitted.

### Email (MVP note)
Not yet wired — MVP uses web UI + Telegram + bookmarklet. Email ingest is a natural v2 addition via an inbound-email webhook (e.g. Resend/Postmark → `/api/wishlists`).

## Pricing tiers (recommended)

| Tier | Cadence | Price rationale |
|---|---|---|
| Free | daily | ~30 LLM calls/mo/item at $0 marginal cost on free stealth models ≈ negligible infra |
| Power | hourly | $0.01/scan × ~720 scans/mo = **$7.20/mo per item** — price at **$5/mo flat**, margin comes from batching multiple wishlists into one hourly cron tick |
| Pro (future) | hourly + priority queue + email digests | $12/mo |

The unit economics only work because the analyzer batches all due wishlists into a single cron pass (`/api/scan-all`), amortizing cold-start overhead.

## Owner-only access (security patch)

**Deployment order matters.** In Vercel, set `WISHLIST_TOKEN` to a freshly generated random secret with at least 32 characters in **Production and Preview** before deploying this patch. Preserve the key in your password manager; the application cannot recover it. Never put the key in GitHub or frontend JavaScript. Redeploy after changing environment variables.

- Open the FrugalFinder home page, enter the key once, and receive a signed HttpOnly, Secure, SameSite=Lax session cookie valid for up to seven days; use **Sign out** to clear it.
- Sensitive endpoints (`/api/wishlists`, `/api/renew`, `/api/scan`, `/api/compare`) reject unauthenticated requests. For non-browser scripts use `Authorization: Bearer YOUR_WISHLIST_TOKEN` over HTTPS.
- `/api/health` remains public; `/api/scan-all` remains guarded by `CRON_SECRET`; `/api/telegram` now requires `TELEGRAM_WEBHOOK_SECRET`. Configure these before enabling their integrations.
- Bookmarklets now open FrugalFinder in a new tab, which avoids exposing a secret to other websites.
- This is **single-owner access**. Do not reuse this key for other services. Implement per-user login/authorization if multi-user access is needed later.

**Caution:** The current Vercel route configuration references `api/mcp.js`, which is absent from this repository revision. The MCP endpoint needs a separate follow-up review. No claim is made here that MCP is functional or secured by this patch.

Future: per-user magic-link login (Auth.js or Clerk), then separate wishlists by user ID; Stripe and usage metering if launched as a paid service.

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
- `submit_reservation_watch(campground_ids, date_window?, site_preference?, min_features?, max_price?, cadence?, notes?)` → campground watcher + first scan (lakefront preference supported)
- `list_reservations()` → all reservation watchers with last results
- `trigger_reservation_scan(id)` → re-scan a reservation now
- `run_model_comparison(item, use_case, budget, flexibility?)` → 3-tier LLM race + judge verdict
- `get_model_performance()` → aggregated quality/cost stats per tier

Calling agents should treat it as **submit + poll**: submit once, then call `get_wishlist` on whatever cadence suits them (or wait for their own scheduler). The MCP spec has no push channel for arbitrary updates, so periodic polling is the standard pattern.
