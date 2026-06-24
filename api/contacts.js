import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../lib/auth.js';
import { addContact, updateContact, deleteContact, restoreContact, effectiveContacts, bulkSetBuyer, bulkSetMoney, bulkEnrich } from '../lib/contacts.js';
import { loadLogs } from '../lib/log.js';

const CLASSIFY_SYSTEM = `Du er medieindkøbs-ekspert i det danske/nordiske annoncemarked. For hver virksomhed skal du vurdere, hvordan de køber annonceplads (out-of-home/medier), OG give en kort begrundelse:
- "bureau" = køber gennem et MEDIEBUREAU (typisk store internationale annoncører/koncerner: FMCG, bil, tele, store kæder, pharma, finans).
- "selv" = står selv for medieindkøb in-house/direkte (ofte mindre brands, DTC/challenger, startups, lokale, en del B2B).
- "ukendt" = reelt usikkert.

VIGTIGST: Hvis en virksomhed har [DIALOG: ...], så VÆGT dialogen HØJEST — den afslører ofte direkte hvordan de køber (fx "send det til vores bureau / vores mediebureau" → bureau; kontaktpersonen forhandler/beslutter selv → selv). Lad dialogen overtrumfe et navne-gæt.

Begrundelsen: KORT (max ~12 ord, dansk). Referér til dialogen hvis den findes ("Henviser til deres bureau"), ellers virksomhedstypen ("Stor international annoncør"). Vær ærlig — brug "ukendt" hvis du ikke har et velbegrundet bud.

Returnér PRÆCIS én linje pr. virksomhed, intet andet:
<nummer>: <bureau|selv|ukendt> | <kort begrundelse>`;

function dialogueLine(c, idx, logs) {
  const dlg = (logs[c.company] || [])
    .map((e) => `${e.who === 'kunde' ? 'Kunde' : 'Sebastian'}: ${e.text}`)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .slice(0, 380);
  return `${idx + 1}. ${c.company}${dlg ? `  [DIALOG: ${dlg}]` : ''}`;
}

