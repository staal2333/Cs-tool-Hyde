import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../lib/auth.js';
import { DATA } from '../lib/data.js';
import { effectiveContacts } from '../lib/contacts.js';
import { effectiveState } from '../lib/state.js';
import { loadThreads } from '../lib/sync.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

function parseDate(s) {
  if (!s) return null;
  const p = String(s).split(/[.\-\/]/).map(Number);
  if (p.length < 3) return null;
  return new Date(p[2], p[1] - 1, p[0]);
}
function daysSince(s) { const d = parseDate(s); return d ? Math.floor((Date.now() - d) / 86400000) : null; }

function placementPrice(name) {
  const p = DATA.placements?.[name];
  if (!p) return null;
  const n = parseInt(String(p.price || '').replace(/\D/g, ''));
  return n || null;
}

const SYSTEM = `Du er en skarp, erfaren salgschef for Sebastian, der sælger out-of-home facadereklame (billboards/wraps) for Hyde Media i København og på Frederiksberg.

Hver morgen giver du ham en kort, handlingsorienteret briefing: præcis hvad han skal bruge dagen på — prioriteret efter hvad der tjener flest penge hurtigst.

Prioritér ALTID i denne rækkefølge:
1. Ægte kundesvar der venter på svar (varmest, mest tidskritisk — især høj værdi).
2. Forfaldne opfølgninger på sendte mails uden svar (jo længere tid + jo dyrere placering, jo vigtigere).
3. Oplagte nye muligheder (varme kontakter der ikke er kontaktet endnu).

Nogle kunder er tagget "bureau" (køber via mediebureau) eller "selv" (in-house). Tilpas handlingen: ved "bureau" → vinkl mod det kommercielle/indkøber (pris, rækkevidde, evt. send til deres bureau); ved "selv" → pitch brandet direkte til kunden (synlighed/brand-fit).

Svar KORT og konkret på dansk i præcis dette format (Markdown):

**I dag (kort):** <én sætning der opsummerer dagens fokus>

**Dine 5 vigtigste:**
1. **<Kunde>** — <hvorfor, 1 linje> → <konkret handling, fx "ring i dag" / "send svar om deadline" / "send opfølgning">
2. …
(5 punkter, vigtigst først; nævn kr./placering når det styrker prioriteringen)

**Hurtig gevinst:** <én ting han kan nå på 5 minutter>`;

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ai_disabled', message: 'ANTHROPIC_API_KEY er ikke sat.' });
  }

  try {
    const followupDays = parseInt(req.body?.followupDays) || DATA.followupDaysDefault || 5;
    const [contacts, state, threads] = await Promise.all([effectiveContacts(), effectiveState(), loadThreads()]);
    const rec = (c) => state[c.company] || {};

    const replies = [];
    const due = [];
    const warmNew = [];
    const counts = { total: contacts.length, kontaktet: 0, svar: 0, booket: 0, forfaldne: 0 };

    for (const c of contacts) {
      const r = rec(c);
      const st = r.status || 'Ikke kontaktet';
      if (st !== 'Ikke kontaktet') counts.kontaktet++;
      if (st === 'Booket') counts.booket++;
      const t = threads[c.company];
      const price = placementPrice(c.placement);

      const b = c.buyer && c.buyer !== 'ukendt' ? c.buyer : '';
      if (st === 'Svar modtaget' || (t && !t.auto && st !== 'Booket' && st !== 'Nej tak')) {
        counts.svar++;
        replies.push({ k: c.company, temp: c.temp, plac: c.placement, kr: price, b, dage: daysSince(r.date), svar: (t?.snippet || '').slice(0, 180) });
      } else if ((st === 'Sendt' || st === 'Opfølgning sendt') && (daysSince(r.date) ?? 0) >= followupDays) {
        counts.forfaldne++;
        due.push({ k: c.company, temp: c.temp, plac: c.placement, kr: price, b, status: st, dage: daysSince(r.date) });
      } else if (c.temp === 'varm' && st === 'Ikke kontaktet') {
        warmNew.push({ k: c.company, plac: c.placement, b, segment: c.segment });
      }
    }

    due.sort((a, b) => (b.kr || 0) - (a.kr || 0) || (b.dage || 0) - (a.dage || 0));

    const userMsg = [
      `Pipeline pr. i dag: ${counts.total} kunder, ${counts.kontaktet} kontaktet, ${counts.booket} booket.`,
      '',
      `ÆGTE SVAR DER VENTER (${replies.length}):`,
      replies.length ? replies.map((x) => `- ${x.k} [${x.temp}, ${x.plac || '—'}${x.kr ? ', ' + x.kr.toLocaleString('da-DK') + ' kr.' : ''}${x.b ? ', ' + x.b : ''}] — for ${x.dage ?? '?'} dage siden — "${x.svar}"`).join('\n') : '(ingen)',
      '',
      `FORFALDNE OPFØLGNINGER (${due.length}, sorteret efter værdi — top 25):`,
      due.length ? due.slice(0, 25).map((x) => `- ${x.k} [${x.temp}, ${x.plac || '—'}${x.kr ? ', ' + x.kr.toLocaleString('da-DK') + ' kr.' : ''}${x.b ? ', ' + x.b : ''}] — ${x.status}, ${x.dage} dage siden`).join('\n') : '(ingen)',
      '',
      `VARME, IKKE KONTAKTET (${warmNew.length} — top 20):`,
      warmNew.length ? warmNew.slice(0, 20).map((x) => `- ${x.k} [${x.plac || '—'}, ${x.segment || '—'}${x.b ? ', ' + x.b : ''}]`).join('\n') : '(ingen)',
      '',
      'Giv mig dagens prioriterede plan.',
    ].join('\n');

    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

    return res.status(200).json({ ok: true, text, counts });
  } catch (err) {
    console.error('briefing error', err?.status, err?.message);
    return res.status(err?.status === 401 ? 401 : 502).json({ error: 'ai_error', message: 'Kunne ikke lave briefing lige nu.' });
  }
}
