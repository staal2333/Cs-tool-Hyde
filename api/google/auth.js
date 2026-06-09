import { requireAuth, expectedToken } from '../../lib/auth.js';
import { googleConfigured, authUrl } from '../../lib/google.js';

export default function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (!googleConfigured()) {
    return res.status(503).json({ error: 'google_not_configured' });
  }
  const state = expectedToken().slice(0, 16);
  res.setHeader('Location', authUrl(req, state));
  res.statusCode = 302;
  res.end();
}
