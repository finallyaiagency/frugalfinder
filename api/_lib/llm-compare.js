// Multi-LLM comparison engine ("quality vs cost control").
// Runs the same frugal-bot analysis through 3 model tiers simultaneously,
// then asks a judge model to rank them. Tracks tokens + cost + quality score
// over time so we can keep the best-value model running searches as LLMs churn.

import { get, put } from './store.js';
import { buildUserPrompt } from './frugal.js';

const SYSTEM_PROMPT = `You are FrugalBot, a value-optimization shopping analyst. Maximize JOY-PER-DOLLAR — not the cheapest, not the fanciest.
Parse needs vs wants, propose 2-3 outside-the-box alternatives (incl. used/refurb), question whether the stated want delivers the joy it promises, recommend ONE target with condition guidance and a realistic good-deal price range and where such deals appear, then list 4-6 deal-hunting search queries.
Respond in EXACTLY this JSON shape, nothing else:
{"needs":["..."],"alternatives":[{"item":"...","why":"...","est_price_range":"$X-$Y"}],"joy_analysis":"...","recommendation":{"target":"...","condition":"new|used|refurb|any","good_deal_range":"$X-$Y","where_to_look":["..."]},"search_queries":["..."],"value_score_guess":1,"notes":"..."}`;

// Tier registry — every slug overridable via env so we can swap models weekly.
export const TIERS = {
  pareto: {
    slug: process.env.PARETO_MODEL || 'openrouter/auto',
    label: 'OpenRouter Auto (Pareto)',
    web_plugin: false,
    usd_per_m: { in: 1.25, out: 5.0 }, // rough blended estimate; auto picks vary
  },
  budget_web: {
    slug: process.env.BUDGET_WEB_MODEL || 'openai/gpt-4.1-nano',
    label: 'Cheapest w/ web',
    web_plugin: true,
    usd_per_m: { in: 0.10, out: 0.40 },
  },
  mid_web: {
    slug: process.env.MID_WEB_MODEL || 'perplexity/sonar',
    label: 'Mid-range w/ web',
    web_plugin: true,
    usd_per_m: { in: 1.0, out: 1.0 },
  },
};

export const JUDGE = {
  slug: process.env.JUDGE_MODEL || 'anthropic/claude-opus-4.1',
  usd_per_m: { in: 15, out: 75 },
};

