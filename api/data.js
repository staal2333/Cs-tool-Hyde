import { requireAuth } from '../lib/auth.js';
import { DATA } from '../lib/data.js';
import { effectiveState } from '../lib/state.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const state = await effectiveState();
    return res.status(200).json({
      contacts: DATA.contacts,
      placements: DATA.placements || {},
      followupDaysDefault: DATA.followupDaysDefault || 5,
      generated: DATA.generated || null,
      hasAI: Boolean(process.env.ANTHROPIC_API_KEY),
      state,
    });
  } catch (err) {
    console.error('data error', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
