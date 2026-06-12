import { tokenFor, expectedToken, setAuthCookie, clearAuthCookie } from '../lib/auth.js';

// Handles both login and logout (action:'logout') so the app stays within the
// Hobby plan's 12-Serverless-Function limit.
export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = req.body || {};

  // Logout: clear the cookie and return.
  if (body.action === 'logout') {
    clearAuthCookie(res);
    return res.status(200).json({ ok: true, loggedOut: true });
  }

  // No password configured → app is open.
  if (!process.env.APP_PASSWORD) {
    setAuthCookie(res);
    return res.status(200).json({ ok: true, open: true });
  }

  const password = body.password || '';
  if (tokenFor(password) === expectedToken()) {
    setAuthCookie(res);
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ error: 'wrong_password' });
}
