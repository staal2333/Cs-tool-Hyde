import { requireAuth } from '../lib/auth.js';
import { DATA } from '../lib/data.js';
import { effectiveContacts } from '../lib/contacts.js';
import { effectiveState } from '../lib/state.js';
import { loadLogs } from '../lib/log.js';
import { googleConfigured, loadGoogle } from '../lib/google.js';
import { loadThreads, loadHistory, loadLastSync } from '../lib/sync.js';
import { loadImageIndex } from '../lib/placements.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [contacts, state, logs, google, threads, history, lastSync, placementImages] = await Promise.all([
      effectiveContacts(), effectiveState(), loadLogs(), loadGoogle(), loadThreads(), loadHistory(), loadLastSync(), loadImageIndex(),
    ]);
    return res.status(200).json({
      contacts,
      placements: DATA.placements || {},
      placementImages: placementImages || [],
      followupDaysDefault: DATA.followupDaysDefault || 5,
      generated: DATA.generated || null,
      hasAI: Boolean(process.env.ANTHROPIC_API_KEY),
      gmail: {
        configured: googleConfigured(),
        connected: Boolean(google && google.refresh_token),
        lastSync: lastSync || null,
      },
      threads: threads || {},
      history: history || {},
      state,
      logs,
    });
  } catch (err) {
    console.error('data error', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
