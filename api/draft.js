import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../lib/auth.js';
import { DATA } from '../lib/data.js';
import { contactByCompany } from '../lib/contacts.js';
import { loadTone, loadLogs } from '../lib/log.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

const SCENARIOS = {
  open:     'ÅBNING / første kontakt — kunden har ikke hørt fra os før. Introducér kort, ram deres relevans og giv én konkret grund til at reagere nu.',
  reopen:   'GENÅBNING af dialog — vi har haft kontakt før, men det er gået i stå. Genstart varmt med en ny, konkret anledning (late sale-vinduet). Anerkend kort pausen uden at undskylde.',
  followup: 'OPFØLGNING — vi har sendt en mail uden svar. Kort, venlig påmindelse med en NY vinkel eller en blød deadline. Gentag ikke bare den første mail.',
  nudge:    'NUDGE — let, venligt skub. Tilbyd at holde pladsen et øjeblik og skab en naturlig deadline. Meget kort.',
  after_no: 'EFTER ET NEJ — kunden sagde nej tidligere. Pres IKKE. Vær elegant, tilbyd værdi/relevans og plant den næste mulighed (fx efterår eller næste vindue).',
  close:    'LUK HANDLEN — kunden er varm/klar. Gå efter en konkret beslutning med klar deadline eller et lille incitament. Gør det nemt at sige ja.',
  reply:    'SVAR PÅ KUNDENS BESKED — tag direkte afsæt i hvad de sidst skrev, besvar deres spørgsmål konkret, og før dialogen et skridt videre mod en booking.',
};

function placementBlock(name) {
  const p = DATA.placements[name];
  if (!p) return null;
  const list = parseInt(String(p.list || '').replace(/\D/g, ''));
  const price = parseInt(String(p.price || '').replace(/\D/g, ''));
  const pct = list && price && list > price ? Math.round((1 - price / list) * 100) : null;
  return { name, ...p, pct };
}

const SYSTEM = `Du er en af Danmarks skarpeste B2B-tekstforfattere, specialiseret i kort, personlig salgs-outreach for out-of-home/DOOH facadereklame. Du skriver PÅ VEGNE AF Sebastian fra Hyde Media (storformat-bannere på attraktive adresser i København, på Frederiksberg og i Aarhus).

Dit job: lav 3 DISTINKTE mailudkast til ÉN bestemt kunde, scenarie og placering — så Sebastian kan vælge det bedste.

Skrivestil (vigtigt):
- Lyder som ét menneske der skriver til ét andet — varm, direkte, uformel, troværdig. ALDRIG markedsføringssprog, buzzwords eller "Jeg håber denne mail finder dig vel".
- Kort. En kold mail = 4-7 linjer. Kom hurtigt til pointen.
- Brug placeringens RIGTIGE tal naturligt (m², eksponeringer/uge, late sale-pris vs. normalpris, rabat-%, periode) — men drys dem ind, lir dem ikke op som en liste.
- Én klar, blød call-to-action. Ingen pres, ingen overdrivelse.
- Hvis du får eksempler på Sebastians egne beskeder: ram HANS tone, længde og signatur.
- Match sproget der bedes om (dansk eller engelsk).

De 3 varianter SKAL være reelt forskellige — ikke samme mail med byttede ord. Variér på vinkel, fx:
1) Kort & direkte (kom til sagen på 4 linjer).
2) Værdi/synlighed (gør eksponering + rabat konkret og fristende).
3) Relation/timing eller knaphed (personlig krog, eller "first come, first served").
Vælg de vinkler der passer bedst til scenariet, og navngiv hver vinkel kort.

Svar i PRÆCIS dette format — intet andet, ingen indledning:

###VARIANT###
ANGLE: <kort vinkel-navn, fx "Kort & direkte">
SUBJECT: <emnelinje>
BODY:
<brødtekst med linjeskift, inkl. "Bedste hilsner / Best" + Sebastian>
###END###
###VARIANT###
ANGLE: ...
SUBJECT: ...
BODY:
...
###END###
###VARIANT###
ANGLE: ...
SUBJECT: ...
BODY:
...
###END###`;

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ai_disabled', message: 'ANTHROPIC_API_KEY er ikke sat.' });
  }

  const body = req.body || {};
  const contact = body.company ? await contactByCompany(body.company) : null;
  if (!contact) return res.status(404).json({ error: 'unknown_company' });

  const scenarioKey = SCENARIOS[body.scenario] ? body.scenario : 'open';
  const lang = body.lang === 'en' ? 'en' : 'da';
  const placName = body.placement || contact.placement;
  const pl = placementBlock(placName);

  const [tone, logs] = await Promise.all([loadTone(), loadLogs()]);
  const toneExamples = tone.slice(-6).map((e, i) => `${i + 1}. ${e.text}`).join('\n\n');
  const dialogue = (logs[contact.company] || [])
    .map((e) => `${e.who === 'kunde' ? 'Kunde' : 'Sebastian'}: ${e.text}`)
    .join('\n');

  const userMsg = [
    `Kunde: ${contact.company}${contact.person ? ' (kontakt: ' + contact.person + ')' : ''}`,
    `Temperatur: ${contact.temp === 'varm' ? 'varm (tidligere relation)' : 'kold'}`,
    `Sprog: ${lang === 'en' ? 'ENGELSK' : 'DANSK'}`,
    '',
    `SCENARIE: ${SCENARIOS[scenarioKey]}`,
    '',
    pl
      ? `PLACERING: ${pl.name} (${pl.area}) — ${pl.sqm} m², ${pl.impr} eksponeringer/uge, late sale ${pl.price}${pl.list ? ' mod normalt ' + pl.list : ''}${pl.pct ? ' (~' + pl.pct + '% under listepris)' : ''}, periode ${pl.period}.`
      : `PLACERING: ${placName} (ingen detaljer — hold pris/tal ude).`,
    dialogue && scenarioKey === 'reply' ? `\nHIDTIDIG DIALOG (svar konkret på kundens seneste):\n${dialogue}` : '',
    toneExamples ? `\nSEBASTIANS EGNE BESKEDER (match denne tone):\n${toneExamples}` : '',
    '',
    'Lav de 3 varianter nu.',
  ].filter(Boolean).join('\n');

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2600,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const variants = parseVariants(text);
    if (!variants.length) return res.status(502).json({ error: 'parse_failed', message: 'Kunne ikke tolke svaret.' });
    return res.status(200).json({ ok: true, variants, placement: placName, scenario: scenarioKey });
  } catch (err) {
    console.error('draft error', err?.status, err?.message);
    return res.status(err?.status === 401 ? 401 : 502).json({ error: 'ai_error', message: 'Kunne ikke generere udkast lige nu.' });
  }
}

function parseVariants(text) {
  const parts = String(text).split(/###\s*VARIANT\s*###/i).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const angle = (part.match(/ANGLE:\s*(.+)/i) || [])[1]?.trim() || 'Forslag';
    const subject = (part.match(/SUBJECT:\s*(.+)/i) || [])[1]?.trim() || '';
    const bm = part.match(/BODY:\s*([\s\S]*?)(?:###\s*END\s*###|$)/i);
    const body = (bm ? bm[1] : '').replace(/###\s*END\s*###/gi, '').trim();
    if (subject || body) out.push({ angle, subject, body });
  }
  return out.slice(0, 3);
}
