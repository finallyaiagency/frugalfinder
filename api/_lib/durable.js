// Durable GitHub-backed JSON store — survives serverless instance recycles.
// Uses the frugalfinder-data repo as a key-value document store via the
// GitHub Contents API. Selected when GH_TOKEN + GH_DATA_REPO are set;
// Vercel KV (if attached) still takes precedence; in-memory is last resort.

export function normalizeRepo(value) {
  const raw = String(value || 'finallyaiagency/frugalfinder-data').trim().replace(/\/$/, '');
  const match = raw.match(/github\.com[/:]([^/]+\/[^/#]+)(?:\.git)?$/i);
  return (match ? match[1] : raw).replace(/\.git$/i, '');
}

const REPO = normalizeRepo(process.env.GH_DATA_REPO);
const BRANCH = 'main';
let authHeader = null;

function ghHeaders() {
  if (!authHeader) {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) return null;
    authHeader = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'frugalfinder',
    };
  }
  return authHeader;
}

function keyToPath(key) {
  // ff:wl:index -> data/ff/wl/index.json  (avoid slashes in keys breaking paths)
  return 'data/' + key.replace(/^ff:/, '').replace(/[^a-zA-Z0-9-_]/g, '/') + '.json';
}

async function ghGet(path) {
  const h = ghHeaders();
  if (!h) return { found: false };
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`, { headers: h });
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
  const d = await res.json();
  const content = Buffer.from(d.content, 'base64').toString('utf8');
  return { found: true, sha: d.sha, content };
}

async function ghPut(path, contentStr, sha) {
  const h = ghHeaders();
  const body = {
    message: `store: ${path} @ ${new Date().toISOString()}`,
    content: Buffer.from(contentStr).toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT', headers: h, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return true;
}

export async function durableGet(key) {
  const p = keyToPath(key);
  try {
    const r = await ghGet(p);
    return r.found ? r.content : null;
  } catch { return null; }
}

export async function durableSet(key, valueStr) {
  const p = keyToPath(key);
  let sha;
  try {
    const r = await ghGet(p);
    sha = r.found ? r.sha : undefined;
  } catch {}
  await ghPut(p, valueStr, sha);
}
