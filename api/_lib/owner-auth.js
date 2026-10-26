// Single-owner authentication for FrugalFinder. Secrets never reach browser storage.
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'ff_owner';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_AGE_MS = MAX_AGE_SECONDS * 1000;

function configuredSecret() {
  const secret = process.env.WISHLIST_TOKEN || '';
  return secret.length >= 32 ? secret : '';
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signature(secret, expires) {
  return createHmac('sha256', secret).update('frugalfinder-owner-v1:' + expires).digest('base64url');
}

function cookieValue(req) {
  const header = req.headers?.cookie || '';
  const pair = header.split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE_NAME + '='));
  return pair ? pair.slice(COOKIE_NAME.length + 1) : '';
}

export function isOwner(req) {
  const secret = configuredSecret();
  if (!secret) return false; // fail closed until a strong secret is configured
  const authorization = req.headers?.authorization || '';
  if (authorization.startsWith('Bearer ') && constantTimeEqual(authorization.slice(7), secret)) return true;

  const session = cookieValue(req);
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(session);
  if (!match) return false;
  const expires = Number(match[1]);
  if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + MAX_AGE_MS) return false;
  return constantTimeEqual(match[2], signature(secret, match[1]));
}

export function ownerLogin(req, res, token) {
  const secret = configuredSecret();
  if (!secret) {
    res.status(503).json({ error: 'Owner access is not configured: set a random WISHLIST_TOKEN of at least 32 characters in Vercel.' });
    return;
  }
  if (!constantTimeEqual(token, secret)) {
    res.status(401).json({ error: 'Invalid owner access key.' });
    return;
  }
  const expires = String(Date.now() + MAX_AGE_MS);
  const session = expires + '.' + signature(secret, expires);
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + session + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + MAX_AGE_SECONDS);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true });
}

export function ownerLogout(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true });
}