async function callModel(slug, userPrompt, { webPlugin = false, maxTokens = 2500 } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, error: 'OPENROUTER_API_KEY not set' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    const body = {
      model: slug,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
    };
    if (webPlugin) body.plugins = [{ id: 'web', max_results: 5 }];

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.FRUGAL_REFERER || 'https://frugalfinder.vercel.app',
        'X-Title': 'FrugalFinder',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `${slug} → HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    const d = await res.json();
    const content = d?.choices?.[0]?.message?.content;
    const usage = d?.usage || {};
    const actualModel = d?.model || slug;
    if (!content) return { ok: false, error: `${slug} returned empty content` };
    return { ok: true, content, usage, actualModel };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `${slug} timed out` : `${slug} failed: ${String(e.message || e)}` };
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  // Strip reasoning-model <think>…</think> blocks BEFORE brace-scanning —
  // otherwise the first '{' found is inside the thinking trace, not the answer.
  let t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = t.toLowerCase().indexOf('<think>');
  if (open !== -1) t = t.slice(0, open);
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) throw new Error('no JSON');
  return JSON.parse(t.slice(s, e + 1));
}

function estCost(usage, perM) {
  const pt = usage.prompt_tokens || 0, ct = usage.completion_tokens || 0;
  return +(((pt * perM.in) + (ct * perM.out)) / 1_000_000).toFixed(6);
}

// ---- Comparison run -------------------------------------------------------

const PERF_KEY = 'model-perf';

async function appendPerf(record) {
  const all = (await get(PERF_KEY)) || [];
  all.unshift(record);
  await put(PERF_KEY, all.slice(0, 300));
}

export async function getModelPerf() {
  const recs = (await get(PERF_KEY)) || [];
  const byTier = {};
  for (const r of recs) {
    for (const e of r.entries || []) {
      const k = `${e.tier}:${e.slug}`;
      byTier[k] = byTier[k] || { tier: e.tier, slug: e.slug, runs: 0, score_sum: 0, tokens_sum: 0, cost_sum: 0, wins: 0, worst: 0, errors: 0 };
      byTier[k].runs += 1;
      byTier[k].score_sum += e.score || 0;
      byTier[k].tokens_sum += (e.usage?.prompt_tokens || 0) + (e.usage?.completion_tokens || 0);
      byTier[k].cost_sum += e.cost_est || 0;
      if (r.best_tier === e.tier) byTier[k].wins += 1;
      if (r.worst_tier === e.tier) byTier[k].worst += 1;
      if (e.error) byTier[k].errors += 1;
    }
  }
  const rows = Object.values(byTier).map(r => ({
    tier: r.tier, slug: r.slug, runs: r.runs,
    avg_score: r.runs ? +(r.score_sum / r.runs).toFixed(2) : null,
    avg_tokens_per_run: r.runs ? Math.round(r.tokens_sum / r.runs) : null,
    avg_cost_per_run_usd: r.runs ? +(r.cost_sum / r.runs).toFixed(5) : null,
    wins: r.wins, judged_worst: r.worst, errors: r.errors,
  }));
  return { summary: rows.sort((a, b) => (b.avg_score || 0) - (a.avg_score || 0)), recent: recs.slice(0, 20) };
}

export async function compareModels(wl) {
  const userPrompt = buildUserPrompt(wl);

  // Fire the three tiers simultaneously
  const jobs = Object.entries(TIERS).map(async ([tier, cfg]) => {
    const r = await callModel(cfg.slug, userPrompt, { webPlugin: cfg.web_plugin });
    let parsed = null;
    if (r.ok) {
      try { parsed = extractJson(r.content); } catch { parsed = { joy_analysis: r.content.slice(0, 1200), unstructured: true }; }
    }
    return { tier, cfg, ...r, parsed };
  });
  const results = await Promise.all(jobs);

  const entries = results.map(r => ({
    tier: r.tier,
    label: r.cfg.label,
    slug: r.actualModel || r.cfg.slug,
    requested_slug: r.cfg.slug,
    ok: r.ok,
    error: r.error || null,
    usage: r.usage || {},
    cost_est: r.ok ? estCost(r.usage || {}, r.cfg.usd_per_m) : 0,
    analysis: r.parsed,
    content_len: r.content ? r.content.length : 0,
  }));

  // Judge round — shuffle order to reduce position bias
  const letters = ['A', 'B', 'C'];
  const order = [...entries.keys()].sort(() => Math.random() - 0.5);
  const judgedEntries = order.map((ei, i) => ({ letter: letters[i], entry: entries[ei] }));
  const valid = judgedEntries.filter(j => j.entry.ok);

  let bestTier = null, worstTier = null, judgeOut = null, judgeUsage = {};

  if (valid.length >= 2) {
    const comp = valid.map(j =>
      `### Answer ${j.letter} (${j.entry.label}):\n${JSON.stringify(j.entry.analysis).slice(0, 3500)}`
    ).join('\n\n');
    const judgePrompt = `USER REQUEST:\n${userPrompt}\n\n${comp}\n\nYou are a strict evaluator. Score each answer 1-10 on: correctness of needs parsing, creativity/usefulness of alternatives, realism of price ranges, actionability of recommendation & search queries, and concise clarity. Identify the BEST and WORST.\nRespond ONLY with JSON: {"scores":{"A":n,"B":n,"C":n},"best":"X","worst":"X","reasoning":"<=80 words"}`;
    const jr = await callModel(JUDGE.slug, judgePrompt, { maxTokens: 800 });
    judgeUsage = jr.usage || {};
    if (jr.ok) {
      try {
        const j = extractJson(jr.content);
        judgeOut = j;
        bestTier = valid.find(v => v.letter === j.best)?.entry.tier || null;
        worstTier = valid.find(v => v.letter === j.worst)?.entry.tier || null;
        for (const je of judgedEntries) {
          const sc = j.scores?.[je.letter];
          if (sc != null) entries.find(e => e.tier === je.entry.tier).score = Number(sc);
        }
      } catch {
        judgeOut = { raw: jr.content.slice(0, 600), parse_error: true };
      }
    } else {
      judgeOut = { error: jr.error };
    }
  }

  const record = {
    at: new Date().toISOString(),
    wishlist_id: wl.id,
    item: wl.item,
    entries: entries.map(e => ({ ...e, analysis: undefined })),
    best_tier: bestTier,
    worst_tier: worstTier,
    judge: judgeOut,
    judge_slug: JUDGE.slug,
    judge_cost_est: estCost(judgeUsage, JUDGE.usd_per_m),
  };

  const winningEntry = entries.find(e => e.tier === bestTier) || entries.find(e => e.ok);
  const winnerFull = results.find(r => r.tier === (winningEntry?.tier));
  await appendPerf(record);

  return {
    ok: !!winningEntry,
    entries,
    best_tier: bestTier,
    worst_tier: worstTier,
    judge: judgeOut,
    winning_analysis: winnerFull?.parsed || null,
    winning_model: winningEntry?.slug || null,
    total_cost_est: +(entries.reduce((s, e) => s + (e.cost_est || 0), 0) + record.judge_cost_est).toFixed(5),
    record,
  };
}
