import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'hyde_auth';

// Deterministic token derived from the password — so we never store the
// password itself in the cookie, and the cookie survives restarts.
export function tokenFor(password) {
  return createHmac('sha256', 'hyde-outreach-v2').update(String(password)).digest('hex');
}

export function expectedToken() {
  const pw = process.env.APP_PASSWORD || '';
  return tokenFor(pw);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthed(req) {
  // If no password is configured, the app is open (useful for local dev).
  if (!process.env.APP_PASSWORD) return true;
  const token = parseCookies(req)[COOKIE];
  return token ? safeEqual(token, expectedToken()) : false;
}

export function setAuthCookie(res) {
  const value = expectedToken();
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
  );
}

export function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

// Guard for API routes. Returns true if the request may proceed.
export function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}
