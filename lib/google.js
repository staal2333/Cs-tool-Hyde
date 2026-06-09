import { redis, hasRedis } from './redis.js';

const GKEY = 'hyde:google';
let mem = null;

export async function loadGoogle() {
  if (!hasRedis) return mem;
  const v = await redis.get(GKEY);
  return v && typeof v === 'object' ? v : null;
}
export async function saveGoogle(obj) {
  if (!hasRedis) { mem = obj; return; }
  await redis.set(GKEY, obj);
}
export async function clearGoogle() {
  if (!hasRedis) { mem = null; return; }
  await redis.del(GKEY);
}

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return (process.env.APP_BASE_URL || `https://${host}`).replace(/\/$/, '');
}

export function authUrl(req, state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: baseUrl(req) + '/api/google/callback',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

export async function exchangeCode(req, code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: baseUrl(req) + '/api/google/callback',
      grant_type: 'authorization_code',
    }),
  });
  if (!r.ok) throw new Error('token_exchange_failed:' + r.status);
  return r.json();
}

export async function getAccessToken() {
  const g = await loadGoogle();
  if (!g || !g.refresh_token) throw new Error('not_connected');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: g.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error('refresh_failed:' + r.status);
  const j = await r.json();
  return j.access_token;
}
