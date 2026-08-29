// FrugalFinder — Frugal-Bot methodology analyzer.
// Calls OpenRouter chat completions. The default is a currently supported
// OpenRouter model; override with FRUGAL_MODEL in the deployment environment.

const DEFAULT_MODEL = process.env.FRUGAL_MODEL || 'z-ai/glm-5.3-flash';

const SYSTEM_PROMPT = `You are FrugalBot, a value-optimization shopping analyst. Your job is NOT to find the cheapest option — it is to maximize JOY-PER-DOLLAR for the requester.

Methodology, applied in order:
1. NEEDS vs WANTS: parse the request into true functional needs (must-haves) vs brand/quality wants (nice-to-haves).
2. ALTERNATIVES (think outside the box): propose 2–3 concrete alternative products/types that would satisfy the same underlying need — including used/refurb options, previous-gen models, or a different category entirely that solves the same problem.
3. JOY vs COST: question whether the stated want actually delivers the joy it promises. If a cheaper item gets 90% of the joy for 40% of the price, say so. If spending MORE buys dramatically more utility/durability/joy, also say so — best value wins, not lowest price.
3a. MATCH MODE: honor the buyer's requested match mode. "exact" means only the named product/spec; "similar" permits close substitutes; "alternatives" actively optimizes for different ways to solve the same need.
4. VERDICT: recommend ONE primary target with: what exactly to buy (brand/model/generation), new-vs-used guidance, a realistic "good deal" price range (street prices, not MSRP), and where such deals typically appear.
5. SEARCH QUERIES: 4–6 specific search strings optimized for finding those deals on marketplaces/classifieds.

Be concrete and opinionated. If the request is vague, make the most reasonable assumption and state it. Keep total response under 350 words.

Respond in EXACTLY this JSON shape, nothing else:
{
  "needs": ["..."],
  "alternatives": [{"item": "...", "why": "...", "est_price_range": "$X–$Y"}],
  "joy_analysis": "...",
  "recommendation": {"target": "...", "condition": "new|used|refurb|any", "good_deal_range": "$X–$Y", "where_to_look": ["..."]},
  "search_queries": ["..."],
  "value_score_guess": 1-10,
  "notes": "one-sentence caveat or pro tip"
}`;

export function buildUserPrompt(wl) {
  const parts = [
    `ITEM REQUESTED: ${wl.item}`,
    `INTENDED USE: ${wl.use_case}`,
    `BUDGET CONSTRAINTS: ${wl.budget}`,
    `FLEXIBILITY (brand/quality/age): ${wl.flexibility || 'unspecified'}`,
    `MATCH MODE: ${wl.match_preference || 'similar'} (exact | similar | alternatives)`,
    `NOTES / NON-NEGOTIABLES: ${wl.notes || 'none'}`,
  ];
  if (wl.source_url) parts.push(`SOURCE PAGE: ${wl.source_url} (the user saw this listing; evaluate whether waiting beats buying now)`);
  parts.push('MONITORING CADENCE: ' + (wl.cadence || 'daily'));
  return parts.join('\n');
}

function extractJson(text) {
  // Strip reasoning-model <think>…</think> blocks BEFORE brace-scanning —
  // otherwise the first '{' found is inside the thinking trace, not the answer.
  let t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Unclosed think tag (truncated generation): drop everything from '<think>' on.
  const open = t.toLowerCase().indexOf('<think>');
  if (open !== -1) t = t.slice(0, open);
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) throw new Error('no JSON');
  return JSON.parse(t.slice(s, e + 1));
}

export function stripThink(text) {
  return String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export async function analyzeWishlist(wl) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return { ok: false, error: 'OPENROUTER_API_KEY not set' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.FRUGAL_REFERER || 'https://frugalfinder.vercel.app',
        'X-Title': 'FrugalFinder',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: wl.image_data_url ? [
            { type: 'text', text: buildUserPrompt(wl) },
            { type: 'image_url', image_url: { url: wl.image_data_url } },
          ] : buildUserPrompt(wl) },
        ],
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `OpenRouter ${res.status}: ${body.slice(0, 300)}` };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: 'Empty model response', raw: data };

    let analysis;
    try {
      analysis = extractJson(content);
    } catch {
      analysis = { needs: [], alternatives: [], joy_analysis: content.slice(0, 1500), recommendation: {}, search_queries: [], notes: '(unstructured response)' };
    }
    return { ok: true, analysis, model_used: data.model || DEFAULT_MODEL };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Model call timed out after 120s' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
