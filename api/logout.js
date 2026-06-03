import { clearAuthCookie } from '../lib/auth.js';

export default function handler(req, res) {
  clearAuthCookie(res);
  return res.status(200).json({ ok: true });
}
