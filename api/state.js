import { requireAuth } from '../lib/auth.js';
import { effectiveState, applyPatch, resetAll } from '../lib/state.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ state: await effectiveState() });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.reset === true) {
        await resetAll();
        return res.status(200).json({ ok: true, state: await effectiveState() });
      }
      const { company, patch } = body;
      if (!company || !patch) {
        return res.status(400).json({ error: 'bad_request' });
      }
      const rec = await applyPatch(company, patch);
      return res.status(200).json({ ok: true, company, rec });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error('state error', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