async function classifyAll() {
  const [contacts, logs] = await Promise.all([effectiveContacts(), loadLogs()]);
  const client = new Anthropic();
  const model = process.env.CLASSIFY_MODEL || 'claude-opus-4-8';

  // Split into chunks and run Opus on each in PARALLEL — keeps quality high
  // while wall-clock stays well under the function timeout.
  const CHUNK = 50;
  const chunks = [];
  for (let i = 0; i < contacts.length; i += CHUNK) chunks.push(contacts.slice(i, i + CHUNK));

  const partials = await Promise.all(chunks.map(async (chunk) => {
    const lines = chunk.map((c, j) => dialogueLine(c, j, logs)).join('\n');
    const msg = await client.messages.create({
      model,
      max_tokens: 4000,
      system: [{ type: 'text', text: CLASSIFY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: lines }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const out = {};
    for (const line of text.split(/\n/)) {
      const m = line.match(/^\s*(\d+)\s*[:.)\-]\s*(bureau|selv|ukendt)\s*(?:[|\-–—:]\s*(.*))?$/i);
      if (!m) continue;
      const c = chunk[Number(m[1]) - 1];
      if (!c) continue;
      out[c.company] = { buyer: m[2].toLowerCase(), buyerReason: (m[3] || '').trim().slice(0, 160) };
    }
    return out;
  }));

  const map = Object.assign({}, ...partials);
  const counts = { bureau: 0, selv: 0, ukendt: 0 };
  for (const v of Object.values(map)) counts[v.buyer] = (counts[v.buyer] || 0) + 1;
  await bulkSetBuyer(map);
  return counts;
}

const SCORE_SYSTEM = `Du er en erfaren out-of-home-sælger i Danmark. For hver virksomhed skal du vurdere, hvor sandsynligt det er, at de har BUDGET til OG passer til facadereklame/outdoor (billboards/wraps i København, på Frederiksberg og i Aarhus) — på en skala 1–5, OG give en kort begrundelse:
- 5 = stærk match: tydeligt budget + outdoor giver god mening (kendte brands, retail/mode/FMCG/ejendom/restaurant-kæder, lokale forretninger med facadebehov).
- 4 = god match: sandsynligt budget og fornuftig fit.
- 3 = mulig: usikkert budget eller middel fit.
- 2 = svag: lille budget eller dårlig fit (ren B2B/niche, online-kun uden lokalt behov).
- 1 = usandsynlig: typisk intet outdoor-budget (meget små, offentlige, B2B-tjenester uden brandbehov).

VIGTIGST: Hvis en virksomhed har [DIALOG: ...], så VÆGT dialogen HØJEST — fx tydelig interesse/budget-snak hæver scoren; "ikke relevant / for dyrt / forkert kanal" sænker den.

Begrundelsen: KORT (max ~12 ord, dansk). Referér til dialogen hvis den findes, ellers virksomhedstypen. Vær ærlig.

Returnér PRÆCIS én linje pr. virksomhed, intet andet:
<nummer>: <1-5> | <kort begrundelse>`;

async function scoreMoneyAll() {
  const [contacts, logs] = await Promise.all([effectiveContacts(), loadLogs()]);
  const client = new Anthropic();
  const model = process.env.SCORE_MODEL || process.env.CLASSIFY_MODEL || 'claude-haiku-4-5';

  const CHUNK = 50;
  const chunks = [];
  for (let i = 0; i < contacts.length; i += CHUNK) chunks.push(contacts.slice(i, i + CHUNK));

  const partials = await Promise.all(chunks.map(async (chunk) => {
    const lines = chunk.map((c, j) => dialogueLine(c, j, logs)).join('\n');
    const msg = await client.messages.create({
      model,
      max_tokens: 4000,
      system: [{ type: 'text', text: SCORE_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: lines }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const out = {};
    for (const line of text.split(/\n/)) {
      const m = line.match(/^\s*(\d+)\s*[:.)\-]\s*([1-5])\s*(?:[|\-–—:]\s*(.*))?$/);
      if (!m) continue;
      const c = chunk[Number(m[1]) - 1];
      if (!c) continue;
      out[c.company] = { moneyScore: Number(m[2]), moneyReason: (m[3] || '').trim().slice(0, 160) };
    }
    return out;
  }));

  const map = Object.assign({}, ...partials);
  await bulkSetMoney(map);
  return Object.keys(map).length;
}

const ENRICH_SYSTEM = `Du beriger kontaktdata for en dansk out-of-home-sælger. For hver virksomhed får du evt. en [DIALOG: ...] (kundens egne mails, ofte med signatur) og kendte felter.

Udtræk KUN FAKTA der faktisk fremgår af dialogen/signaturen — opfind ALDRIG noget. Hvis et felt ikke fremgår, skriv "-".
- name: kontaktpersonens fulde navn (fra signatur/afsender).
- title: jobtitel/rolle (fx "Marketing Manager").
- phone: direkte/mobil telefonnummer.
- email: personens egen e-mail (helst ikke info@/kontakt@).
- guess: ÉT kort GÆT om virksomheden (branche/størrelse/relevans for outdoor), max ~12 ord. Dette er ALTID et gæt, aldrig fakta.

Returnér PRÆCIS én linje pr. virksomhed, intet andet, i dette format:
<nummer> || name: <...> || title: <...> || phone: <...> || email: <...> || guess: <...>`;

function enrichLine(c, idx, logs) {
  const kunde = (logs[c.company] || [])
    .filter((e) => e.who === 'kunde')
    .map((e) => e.text)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .slice(0, 1100);
  const known = [c.person && `navn=${c.person}`, c.title && `titel=${c.title}`, c.email && `email=${c.email}`, c.phone && `tlf=${c.phone}`]
    .filter(Boolean).join(', ');
  return `${idx + 1}. ${c.company}${known ? ` (kendt: ${known})` : ''}${kunde ? `  [DIALOG: ${kunde}]` : ''}`;
}

const val = (s) => { const t = (s || '').trim(); return !t || t === '-' ? '' : t.slice(0, 120); };

async function enrichAll() {
  const [contacts, logs] = await Promise.all([effectiveContacts(), loadLogs()]);
  const client = new Anthropic();
  const model = process.env.CLASSIFY_MODEL || 'claude-opus-4-8';

  const CHUNK = 22;
  const chunks = [];
  for (let i = 0; i < contacts.length; i += CHUNK) chunks.push(contacts.slice(i, i + CHUNK));

  const partials = await Promise.all(chunks.map(async (chunk) => {
    const lines = chunk.map((c, j) => enrichLine(c, j, logs)).join('\n');
    const msg = await client.messages.create({
      model,
      max_tokens: 4000,
      system: [{ type: 'text', text: ENRICH_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: lines }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const out = {};
    for (const line of text.split(/\n/)) {
      const m = line.match(/^\s*(\d+)\s*\|\|\s*(.+)$/);
      if (!m) continue;
      const c = chunk[Number(m[1]) - 1];
      if (!c) continue;
      const f = {};
      for (const part of m[2].split('||')) {
        const kv = part.match(/^\s*(name|title|phone|email|guess)\s*:\s*(.*)$/i);
        if (kv) f[kv[1].toLowerCase()] = val(kv[2]);
      }
      const patch = {};
      // Facts: fill ONLY where the contact has nothing yet (never clobber curated data).
      if (f.name && !c.person) patch.person = f.name;
      if (f.title && !c.title) patch.title = f.title;
      if (f.phone && !c.phone) patch.phone = f.phone;
      if (f.email && !c.email) patch.email = f.email;
      if (f.guess) patch.companyGuess = f.guess; // always refresh the (marked) guess
      if (Object.keys(patch).length) out[c.company] = patch;
    }
    return out;
  }));

  const map = Object.assign({}, ...partials);
  const counts = { contacts: Object.keys(map).length, person: 0, title: 0, phone: 0, email: 0 };
  for (const p of Object.values(map)) {
    if (p.person) counts.person++;
    if (p.title) counts.title++;
    if (p.phone) counts.phone++;
    if (p.email) counts.email++;
  }
  await bulkEnrich(map);
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
    } else if (action === 'scoreMoney') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ai_disabled', message: 'ANTHROPIC_API_KEY er ikke sat.' });
      const scored = await scoreMoneyAll();
      return res.status(200).json({ ok: true, contacts: await effectiveContacts(), scored });
    } else if (action === 'enrich') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ai_disabled', message: 'ANTHROPIC_API_KEY er ikke sat.' });
      const counts = await enrichAll();
      return res.status(200).json({ ok: true, contacts: await effectiveContacts(), counts });
    } else return res.status(400).json({ error: 'bad_action' });
    return res.status(200).json({ ok: true, contacts: await effectiveContacts() });
  } catch (err) {
    console.error('contacts error', err);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
}
