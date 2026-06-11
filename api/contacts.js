import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../lib/auth.js';
import { addContact, updateContact, deleteContact, restoreContact, effectiveContacts, bulkSetBuyer } from '../lib/contacts.js';

const CLASSIFY_SYSTEM = `Du er medieindkøbs-ekspert i det danske/nordiske annoncemarked. For hver virksomhed på listen skal du vurdere, hvordan de typisk køber annonceplads (out-of-home/medier):
- "bureau" = køber medier gennem et MEDIEBUREAU (fx store internationale annoncører og koncerner: FMCG, bil, tele, store retailkæder, pharma, finans — de bruger næsten altid bureau).
- "selv" = står selv for medieindkøb in-house/direkte (ofte mindre brands, DTC/challenger, startups, lokale virksomheder, mange B2B).
- "ukendt" = reelt usikkert.

Vær ærlig: brug "ukendt" når du ikke har et velbegrundet bud. Gæt ikke vildt.

Returnér PRÆCIS én linje pr. virksomhed i formatet:
<nummer>: bureau
<nummer>: selv
<nummer>: ukendt
Intet andet — ingen forklaring.`;

async function classifyAll() {
  const contacts = await effectiveContacts();
  const list = contacts.map((c, i) => `${i + 1}. ${c.company}`).join('\n');
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
    max_tokens: 8000,
    system: [{ type: 'text', text: CLASSIFY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: list }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const map = {};
  const counts = { bureau: 0, selv: 0, ukendt: 0 };
  for (const line of text.split(/\n/)) {
    const m = line.match(/^\s*(\d+)\s*[:.)\-]\s*(bureau|selv|ukendt)/i);
    if (!m) continue;
    const c = contacts[Number(m[1]) - 1];
    if (!c) continue;
    const v = m[2].toLowerCase();
    map[c.company] = v;
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
