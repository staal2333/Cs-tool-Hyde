import { requireAuth } from '../../lib/auth.js';
import { exchangeCode, saveGoogle, loadGoogle } from '../../lib/google.js';

function getQuery(req) {
  if (req.query) return req.query;
  try {
    const u = new URL(req.url, 'http://localhost');
    return Object.fromEntries(u.searchParams.entries());
  } catch { return {}; }
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const q = getQuery(req);
  if (q.error) { res.statusCode = 302; res.setHeader('Location', '/?gmail=error'); return res.end(); }
  if (!q.code) { res.statusCode = 400; return res.end('missing code'); }
  try {
    const tok = await exchangeCode(req, q.code);
    const prev = (await loadGoogle()) || {};
    // Google only returns refresh_token on first consent; keep the old one if absent.
    const refresh_token = tok.refresh_token || prev.refresh_token;
    await saveGoogle({ refresh_token, connected_at: Date.now() });
    res.statusCode = 302;
    res.setHeader('Location', '/?gmail=connected');
    res.end();
  } catch (err) {
    console.error('oauth callback', err);
    res.statusCode = 302;
    res.setHeader('Location', '/?gmail=error');
    res.end();
  }
}
