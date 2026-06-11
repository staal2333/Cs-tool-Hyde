import { requireAuth, expectedToken } from '../lib/auth.js';
import { googleConfigured, authUrl, exchangeCode, saveGoogle, loadGoogle, clearGoogle } from '../lib/google.js';

// Single function handling all Google OAuth actions (auth / callback / disconnect).
// vercel.json rewrites map /api/google/<action> -> /api/google?action=<action>,
// so the public paths (incl. the registered redirect URI) are unchanged.
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

  if (q.action === 'auth') {
    if (!googleConfigured()) return res.status(503).json({ error: 'google_not_configured' });
    res.setHeader('Location', authUrl(req, expectedToken().slice(0, 16)));
    res.statusCode = 302;
    return res.end();
  }

  if (q.action === 'callback') {
    if (q.error) { res.statusCode = 302; res.setHeader('Location', '/?gmail=error'); return res.end(); }
    if (!q.code) { res.statusCode = 400; return res.end('missing code'); }
    try {
      const tok = await exchangeCode(req, q.code);
      const prev = (await loadGoogle()) || {};
      await saveGoogle({ refresh_token: tok.refresh_token || prev.refresh_token, connected_at: Date.now() });
      res.statusCode = 302; res.setHeader('Location', '/?gmail=connected'); return res.end();
    } catch (err) {
      console.error('oauth callback', err);
      res.statusCode = 302; res.setHeader('Location', '/?gmail=error'); return res.end();
    }
  }

  if (q.action === 'disconnect') {
    await clearGoogle();
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'bad_action' });
}
