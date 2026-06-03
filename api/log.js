import { requireAuth } from '../lib/auth.js';
import { appendLog } from '../lib/log.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const { company, who, text } = req.body || {};
    if (!company || !text) return res.status(400).json({ error: 'bad_request' });
    const entries = await appendLog(company, who, text);
    return res.status(200).json({ ok: true, company, entries });
  } catch (err) {
    console.error('log error', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
