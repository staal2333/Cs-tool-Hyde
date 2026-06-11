import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../lib/auth.js';
import { addContact, updateContact, deleteContact, restoreContact, effectiveContacts, bulkSetBuyer } from '../lib/contacts.js';
import { loadLogs } from '../lib/log.js';

const CLASSIFY_SYSTEM = `Du er medieindkøbs-ekspert i det danske/nordiske annoncemarked. For hver virksomhed skal du vurdere, hvordan de køber annonceplads (out-of-home/medier), OG give en kort begrundelse:
- "bureau" = køber gennem et MEDIEBUREAU (typisk store internationale annoncører/koncerner: FMCG, bil, tele, store kæder, pharma, finans).
- "selv" = står selv for medieindkøb in-house/direkte (ofte mindre brands, DTC/challenger, startups, lokale, en del B2B).
- "ukendt" = reelt usikkert.

VIGTIGST: Hvis en virksomhed har [DIALOG: ...], så VÆGT dialogen HØJEST — den afslører ofte direkte hvordan de køber (fx "send det til vores bureau / vores mediebureau" → bureau; kontaktpersonen forhandler/beslutter selv → selv). Lad dialogen overtrumfe et navne-gæt.

Begrundelsen: KORT (max ~12 ord, dansk). Referér til dialogen hvis den findes ("Henviser til deres bureau"), ellers virksomhedstypen ("Stor international annoncør"). Vær ærlig — brug "ukendt" hvis du ikke har et velbegrundet bud.

Returnér PRÆCIS én linje pr. virksomhed, intet andet:
<nummer>: <bureau|selv|ukendt> | <kort begrundelse>`;

async function classifyAll() {
  const [contacts, logs] = await Promise.all([effectiveContacts(), loadLogs()]);
  const lines = contacts.map((c, i) => {
    const dlg = (logs[c.company] || [])
      .map((e) => `${e.who === 'kunde' ? 'Kunde' : 'Sebastian'}: ${e.text}`)
      .join(' | ')
      .replace(/\s+/g, ' ')
      .slice(0, 380);
    return `${i + 1}. ${c.company}${dlg ? `  [DIALOG: ${dlg}]` : ''}`;
  }).join('\n');

  const client = new Anthropic();
  const msg = await client.messages.create({
    // Haiku: fast + cheap, plenty for tag+short-reason; keeps us under the function timeout.
    model: process.env.CLASSIFY_MODEL || 'claude-haiku-4-5',
    max_tokens: 10000,
    system: [{ type: 'text', text: CLASSIFY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: lines }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const map = {};
  const counts = { bureau: 0, selv: 0, ukendt: 0 };
  for (const line of text.split(/\n/)) {
    const m = line.match(/^\s*(\d+)\s*[:.)\-]\s*(bureau|selv|ukendt)\s*(?:[|\-–—:]\s*(.*))?$/i);
    if (!m) continue;
    const c = contacts[Number(m[1]) - 1];
    if (!c) continue;
    const v = m[2].toLowerCase();
    map[c.company] = { buyer: v, buyerReason: (m[3] || '').trim().slice(0, 160) };
    counts[v] = (counts[v] || 0) + 1;
  }
  await bulkSetBuyer(map);
  return counts;
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const { action, company, contact, patch } = req.body || {};
    if (action === 'add') await addContact(contact || {});
    else if (action === 'update') await updateContact(company, patch || {});
    else if (action === 'delete') await deleteContact(company, false);
    else if (action === 'restore') await restoreContact(company);
    else if (action === 'classify') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ai_disabled', message: 'ANTHROPIC_API_KEY er ikke sat.' });
      const counts = await classifyAll();
      return res.status(200).json({ ok: true, contacts: await effectiveContacts(), counts });
    } else return res.status(400).json({ error: 'bad_action' });
    return res.status(200).json({ ok: true, contacts: await effectiveContacts() });
  } catch (err) {
    console.error('contacts error', err);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
}
