import { requireAuth } from '../lib/auth.js';
import { DATA } from '../lib/data.js';
import { effectiveState } from '../lib/state.js';
import { loadLogs } from '../lib/log.js';
import { googleConfigured, loadGoogle } from '../lib/google.js';
import { loadThreads, loadLastSync } from '../lib/sync.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [state, logs, google, threads, lastSync] = await Promise.all([
      effectiveState(), loadLogs(), loadGoogle(), loadThreads(), loadLastSync(),
    ]);
    return res.status(200).json({
      contacts: DATA.contacts,
      placements: DATA.placements || {},
      followupDaysDefault: DATA.followupDaysDefault || 5,
      generated: DATA.generated || null,
      hasAI: Boolean(process.env.ANTHROPIC_API_KEY),
      gmail: {
        configured: googleConfigured(),
        connected: Boolean(google && google.refresh_token),
        lastSync: lastSync || null,
      },
      threads: threads || {},
      state,
      logs,
    });
  } catch (err) {
    console.error('data error', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
