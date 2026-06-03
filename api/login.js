import { tokenFor, expectedToken, setAuthCookie } from '../lib/auth.js';

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // No password configured → app is open.
  if (!process.env.APP_PASSWORD) {
    setAuthCookie(res);
    return res.status(200).json({ ok: true, open: true });
  }

  const password = (req.body && req.body.password) || '';
  if (tokenFor(password) === expectedToken()) {
    setAuthCookie(res);
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ error: 'wrong_password' });
}
