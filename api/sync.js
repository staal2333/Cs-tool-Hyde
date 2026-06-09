import { requireAuth } from '../lib/auth.js';
import { runSync } from '../lib/sync.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const summary = await runSync();
    return res.status(200).json({ ok: true, summary });
  } catch (err) {
    console.error('sync error', err);
    const code = err.message === 'not_connected' ? 409 : 500;
    return res.status(code).json({ error: 'sync_failed', message: err.message });
  }
}
