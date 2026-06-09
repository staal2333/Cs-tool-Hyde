import { requireAuth } from '../../lib/auth.js';
import { clearGoogle } from '../../lib/google.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  await clearGoogle();
  return res.status(200).json({ ok: true });
}
